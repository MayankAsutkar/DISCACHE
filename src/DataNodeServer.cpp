#include "../include/DataNodeServer.h"
#include "../include/MurmurHash3.h"
#include <algorithm>
#include <arpa/inet.h>
#include <cerrno>
#include <cstring>
#include <iostream>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sstream>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
#include <vector>

namespace discache {

DataNodeServer::DataNodeServer(uint16_t node_id,
                               uint16_t port,
                               const std::string& wal_filepath,
                               std::size_t cache_capacity,
                               std::size_t worker_threads)
    : node_id_(node_id),
      port_(port),
      cache_(cache_capacity),
      wal_(wal_filepath),
      thread_pool_(worker_threads, 2048) {
    // Sequential WAL replay at node startup
    std::size_t replayed = wal_.replay(cache_);
    std::cout << "[Data Node " << node_id_ << " :" << port_ << "] Startup WAL replay complete ("
              << replayed << " records from " << wal_filepath << ")\n";
}

DataNodeServer::~DataNodeServer() {
    shutdown();
}

void DataNodeServer::shutdown() {
    running_ = false;
    if (listen_fd_ != -1) {
        ::close(listen_fd_);
        listen_fd_ = -1;
    }
    std::vector<int> fds;
    {
        std::lock_guard<std::mutex> lock(clients_mutex_);
        fds.assign(idle_clients_.begin(), idle_clients_.end());
        idle_clients_.clear();
    }
    for (int fd : fds) {
        ::close(fd);
    }
    thread_pool_.shutdown();
}

static std::string escape_field(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else if (c == '\\') out += "\\\\";
        else out += c;
    }
    return out;
}

std::string DataNodeServer::build_inspect_payload() const {
    CacheSnapshot snap = cache_.snapshot(100);
    auto wal_records = wal_.read_records(100);

    std::ostringstream oss;
    oss << "NODE_ID\t" << node_id_ << "\n";
    oss << "PORT\t" << port_ << "\n";
    oss << "WAL_FILE\t" << wal_.filepath() << "\n";
    oss << "SIZE\t" << snap.size << "\n";
    oss << "CAPACITY\t" << snap.capacity << "\n";
    oss << "MRU_KEY\t" << escape_field(snap.mru_key) << "\n";
    oss << "LRU_KEY\t" << escape_field(snap.lru_key) << "\n";
    oss << "HITS\t" << snap.hits << "\n";
    oss << "MISSES\t" << snap.misses << "\n";
    oss << "EVICTIONS\t" << snap.evictions << "\n";
    oss << "TOTAL_REQS\t" << total_requests_.load() << "\n";
    oss << "WAL_SEQ\t" << wal_.sequence_number() << "\n";

    for (const auto& entry : snap.entries_mru_to_lru) {
        oss << "ENTRY\t" << escape_field(entry.key) << "\t" << escape_field(entry.value) << "\n";
    }
    for (const auto& rec : wal_records) {
        oss << "WAL\t" << rec.seq << "\t" << rec.timestamp_ms << "\t" << rec.op
            << "\t" << escape_field(rec.key) << "\t" << escape_field(rec.value) << "\n";
    }
    return oss.str();
}

BinaryResponse DataNodeServer::handle_request(const BinaryRequest& req) {
    ++total_requests_;
    BinaryResponse res;
    res.node_id = node_id_;
    res.key_hash = req.key.empty() ? 0 : hash_key(req.key);
    res.vnode_hash = 0;

    switch (req.opcode) {
        case OpCode::GET: {
            auto val = cache_.get(req.key);
            if (val.has_value()) {
                res.status = StatusCode::OK;
                res.payload = *val;
            } else {
                res.status = StatusCode::NOT_FOUND;
                res.payload = "";
            }
            break;
        }
        case OpCode::PUT: {
            // 1. Append WAL Record + 2. Flush Durable Record BEFORE updating in-memory cache
            if (!wal_.append_put(req.key, req.value)) {
                res.status = StatusCode::ERROR;
                res.payload = "WAL_WRITE_FAILED";
                break;
            }
            // 3. Update In-Memory LRU Cache
            PutOutcome outcome = cache_.put(req.key, req.value);
            // 4. Return Success
            res.status = StatusCode::OK;
            if (outcome.evicted) {
                res.payload = "EVICTED:" + outcome.evicted_key;
            } else if (outcome.updated_existing) {
                res.payload = "UPDATED";
            } else {
                res.payload = "INSERTED";
            }
            break;
        }
        case OpCode::DELETE: {
            // 1. Append WAL Record + 2. Flush Durable Record
            if (!wal_.append_delete(req.key)) {
                res.status = StatusCode::ERROR;
                res.payload = "WAL_WRITE_FAILED";
                break;
            }
            // 3. Update In-Memory LRU Cache
            bool removed = cache_.del(req.key);
            // 4. Return status
            res.status = removed ? StatusCode::OK : StatusCode::NOT_FOUND;
            res.payload = removed ? "DELETED" : "NOT_FOUND";
            break;
        }
        case OpCode::INSPECT: {
            res.status = StatusCode::OK;
            res.payload = build_inspect_payload();
            break;
        }
        case OpCode::RECOVER: {
            if (req.key == "CLEAR_MEMORY") {
                cache_.clear();
                res.status = StatusCode::OK;
                res.payload = "MEMORY_CLEARED";
            } else {
                std::size_t count = wal_.replay(cache_);
                res.status = StatusCode::OK;
                res.payload = "REPLAYED:" + std::to_string(count);
            }
            break;
        }
        case OpCode::CONFIG: {
            if (req.key == "CAPACITY") {
                std::size_t cap = std::stoull(req.value);
                cache_.set_capacity(cap);
                res.status = StatusCode::OK;
                res.payload = "CAPACITY:" + std::to_string(cache_.capacity());
            } else if (req.key == "RESET") {
                cache_.clear();
                wal_.truncate();
                res.status = StatusCode::OK;
                res.payload = "RESET_OK";
            } else {
                res.status = StatusCode::ERROR;
                res.payload = "UNKNOWN_CONFIG";
            }
            break;
        }
        case OpCode::PING: {
            res.status = StatusCode::OK;
            res.payload = "PONG";
            break;
        }
        default: {
            res.status = StatusCode::ERROR;
            res.payload = "UNSUPPORTED_OPCODE";
            break;
        }
    }
    return res;
}

