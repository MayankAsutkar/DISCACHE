#include "BinaryProtocol.h"

#include <array>
#include <cassert>
#include <cstdint>
#include <sys/socket.h>
#include <unistd.h>
#include <vector>

using namespace discache;

static void send_frame(int fd, const std::vector<uint8_t>& frame) {
    std::size_t sent = 0;
    while (sent < frame.size()) {
        const ssize_t count = ::send(fd, frame.data() + sent, frame.size() - sent, 0);
        assert(count > 0);
        sent += static_cast<std::size_t>(count);
    }
}

static bool receive_request(const std::vector<uint8_t>& frame, BinaryRequest& request) {
    std::array<int, 2> sockets{};
    assert(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets.data()) == 0);
    send_frame(sockets[0], frame);
    ::shutdown(sockets[0], SHUT_WR);
    const bool ok = recv_request(sockets[1], request);
    ::close(sockets[0]);
    ::close(sockets[1]);
    return ok;
}

static bool receive_response(const std::vector<uint8_t>& frame, BinaryResponse& response) {
    std::array<int, 2> sockets{};
    assert(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets.data()) == 0);
    send_frame(sockets[0], frame);
    ::shutdown(sockets[0], SHUT_WR);
    const bool ok = recv_response(sockets[1], response);
    ::close(sockets[0]);
    ::close(sockets[1]);
    return ok;
}

int main() {
    static_assert(static_cast<uint8_t>(OpCode::GET) == 0x01);
    static_assert(static_cast<uint8_t>(OpCode::PUT) == 0x02);
    static_assert(static_cast<uint8_t>(OpCode::DELETE) == 0x03);
    static_assert(static_cast<uint8_t>(StatusCode::OK) == 0x00);
    static_assert(static_cast<uint8_t>(StatusCode::NOT_FOUND) == 0x01);
    static_assert(static_cast<uint8_t>(StatusCode::ERROR) == 0x02);

    const BinaryRequest put{OpCode::PUT, "a", "b"};
    const std::vector<uint8_t> expected_request{
        0xDC, 0x02, 0, 0, 0, 1, 0, 0, 0, 1, 'a', 'b'
    };
    assert(encode_request(put) == expected_request);

    BinaryRequest decoded_request;
    assert(receive_request(expected_request, decoded_request));
    assert(decoded_request.opcode == OpCode::PUT);
    assert(decoded_request.key == "a");
    assert(decoded_request.value == "b");

    const BinaryResponse not_found{
        StatusCode::NOT_FOUND, 3, 0x01020304, 0xA0B0C0D0, "x"
    };
    const std::vector<uint8_t> expected_response{
        0xDC, 0x01, 0, 3, 1, 2, 3, 4, 0xA0, 0xB0, 0xC0, 0xD0,
        0, 0, 0, 1, 'x'
    };
    assert(encode_response(not_found) == expected_response);

    BinaryResponse decoded_response;
    assert(receive_response(expected_response, decoded_response));
    assert(decoded_response.status == StatusCode::NOT_FOUND);
    assert(decoded_response.node_id == 3);
    assert(decoded_response.key_hash == 0x01020304);
    assert(decoded_response.vnode_hash == 0xA0B0C0D0);
    assert(decoded_response.payload == "x");

    auto bad_magic_request = expected_request;
    bad_magic_request[0] = 0;
    assert(!receive_request(bad_magic_request, decoded_request));

    const uint32_t oversized_key_len = htonl(10 * 1024 * 1024 + 1);
    std::vector<uint8_t> oversized_request(10, 0);
    oversized_request[0] = PROTOCOL_MAGIC;
    std::memcpy(oversized_request.data() + 2, &oversized_key_len, sizeof(oversized_key_len));
    assert(!receive_request(oversized_request, decoded_request));

    const uint32_t oversized_payload_len = htonl(20 * 1024 * 1024 + 1);
    std::vector<uint8_t> oversized_response(16, 0);
    oversized_response[0] = PROTOCOL_MAGIC;
    std::memcpy(oversized_response.data() + 12, &oversized_payload_len, sizeof(oversized_payload_len));
    assert(!receive_response(oversized_response, decoded_response));

    return 0;
}
