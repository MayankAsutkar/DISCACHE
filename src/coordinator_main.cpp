#include "../include/CoordinatorServer.h"
#include <csignal>
#include <cstdlib>
#include <iostream>
#include <string>

static discache::CoordinatorServer* g_coordinator = nullptr;

static void signal_handler(int) {
    if (g_coordinator) {
        g_coordinator->shutdown();
    }
    std::exit(0);
}

int main(int argc, char* argv[]) {
    uint16_t port = 8000;
    if (argc >= 2) {
        port = static_cast<uint16_t>(std::stoi(argv[1]));
    }

    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    discache::CoordinatorServer coordinator(port, 16);
    g_coordinator = &coordinator;

    // Register the 3 independent Data Nodes with 100 virtual nodes each
    coordinator.add_data_node(1, "127.0.0.1", 8001, "node_1.log");
    coordinator.add_data_node(2, "127.0.0.1", 8002, "node_2.log");
    coordinator.add_data_node(3, "127.0.0.1", 8003, "node_3.log");

    coordinator.run();
    return 0;
}
