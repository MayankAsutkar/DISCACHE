#ifndef DISCACHE_COORDINATOR_SERVER_H
#define DISCACHE_COORDINATOR_SERVER_H

#include "BinaryProtocol.h"
#include "ConsistentHashRing.h"
#include "ThreadPool.h"
#include <array>
#include <atomic>
#include <cstdint>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace discache {

class CoordinatorServer {
public:
    explicit CoordinatorServer(uint16_t port = 8000, std::size_t worker_threads = 16);
    ~CoordinatorServer();

    void add_data_node(uint16_t node_id, const std::string& host, uint16_t port, const std::string& wal_file);
    void run();
    void shutdown();

private:
    BinaryResponse handle_request(const BinaryRequest& req);
    BinaryResponse forward_to_node(const PhysicalNode& node, const BinaryRequest& req);
    int acquire_node_socket(const PhysicalNode& node);
    void release_node_socket(uint16_t node_id, int fd);
    std::string build_ring_inspect_payload() const;

    uint16_t port_;
    int listen_fd_ = -1;
    std::atomic<bool> running_{false};

    ConsistentHashRing ring_;
    ThreadPool thread_pool_;

    std::mutex clients_mutex_;
    std::set<int> idle_clients_;

    // Pooled backend TCP connections to Data Nodes 1..3
    mutable std::mutex pool_mutex_;
    std::map<uint16_t, std::vector<int>> node_socket_pool_;

    // Routing metrics
    std::atomic<uint64_t> total_routed_{0};
    std::array<std::atomic<uint64_t>, 4> node_routed_counts_{0, 0, 0, 0};
};

} // namespace discache

#endif // DISCACHE_COORDINATOR_SERVER_H
