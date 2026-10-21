#ifndef DISCACHE_DATA_NODE_SERVER_H
#define DISCACHE_DATA_NODE_SERVER_H

#include "BinaryProtocol.h"
#include "LRUCache.h"
#include "ThreadPool.h"
#include "WAL.h"
#include <atomic>
#include <cstdint>
#include <mutex>
#include <set>
#include <string>

namespace discache {

class DataNodeServer {
public:
    DataNodeServer(uint16_t node_id,
                   uint16_t port,
                   const std::string& wal_filepath,
                   std::size_t cache_capacity = LRUCache::DEFAULT_CAPACITY,
                   std::size_t worker_threads = 8);
    ~DataNodeServer();

    void run();
    void shutdown();

private:
    BinaryResponse handle_request(const BinaryRequest& req);
    std::string build_inspect_payload() const;

    uint16_t node_id_;
    uint16_t port_;
    int listen_fd_ = -1;
    std::atomic<bool> running_{false};

    LRUCache cache_;
    WAL wal_;
    ThreadPool thread_pool_;

    std::mutex clients_mutex_;
    std::set<int> idle_clients_;
    std::atomic<uint64_t> total_requests_{0};
};

} // namespace discache

#endif // DISCACHE_DATA_NODE_SERVER_H
