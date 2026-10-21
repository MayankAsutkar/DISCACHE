#include "../include/ConsistentHashRing.h"
#include "../include/MurmurHash3.h"
#include <stdexcept>

namespace discache {

ConsistentHashRing::ConsistentHashRing(std::size_t vnodes_per_node)
    : vnodes_per_node_(vnodes_per_node) {}

void ConsistentHashRing::add_physical_node(const PhysicalNode& node) {
    nodes_[node.node_id] = node;
    for (std::size_t v = 0; v < vnodes_per_node_; ++v) {
        std::string label = "Node-" + std::to_string(node.node_id) + "#VN-" + std::to_string(v);
        uint32_t h = hash_key(label);
        ring_[h] = VirtualNode{
            .hash_pos = h,
            .node_id = node.node_id,
            .vnode_index = static_cast<uint16_t>(v),
            .label = label,
            .port = node.port
        };
    }
}

RouteResult ConsistentHashRing::route(const std::string& key) const {
    if (ring_.empty()) {
        throw std::runtime_error("ConsistentHashRing is empty");
    }

    uint32_t k_hash = hash_key(key);

    // std::map::lower_bound finds the first virtual node with hash_pos >= k_hash
    auto it = ring_.lower_bound(k_hash);
    bool wrapped = false;
    if (it == ring_.end()) {
        // Wrap around clockwise past 2^32 - 1 to the first virtual node on the ring
        it = ring_.begin();
        wrapped = true;
    }

    const VirtualNode& vnode = it->second;
    const PhysicalNode& pnode = nodes_.at(vnode.node_id);

    return RouteResult{
        .key = key,
        .key_hash = k_hash,
        .successor_vnode = vnode,
        .physical_node = pnode,
        .wrapped_around = wrapped
    };
}

} // namespace discache
