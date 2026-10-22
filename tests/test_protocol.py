import pathlib
import socket
import struct
import sys
import threading
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import load_tester


class BinaryProtocolTests(unittest.TestCase):
    def exchange_with_frame(self, response_frame):
        client, server = socket.socketpair()

        def send_response():
            try:
                header = load_tester.recv_exact(server, 10)
                _, _, key_len, value_len = struct.unpack("!BBII", header)
                load_tester.recv_exact(server, key_len + value_len)
                server.sendall(response_frame)
            finally:
                server.close()

        thread = threading.Thread(target=send_response)
        thread.start()
        try:
            result = load_tester.send_and_recv(client, load_tester.OP_PUT, "a", "b")
        finally:
            client.close()
            thread.join()
        return result

    def test_operation_codes_and_request_byte_order(self):
        self.assertEqual(load_tester.OP_GET, 0x01)
        self.assertEqual(load_tester.OP_PUT, 0x02)
        self.assertEqual(load_tester.OP_DELETE, 0x03)
        self.assertEqual(
            load_tester.encode_request(load_tester.OP_PUT, "a", "b"),
            bytes((0xDC, 0x02, 0, 0, 0, 1, 0, 0, 0, 1, ord("a"), ord("b"))),
        )

    def test_request_lengths_count_utf8_bytes(self):
        frame = load_tester.encode_request(load_tester.OP_GET, "é", "🌱")
        self.assertEqual(frame[:10], struct.pack("!BBII", 0xDC, 0x01, 2, 4))
        self.assertEqual(frame[10:], "é🌱".encode("utf-8"))

    def test_response_fields_and_payload_are_decoded(self):
        header = struct.pack("!BBHIII", 0xDC, 0x01, 3, 0x01020304, 0xA0B0C0D0, 1)
        status, node_id, key_hash, vnode_hash, payload = self.exchange_with_frame(header + b"x")
        self.assertEqual((status, node_id, key_hash, vnode_hash, payload), (1, 3, 0x01020304, 0xA0B0C0D0, b"x"))

    def test_invalid_response_magic_is_rejected(self):
        header = struct.pack("!BBHIII", 0x00, 0x00, 1, 0, 0, 0)
        with self.assertRaisesRegex(ValueError, "Invalid protocol magic"):
            self.exchange_with_frame(header)

    def test_truncated_response_header_is_rejected(self):
        with self.assertRaises(ConnectionError):
            self.exchange_with_frame(b"\xDC\x00")

    def test_failed_attempt_is_included_in_benchmark_series(self):
        report = load_tester.run_benchmark(
            host="127.0.0.1",
            port=-1,
            total_requests=1,
            workers=1,
            get_pct=100,
            put_pct=0,
            delete_pct=0,
        )
        self.assertEqual(report["metrics"]["failed_ops"], 1)
        self.assertTrue(any(point["ops_per_sec"] > 0 for point in report["series"]))


if __name__ == "__main__":
    unittest.main()
