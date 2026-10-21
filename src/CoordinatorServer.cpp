#include "../include/CoordinatorServer.h"
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

namespace discache {

CoordinatorServer::CoordinatorServer(uint16_t port, std::size_t worker_threads)
    : port_(port),
      ring_(ConsistentHashRing::VFA_COUNT_PER_NODE),
      thread_pool_(worker_threads, 4096) {}

CoordinatorServer::~CoordinatorServer() {
    shutdown();
}

void CoordinatorServer::add_data_node(uint16_t node_id,
                                      const std::string& host,
                                      uint16_t port,
                                      const std::string& wal_file) {
    ring_.add_physical_node(PhysicalNode{
        .node_id = node_id,
        .name = "Data Node " + std::to_string(node_id),
        .host = host,
        .port = port,
        .wal_file = wal_file
    });
}

void CoordinatorServer::shutdown() {
    running_ = false;
    if (listen_fd_ != -1) {
        ::close(listen_fd_);
        listen_fd_ = -1;
    }

    std::vector<int> client_fds;
    {
        std::lock_guard<std::mutex> lock(clients_mutex_);
        client_fds.assign(idle_clients_.begin(), idle_clients_.end());
        idle_clients_.clear();
    }
    for (int fd : client_fds) {
        ::close(fd);
    }

    {
        std::lock_guard<std::mutex> lock(pool_mutex_);
        for (auto& kv : node_socket_pool_) {
            for (int fd : kv.second) {
                ::close(fd);
            }
        }
        node_socket_pool_.clear();
    }

    thread_pool_.shutdown();
}

int CoordinatorServer::acquire_node_socket(const PhysicalNode& node) {
    {
        std::lock_guard<std::mutex> lock(pool_mutex_);
        auto& vec = node_socket_pool_[node.node_id];
        if (!vec.empty()) {
            int fd = vec.back();
            vec.pop_back();
            return fd;
        }
    }

    int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        return -1;
    }
    int flag = 1;
    ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(node.port);
    ::inet_pton(AF_INET, node.host.c_str(), &addr.sin_addr);

    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        ::close(fd);
        return -1;
    }
    return fd;
}

void CoordinatorServer::release_node_socket(uint16_t node_id, int fd) {
    if (fd < 0) return;
    std::lock_guard<std::mutex> lock(pool_mutex_);
    auto& vec = node_socket_pool_[node_id];
    if (vec.size() < 64) {
        vec.push_back(fd);
    } else {
        ::close(fd);
    }
}

BinaryResponse CoordinatorServer::forward_to_node(const PhysicalNode& node, const BinaryRequest& req) {
    auto encoded = encode_request(req);

    // Attempt with pooled socket first; if stale, retry once with a fresh TCP connection
    for (int attempt = 0; attempt < 2; ++attempt) {
        int fd = acquire_node_socket(node);
        if (fd < 0) {
            continue;
        }

        if (!write_exact(fd, encoded.data(), encoded.size())) {
            ::close(fd);
            continue;
        }

        BinaryResponse res;
        if (!recv_response(fd, res)) {
            ::close(fd);
            continue;
        }

        release_node_socket(node.node_id, fd);
        return res;
    }

    BinaryResponse err;
    err.status = StatusCode::ERROR;
    err.node_id = node.node_id;
    err.payload = "NODE_UNREACHABLE:" + std::to_string(node.port);
    return err;
}

std::string CoordinatorServer::build_ring_inspect_payload() const {
    std::ostringstream oss;
    oss << "COORDINATOR_PORT\t" << port_ << "\n";
    oss << "TOTAL_VNODES\t" << ring_.ring().size() << "\n";
    oss << "VNODES_PER_NODE\t" << ring_.vnodes_per_node() << "\n";
    oss << "TOTAL_ROUTED\t" << total_routed_.load() << "\n";
    oss << "NODE_1_ROUTED\t" << node_routed_counts_[1].load() << "\n";
    oss << "NODE_2_ROUTED\t" << node_routed_counts_[2].load() << "\n";
    oss << "NODE_3_ROUTED\t" << node_routed_counts_[3].load() << "\n";

    for (const auto& [hash_pos, vnode] : ring_.ring()) {
        oss << "VNODE\t" << hash_pos << "\t" << vnode.node_id << "\t"
            << vnode.vnode_index << "\t" << vnode.port << "\t" << vnode.label << "\n";
    }
    return oss.str();
}

