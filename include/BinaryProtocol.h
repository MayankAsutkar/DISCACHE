#ifndef DISCACHE_BINARY_PROTOCOL_H
#define DISCACHE_BINARY_PROTOCOL_H

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <arpa/inet.h>
#include <unistd.h>
#include <sys/socket.h>

namespace discache {

constexpr uint8_t PROTOCOL_MAGIC = 0xDC;

enum class OpCode : uint8_t {
    GET     = 0x01,
    PUT     = 0x02,
    DELETE  = 0x03,
    INSPECT = 0x04,
    RECOVER = 0x05,
    CONFIG  = 0x06,
    PING    = 0x07
};

enum class StatusCode : uint8_t {
    OK        = 0x00,
    NOT_FOUND = 0x01,
    ERROR     = 0x02
};

// Request Frame (10-byte header + key + value):
// [0]     uint8_t  magic (0xDC)
// [1]     uint8_t  opcode
// [2..5]  uint32_t key_len (network byte order)
// [6..9]  uint32_t val_len (network byte order)
// [10..]  key bytes + value bytes
struct BinaryRequest {
    OpCode opcode = OpCode::GET;
    std::string key;
    std::string value;
};

// Response Frame (16-byte header + payload):
// [0]      uint8_t  magic (0xDC)
// [1]      uint8_t  status
// [2..3]   uint16_t node_id (network byte order)
// [4..7]   uint32_t key_hash (network byte order)
// [8..11]  uint32_t vnode_hash (network byte order)
// [12..15] uint32_t payload_len (network byte order)
// [16..]   payload bytes
struct BinaryResponse {
    StatusCode status = StatusCode::OK;
    uint16_t node_id = 0;
    uint32_t key_hash = 0;
    uint32_t vnode_hash = 0;
    std::string payload;
};

inline std::vector<uint8_t> encode_request(const BinaryRequest& req) {
    uint32_t klen = static_cast<uint32_t>(req.key.size());
    uint32_t vlen = static_cast<uint32_t>(req.value.size());
    uint32_t net_klen = htonl(klen);
    uint32_t net_vlen = htonl(vlen);

    std::vector<uint8_t> buf(10 + klen + vlen);
    buf[0] = PROTOCOL_MAGIC;
    buf[1] = static_cast<uint8_t>(req.opcode);
    std::memcpy(&buf[2], &net_klen, 4);
    std::memcpy(&buf[6], &net_vlen, 4);
    if (klen > 0) {
        std::memcpy(&buf[10], req.key.data(), klen);
    }
    if (vlen > 0) {
        std::memcpy(&buf[10 + klen], req.value.data(), vlen);
    }
    return buf;
}

inline std::vector<uint8_t> encode_response(const BinaryResponse& res) {
    uint32_t plen = static_cast<uint32_t>(res.payload.size());
    uint16_t net_node = htons(res.node_id);
    uint32_t net_khash = htonl(res.key_hash);
    uint32_t net_vhash = htonl(res.vnode_hash);
    uint32_t net_plen = htonl(plen);

    std::vector<uint8_t> buf(16 + plen);
    buf[0] = PROTOCOL_MAGIC;
    buf[1] = static_cast<uint8_t>(res.status);
    std::memcpy(&buf[2], &net_node, 2);
    std::memcpy(&buf[4], &net_khash, 4);
    std::memcpy(&buf[8], &net_vhash, 4);
    std::memcpy(&buf[12], &net_plen, 4);
    if (plen > 0) {
        std::memcpy(&buf[16], res.payload.data(), plen);
    }
    return buf;
}

inline bool read_exact(int fd, uint8_t* buffer, std::size_t n) {
    std::size_t total = 0;
    while (total < n) {
        ssize_t r = ::recv(fd, buffer + total, n - total, 0);
        if (r <= 0) {
            return false;
        }
        total += static_cast<std::size_t>(r);
    }
    return true;
}

inline bool write_exact(int fd, const uint8_t* buffer, std::size_t n) {
    std::size_t total = 0;
    while (total < n) {
        ssize_t w = ::send(fd, buffer + total, n - total, MSG_NOSIGNAL);
        if (w <= 0) {
            return false;
        }
        total += static_cast<std::size_t>(w);
    }
    return true;
}

inline bool recv_request(int fd, BinaryRequest& out) {
    uint8_t header[10];
    if (!read_exact(fd, header, 10)) {
        return false;
    }
    if (header[0] != PROTOCOL_MAGIC) {
        return false;
    }
    out.opcode = static_cast<OpCode>(header[1]);

    uint32_t net_klen = 0, net_vlen = 0;
    std::memcpy(&net_klen, &header[2], 4);
    std::memcpy(&net_vlen, &header[6], 4);
    uint32_t klen = ntohl(net_klen);
    uint32_t vlen = ntohl(net_vlen);

    if (klen > 10 * 1024 * 1024 || vlen > 10 * 1024 * 1024) {
        return false;
    }

    out.key.resize(klen);
    if (klen > 0 && !read_exact(fd, reinterpret_cast<uint8_t*>(out.key.data()), klen)) {
        return false;
    }

    out.value.resize(vlen);
    if (vlen > 0 && !read_exact(fd, reinterpret_cast<uint8_t*>(out.value.data()), vlen)) {
        return false;
    }
    return true;
}

inline bool recv_response(int fd, BinaryResponse& out) {
    uint8_t header[16];
    if (!read_exact(fd, header, 16)) {
        return false;
    }
    if (header[0] != PROTOCOL_MAGIC) {
        return false;
    }
    out.status = static_cast<StatusCode>(header[1]);

    uint16_t net_node = 0;
    uint32_t net_khash = 0, net_vhash = 0, net_plen = 0;
    std::memcpy(&net_node, &header[2], 2);
    std::memcpy(&net_khash, &header[4], 4);
    std::memcpy(&net_vhash, &header[8], 4);
    std::memcpy(&net_plen, &header[12], 4);

    out.node_id = ntohs(net_node);
    out.key_hash = ntohl(net_khash);
    out.vnode_hash = ntohl(net_vhash);
    uint32_t plen = ntohl(net_plen);

    if (plen > 20 * 1024 * 1024) {
        return false;
    }

    out.payload.resize(plen);
    if (plen > 0 && !read_exact(fd, reinterpret_cast<uint8_t*>(out.payload.data()), plen)) {
        return false;
    }
    return true;
}

} // namespace discache

#endif // DISCACHE_BINARY_PROTOCOL_H
