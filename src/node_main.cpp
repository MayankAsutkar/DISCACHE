#include "../include/DataNodeServer.h"
#include <csignal>
#include <cstdlib>
#include <iostream>
#include <string>

static discache::DataNodeServer* g_node = nullptr;

static void signal_handler(int) {
    if (g_node) {
        g_node->shutdown();
    }
    std::exit(0);
}

int main(int argc, char* argv[]) {
    uint16_t node_id = 1;
    uint16_t port = 8001;
    std::string wal_file = "node_1.log";
    std::size_t capacity = discache::LRUCache::DEFAULT_CAPACITY;

    if (argc >= 2) {
        node_id = static_cast<uint16_t>(std::stoi(argv[1]));
        port = static_cast<uint16_t>(8000 + node_id);
        wal_file = "node_" + std::to_string(node_id) + ".log";
    }
    if (argc >= 3) {
        port = static_cast<uint16_t>(std::stoi(argv[2]));
    }
    if (argc >= 4) {
        wal_file = argv[3];
    }
    if (argc >= 5) {
        capacity = static_cast<std::size_t>(std::stoull(argv[4]));
    }

    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    discache::DataNodeServer node(node_id, port, wal_file, capacity, 8);
    g_node = &node;
    node.run();
    return 0;
}