BinaryResponse CoordinatorServer::handle_request(const BinaryRequest& req) {
    if (req.opcode == OpCode::PING) {
        BinaryResponse res;
        res.status = StatusCode::OK;
        res.node_id = 0;
        res.payload = "PONG_COORDINATOR";
        return res;
    }

    if (req.opcode == OpCode::INSPECT) {
        BinaryResponse res;
        res.status = StatusCode::OK;
        res.node_id = 0;
        if (req.key.rfind("ROUTE:", 0) == 0) {
            std::string target_key = req.key.substr(6);
            RouteResult r = ring_.route(target_key);
            res.node_id = r.physical_node.node_id;
            res.key_hash = r.key_hash;
            res.vnode_hash = r.successor_vnode.hash_pos;
            std::ostringstream oss;
            oss << "KEY\t" << r.key << "\n"
                << "KEY_HASH\t" << r.key_hash << "\n"
                << "VNODE_HASH\t" << r.successor_vnode.hash_pos << "\n"
                << "VNODE_LABEL\t" << r.successor_vnode.label << "\n"
                << "VNODE_INDEX\t" << r.successor_vnode.vnode_index << "\n"
                << "NODE_ID\t" << r.physical_node.node_id << "\n"
                << "NODE_PORT\t" << r.physical_node.port << "\n"
                << "WRAPPED\t" << (r.wrapped_around ? 1 : 0) << "\n";
            res.payload = oss.str();
        } else {
            res.payload = build_ring_inspect_payload();
        }
        return res;
    }

    // Standard distributed operations: GET, PUT, DELETE
    RouteResult route = ring_.route(req.key);
    ++total_routed_;
    if (route.physical_node.node_id >= 1 && route.physical_node.node_id <= 3) {
        ++node_routed_counts_[route.physical_node.node_id];
    }

    BinaryResponse res = forward_to_node(route.physical_node, req);
    res.node_id = route.physical_node.node_id;
    res.key_hash = route.key_hash;
    res.vnode_hash = route.successor_vnode.hash_pos;
    return res;
}

void CoordinatorServer::run() {
    listen_fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd_ < 0) {
        std::cerr << "[Coordinator] Failed to create socket\n";
        return;
    }

    int opt = 1;
    ::setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port_);

    if (::bind(listen_fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        std::cerr << "[Coordinator] Failed to bind port " << port_ << "\n";
        ::close(listen_fd_);
        listen_fd_ = -1;
        return;
    }

    if (::listen(listen_fd_, 128) < 0) {
        std::cerr << "[Coordinator] Failed to listen on port " << port_ << "\n";
        ::close(listen_fd_);
        listen_fd_ = -1;
        return;
    }

    running_ = true;
    std::cout << "[Coordinator] Listening on 127.0.0.1:" << port_
              << " | Ring initialized with " << ring_.physical_nodes().size()
              << " Data Nodes (" << ring_.ring().size() << " virtual positions)\n";

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
        tv.tv_usec = 5000;

        int ready = ::select(max_fd + 1, &read_fds, nullptr, nullptr, &tv);
        if (ready < 0) {
            if (errno == EINTR) continue;
            if (!running_) break;
            continue;
        }
        if (ready == 0) {
            continue;
        }

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

        for (int cfd : snapshot_clients) {
            if (!FD_ISSET(cfd, &read_fds)) continue;

            {
                std::lock_guard<std::mutex> lock(clients_mutex_);
                if (idle_clients_.erase(cfd) == 0) {
                    continue;
                }
            }

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
