#ifndef DISCACHE_MURMURHASH3_H
#define DISCACHE_MURMURHASH3_H

#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>

namespace discache {

// Deterministic 32-bit MurmurHash3 (x86_32) implementation.
// Used by the Coordinator's Consistent Hash Ring to map keys and virtual node labels
// onto the 32-bit unsigned integer hash ring [0, 2^32 - 1].
uint32_t murmurhash3_x86_32(const void* key, std::size_t len, uint32_t seed = 0x00000000);

inline uint32_t hash_key(std::string_view key, uint32_t seed = 0x00000000) {
    return murmurhash3_x86_32(key.data(), key.size(), seed);
}

} // namespace discache

#endif // DISCACHE_MURMURHASH3_H
