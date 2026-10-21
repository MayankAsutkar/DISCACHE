#ifndef DISCACHE_THREAD_POOL_H
#define DISCACHE_THREAD_POOL_H

#include <condition_variable>
#include <cstddef>
#include <functional>
#include <mutex>
#include <queue>
#include <thread>
#include <vector>

namespace discache {

// Bounded Thread Pool for processing socket request work items concurrently.
// Separates the select() I/O multiplexing stage from worker-thread cache execution.
class ThreadPool {
public:
    explicit ThreadPool(std::size_t num_workers = 8, std::size_t max_queue_size = 1024)
        : max_queue_size_(max_queue_size), stop_(false) {
        workers_.reserve(num_workers);
        for (std::size_t i = 0; i < num_workers; ++i) {
            workers_.emplace_back([this]() { this->worker_loop(); });
        }
    }

    ~ThreadPool() {
        shutdown();
    }

    ThreadPool(const ThreadPool&) = delete;
    ThreadPool& operator=(const ThreadPool&) = delete;

    bool enqueue(std::function<void()> task) {
        std::unique_lock<std::mutex> lock(queue_mutex_);
        not_full_cv_.wait(lock, [this]() {
            return stop_ || tasks_.size() < max_queue_size_;
        });
        if (stop_) {
            return false;
        }
        tasks_.push(std::move(task));
        not_empty_cv_.notify_one();
        return true;
    }

    void shutdown() {
        {
            std::unique_lock<std::mutex> lock(queue_mutex_);
            if (stop_) return;
            stop_ = true;
        }
        not_empty_cv_.notify_all();
        not_full_cv_.notify_all();
        for (auto& w : workers_) {
            if (w.joinable()) {
                w.join();
            }
        }
    }

    std::size_t worker_count() const { return workers_.size(); }
    std::size_t max_queue_size() const { return max_queue_size_; }

private:
    void worker_loop() {
        while (true) {
            std::function<void()> task;
            {
                std::unique_lock<std::mutex> lock(queue_mutex_);
                not_empty_cv_.wait(lock, [this]() {
                    return stop_ || !tasks_.empty();
                });
                if (stop_ && tasks_.empty()) {
                    return;
                }
                task = std::move(tasks_.front());
                tasks_.pop();
                not_full_cv_.notify_one();
            }
            task();
        }
    }

    std::size_t max_queue_size_;
    std::vector<std::thread> workers_;
    std::queue<std::function<void()>> tasks_;
    std::mutex queue_mutex_;
    std::condition_variable not_empty_cv_;
    std::condition_variable not_full_cv_;
    bool stop_;
};

} // namespace discache

#endif // DISCACHE_THREAD_POOL_H
