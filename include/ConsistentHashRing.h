#ifndef DISCACHE_CONSISTENT_HASH_RING_H
#define DISCACHE_CONSISTENT_HASH_RING_H

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace discache {

struct PhysicalNode {
    uint16_t node_id;      // 1, 2, or 3
    std::string name;      // "Data Node 1", etc.
    std::string host;      // "127.0.0.1"
    uint16_t port;         // 8001, 8002, 8003
    std::string wal_file;  // "node_1.log", etc.
};

struct VirtualNode {
    uint32_t hash_pos;     // Position on [0, 2^32 - 1]
    uint16_t node_id;      // Physical Data Node ID (1..3)
    uint16_t vnode_index;  // 0..99
    std::string label;     // e.g. "Node-1#VN-0"
    uint16_t port;         // 8001..8003
};

struct RouteResult {
    std::string key;
    uint32_t key_hash;
    VirtualNode successor_vnode;
    PhysicalNode physical_node;
    bool wrapped_around;
};

class ConsistentHashRing {
public:
    static constexpr std::size_t VFA_COUNT_PER_NODE = 100;

    explicit ConsistentHashRing(std::size_t vnodes_per_node = VFA_COUNT_PER_NODE);

    void add_physical_node(const PhysicalNode& node);
    RouteResult route(const std::string& key) const;

    const std::map<uint32_t, VirtualNode>& ring() const { return ring_; }
    const std::map<uint16_t, PhysicalNode>& physical_nodes() const { return nodes_; }
    std::size_t vnodes_per_node() const { return vnodes_per_node_; }

private:
    std::size_t vnodes_per_node_;
    std::map<uint16_t, PhysicalNode> nodes_;
    std::map<uint32_t, VirtualNode> ring_;
};

} // namespace discache

#endif // DISCACHE_CONSISTENT_HASH_RING_H
