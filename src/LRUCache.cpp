#include "../include/LRUCache.h"
#include <algorithm>
#include <mutex>

namespace discache {

LRUCache::LRUCache(std::size_t capacity)
    : capacity_(capacity > 0 ? capacity : 1) {
    map_.reserve(std::min<std::size_t>(capacity_, 1024));
}

LRUCache::~LRUCache() {
    std::unique_lock<std::shared_mutex> lock(rw_mutex_);
    clear_unlocked();
}

void LRUCache::attach_front(Node* node) {
    node->prev = nullptr;
    node->next = head_;
    if (head_ != nullptr) {
        head_->prev = node;
    }
    head_ = node;
    if (tail_ == nullptr) {
        tail_ = node;
    }
}

void LRUCache::detach(Node* node) {
    if (node->prev != nullptr) {
        node->prev->next = node->next;
    } else {
        head_ = node->next;
    }

    if (node->next != nullptr) {
        node->next->prev = node->prev;
    } else {
        tail_ = node->prev;
    }

    node->prev = nullptr;
    node->next = nullptr;
}

void LRUCache::move_to_head(Node* node) {
    if (node == head_) {
        return;
    }
    detach(node);
    attach_front(node);
}

LRUCache::Node* LRUCache::pop_tail() {
    if (tail_ == nullptr) {
        return nullptr;
    }
    Node* lru = tail_;
    detach(lru);
    return lru;
}

void LRUCache::clear_unlocked() {
    Node* curr = head_;
    while (curr != nullptr) {
        Node* next = curr->next;
        delete curr;
        curr = next;
    }
    head_ = nullptr;
    tail_ = nullptr;
    map_.clear();
}

std::optional<std::string> LRUCache::get(const std::string& key) {
    // Fast reader check under shared_lock when key is missing,
    // or upgrade to unique_lock to promote entry to MRU head.
    {
        std::shared_lock<std::shared_mutex> rlock(rw_mutex_);
        if (map_.find(key) == map_.end()) {
            // Need atomic or exclusive increment, upgrade below
        }
    }

    std::unique_lock<std::shared_mutex> wlock(rw_mutex_);
    auto it = map_.find(key);
    if (it == map_.end()) {
        ++misses_;
        return std::nullopt;
    }

    Node* node = it->second;
    move_to_head(node);
    ++hits_;
    return node->value;
}

PutOutcome LRUCache::put(const std::string& key, const std::string& value) {
    std::unique_lock<std::shared_mutex> wlock(rw_mutex_);
    PutOutcome outcome{false, false, "", ""};

    auto it = map_.find(key);
    if (it != map_.end()) {
        Node* node = it->second;
        node->value = value;
        move_to_head(node);
        outcome.updated_existing = true;
        return outcome;
    }

    if (map_.size() >= capacity_) {
        Node* evicted_node = pop_tail();
        if (evicted_node != nullptr) {
            outcome.evicted = true;
            outcome.evicted_key = evicted_node->key;
            outcome.evicted_value = evicted_node->value;
            map_.erase(evicted_node->key);
            delete evicted_node;
            ++evictions_;
        }
    }

    Node* new_node = new Node{key, value, nullptr, nullptr};
    attach_front(new_node);
    map_[key] = new_node;
    return outcome;
}

bool LRUCache::del(const std::string& key) {
    std::unique_lock<std::shared_mutex> wlock(rw_mutex_);
    auto it = map_.find(key);
    if (it == map_.end()) {
        return false;
    }

    Node* node = it->second;
    detach(node);
    map_.erase(it);
    delete node;
    return true;
}

std::optional<std::string> LRUCache::peek(const std::string& key) const {
    std::shared_lock<std::shared_mutex> rlock(rw_mutex_);
    auto it = map_.find(key);
    if (it == map_.end()) {
        return std::nullopt;
    }
    return it->second->value;
}

CacheSnapshot LRUCache::snapshot(std::size_t max_entries) const {
    std::shared_lock<std::shared_mutex> rlock(rw_mutex_);
    CacheSnapshot snap;
    snap.size = map_.size();
    snap.capacity = capacity_;
    snap.mru_key = (head_ != nullptr) ? head_->key : "";
    snap.lru_key = (tail_ != nullptr) ? tail_->key : "";
    snap.hits = hits_;
    snap.misses = misses_;
    snap.evictions = evictions_;

    Node* curr = head_;
    std::size_t count = 0;
    while (curr != nullptr && count < max_entries) {
        snap.entries_mru_to_lru.push_back(CacheEntryView{curr->key, curr->value});
        curr = curr->next;
        ++count;
    }
    return snap;
}

void LRUCache::clear() {
    std::unique_lock<std::shared_mutex> wlock(rw_mutex_);
    clear_unlocked();
}

void LRUCache::set_capacity(std::size_t new_capacity) {
    if (new_capacity == 0) new_capacity = 1;
    std::unique_lock<std::shared_mutex> wlock(rw_mutex_);
    capacity_ = new_capacity;
    while (map_.size() > capacity_) {
        Node* evicted_node = pop_tail();
        if (evicted_node != nullptr) {
            map_.erase(evicted_node->key);
            delete evicted_node;
            ++evictions_;
        }
    }
}

std::size_t LRUCache::size() const {
    std::shared_lock<std::shared_mutex> rlock(rw_mutex_);
    return map_.size();
}

std::size_t LRUCache::capacity() const {
    std::shared_lock<std::shared_mutex> rlock(rw_mutex_);
    return capacity_;
}

} // namespace discache