void DataNodeServer::run() {
    listen_fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd_ < 0) {
        std::cerr << "[Data Node " << node_id_ << "] Failed to create socket\n";
        return;
    }

    int opt = 1;
    ::setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port_);

    if (::bind(listen_fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        std::cerr << "[Data Node " << node_id_ << "] Failed to bind port " << port_ << "\n";
        ::close(listen_fd_);
        listen_fd_ = -1;
        return;
    }

    if (::listen(listen_fd_, 128) < 0) {
        std::cerr << "[Data Node " << node_id_ << "] Failed to listen on port " << port_ << "\n";
        ::close(listen_fd_);
        listen_fd_ = -1;
        return;
    }

    running_ = true;
    std::cout << "[Data Node " << node_id_ << "] Listening on 127.0.0.1:" << port_
              << " (select() I/O multiplexing + " << thread_pool_.worker_count()
              << " worker threads, WAL: " << wal_.filepath() << ")\n";

    while (running_) {
        fd_set read_fds;
        FD_ZERO(&read_fds);
        FD_SET(listen_fd_, &read_fds);
        int max_fd = listen_fd_;

        std::vector<int> snapshot_clients;
        {
            std::lock_guard<std::mutex> lock(clients_mutex_);
            for (int cfd : idle_clients_) {
                if (cfd >= 0 && cfd < FD_SETSIZE) {
                    FD_SET(cfd, &read_fds);
                    if (cfd > max_fd) max_fd = cfd;
                    snapshot_clients.push_back(cfd);
                }
            }
        }

        timeval tv{};
        tv.tv_sec = 0;
        tv.tv_usec = 5000; // 5ms poll interval so returned sockets rejoin select() promptly

        int ready = ::select(max_fd + 1, &read_fds, nullptr, nullptr, &tv);
        if (ready < 0) {
            if (errno == EINTR) continue;
            if (!running_) break;
            continue;
        }
        if (ready == 0) {
            continue;
        }

        // 1. Accept incoming TCP connections
        if (FD_ISSET(listen_fd_, &read_fds)) {
            sockaddr_in client_addr{};
            socklen_t client_len = sizeof(client_addr);
            int client_fd = ::accept(listen_fd_, reinterpret_cast<sockaddr*>(&client_addr), &client_len);
            if (client_fd >= 0) {
                int flag = 1;
                ::setsockopt(client_fd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));
                std::lock_guard<std::mutex> lock(clients_mutex_);
                idle_clients_.insert(client_fd);
            }
        }

        // 2. Multiplex readable client sockets and dispatch to Bounded Thread Pool
        for (int cfd : snapshot_clients) {
            if (!FD_ISSET(cfd, &read_fds)) continue;

            {
                std::lock_guard<std::mutex> lock(clients_mutex_);
                if (idle_clients_.erase(cfd) == 0) {
                    continue; // Already leased to a worker
                }
            }

            // Enqueue socket work item to the bounded thread pool
            thread_pool_.enqueue([this, cfd]() {
                BinaryRequest req;
                if (!recv_request(cfd, req)) {
                    ::close(cfd);
                    return;
                }

                BinaryResponse res = this->handle_request(req);
                auto encoded = encode_response(res);
                if (!write_exact(cfd, encoded.data(), encoded.size())) {
                    ::close(cfd);
                    return;
                }

                if (running_) {
                    std::lock_guard<std::mutex> lock(clients_mutex_);
                    idle_clients_.insert(cfd);
                } else {
                    ::close(cfd);
                }
            });
        }
    }
}

} // namespace discache
