CXX = g++
CXXFLAGS = -std=c++20 -Wall -Wextra -pthread -O2 -Iinclude

BUILD_DIR = build

COMMON_SRCS = src/MurmurHash3.cpp src/ConsistentHashRing.cpp src/LRUCache.cpp src/WAL.cpp
COMMON_OBJS = $(patsubst src/%.cpp, $(BUILD_DIR)/%.o, $(COMMON_SRCS))

COORD_TARGET = discache_coordinator
NODE_TARGET = discache_node

all: $(COORD_TARGET) $(NODE_TARGET)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(BUILD_DIR)/%.o: src/%.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(COORD_TARGET): $(COMMON_OBJS) $(BUILD_DIR)/CoordinatorServer.o $(BUILD_DIR)/coordinator_main.o
	$(CXX) $(CXXFLAGS) $^ -o $@

$(NODE_TARGET): $(COMMON_OBJS) $(BUILD_DIR)/DataNodeServer.o $(BUILD_DIR)/node_main.o
	$(CXX) $(CXXFLAGS) $^ -o $@

clean:
	rm -rf $(BUILD_DIR) $(COORD_TARGET) $(NODE_TARGET)

rebuild: clean all

cluster: all
	./$(NODE_TARGET) 1 8001 node_1.log &
	./$(NODE_TARGET) 2 8002 node_2.log &
	./$(NODE_TARGET) 3 8003 node_3.log &
	sleep 0.3
	./$(COORD_TARGET) 8000
