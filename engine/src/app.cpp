#include "app.h"

#include "catalog.h"
#include "log.h"
#include "server.h"

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <exception>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <system_error>
#include <thread>

#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>
#else
#include <fcntl.h>
#include <spawn.h>
#include <sys/wait.h>

extern char** environ;
#endif

namespace ils {

namespace {

std::atomic<bool> g_quit{false};

#ifdef _WIN32
// Ctrl-C, Ctrl-Break and closing the console window. A second one gets the
// default handling, which ends the process, if shutting down hangs.
BOOL WINAPI on_console_event(DWORD) {
    if (g_quit.exchange(true)) return FALSE;
    return TRUE;
}
#else
void on_signal(int) { g_quit = true; }
#endif

bool is_loopback(const std::string& host) {
    return host == "localhost" || host == "::1" || host.rfind("127.", 0) == 0;
}

#ifdef _WIN32
// Opens the URL with the default browser. Never fails the app.
void open_browser(const std::string& url) {
    const std::wstring wurl(url.begin(), url.end());  // the URL is ASCII
    const auto rc = reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", wurl.c_str(), nullptr, nullptr, SW_SHOWNORMAL));
    if (rc <= 32) std::fprintf(stderr, "note: could not open a browser; open the URL by hand\n");
}
#else
// Opens the URL with the desktop's opener (open on macOS, xdg-open
// elsewhere), without a shell. Never fails the app.
void open_browser(const std::string& url) {
#ifdef __APPLE__
    const char* opener = "open";
#else
    const char* opener = "xdg-open";
#endif
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0);
    posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0);
    pid_t pid = 0;
    char* argv[] = {const_cast<char*>(opener), const_cast<char*>(url.c_str()), nullptr};
    const int rc = posix_spawnp(&pid, opener, &actions, nullptr, argv, environ);
    posix_spawn_file_actions_destroy(&actions);
    if (rc != 0) {
        std::fprintf(stderr, "note: could not open a browser (%s not found); open the URL by hand\n", opener);
        return;
    }
    std::thread([pid] { waitpid(pid, nullptr, 0); }).detach();  // reap it
}
#endif

}  // namespace

bool parse_app_option(int argc, char** argv, int& i, AppOptions& out) {
    const std::string arg = argv[i];
    auto value = [&]() -> std::string {
        if (i + 1 >= argc) throw std::runtime_error(arg + " needs a value");
        std::string v = argv[++i];
        if (v.empty()) throw std::runtime_error(arg + " needs a non-empty value");
        return v;
    };
    if (arg == "--host") {
        out.host = value();
    } else if (arg == "--port") {
        const std::string v = value();
        size_t used = 0;
        int port = -1;
        try {
            port = std::stoi(v, &used);
        } catch (const std::exception&) {
            used = 0;
        }
        if (used != v.size() || port < 0 || port > 65535) {
            throw std::runtime_error("--port must be a number between 0 and 65535");
        }
        out.port = port;
    } else if (arg == "--allow-origin") {
        out.allow_origins.push_back(value());
    } else if (arg == "--no-browser") {
        out.no_browser = true;
    } else if (arg == "--verify-seek") {
        out.verify_seek = true;
    } else if (arg == "--models-dir") {
        out.models_dir = value();
    } else {
        return false;
    }
    return true;
}

const char* app_options_help() {
    return "  --host ADDR           listen address (default 127.0.0.1)\n"
           "  --port N              port (default 8642; 0 picks a free one)\n"
           "  --allow-origin URL    extra origin accepted on the WebSocket (repeatable)\n"
           "  --no-browser          do not open the browser at startup\n"
           "  --verify-seek         check every exact re-evaluation of a node against its first EVAL\n"
           "  --models-dir DIR      folder of the models the browser can load, download and delete\n"
           "                        (default: models, in the current directory)\n";
}

int run_app(const AppOptions& options, AppModels models, WebAssets web) {
#ifdef _WIN32
    SetConsoleCtrlHandler(on_console_event, TRUE);
#else
    // A handler, not a blocked mask: threads that exist already (the model's)
    // would otherwise take the signal with its default action. A second
    // signal kills the process if shutting down hangs.
    struct sigaction sa {};
    sa.sa_handler = on_signal;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = SA_RESETHAND;
    sigaction(SIGINT, &sa, nullptr);
    sigaction(SIGTERM, &sa, nullptr);
#endif

    try {
        Log log;
        Catalog catalog(options.models_dir, models.n_ctx);
        Hub* hub_ptr = nullptr;  // set below; the server uses it only after start()
        Server server(log, web,
                      {[&](const std::string& text) { hub_ptr->command(text); },
                       [&] { return hub_ptr->status(); },
                       [&] { return hub_ptr->connect_events(); }});
        Hub hub(log, catalog, std::move(models.backend),
                {[&](const std::string& ev) { server.push_event(ev); }, [&] { server.notify_status(); }},
                SessionOptions{options.verify_seek});
        hub_ptr = &hub;

        std::error_code ec;
        const std::filesystem::path dir = std::filesystem::absolute(catalog.dir(), ec);
        std::printf("inside-llm: models folder: %s\n", (ec ? catalog.dir() : dir).string().c_str());
        std::fflush(stdout);

        if (!models.a.empty()) {
            try {
                hub.load_paths(models.a, models.b);
            } catch (const std::exception& e) {
                std::fprintf(stderr, "error: %s\n", e.what());
                return 1;
            }
        }

        ServerOptions so;
        so.host = options.host;
        so.port = options.port;
        so.allow_origins = options.allow_origins;
        if (!server.start(so)) {
            std::fprintf(stderr, "error: cannot listen on %s:%d (address in use or not available)\n",
                         options.host.c_str(), options.port);
            return 1;
        }

        if (!is_loopback(options.host)) {
            std::fprintf(stderr,
                         "warning: listening on %s, not only on this machine. There is no authentication: "
                         "anyone who can reach this address can drive the engine, and download into and "
                         "delete from the models folder.\n",
                         options.host.c_str());
        }
        const bool any = options.host == "0.0.0.0" || options.host == "::" || is_loopback(options.host);
        const std::string url =
            "http://" + (any ? std::string("localhost") : options.host) + ":" + std::to_string(server.port()) + "/";
        std::printf("inside-llm ready: %s\n", url.c_str());
        std::fflush(stdout);
        if (!options.no_browser) open_browser(url);

        while (!g_quit) std::this_thread::sleep_for(std::chrono::milliseconds(100));

        std::printf("stopping\n");
        std::fflush(stdout);
        server.stop();  // WebSocket connections first, then the server
        if (options.verify_seek) {
            const SeekStats st = hub.seek_stats();
            std::fprintf(stderr, "verify-seek: %llu placements checked, %llu mismatches\n",
                         static_cast<unsigned long long>(st.verified), static_cast<unsigned long long>(st.mismatches));
        }
        return 0;  // the hub stops its threads and the session and frees the models on the way out
    } catch (const std::exception& e) {
        std::fprintf(stderr, "error: %s\n", e.what());
        return 1;
    }
}

}  // namespace ils
