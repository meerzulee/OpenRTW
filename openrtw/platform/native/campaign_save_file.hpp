#pragma once

#if !defined(__linux__)
#error "NativeCampaignSaveSlot requires the Linux/POSIX file adapter"
#endif

#include <array>
#include <atomic>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <limits>
#include <span>
#include <stdexcept>
#include <string>
#include <system_error>
#include <type_traits>
#include <vector>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace openrtw {

class NativeCampaignSaveError : public std::runtime_error {
public:
    explicit NativeCampaignSaveError(const std::string& message, bool completionUncertain = false)
        : std::runtime_error(message), completionUncertain_(completionUncertain) {}
    bool completion_uncertain() const noexcept { return completionUncertain_; }

private:
    bool completionUncertain_;
};

static_assert(std::is_nothrow_copy_constructible_v<NativeCampaignSaveError>);

namespace native_save_detail {

inline constexpr std::size_t max_bytes = 1024 * 1024;
inline constexpr std::size_t header_bytes = 64;
inline constexpr std::size_t max_io_calls = 512;
inline constexpr std::size_t max_interrupts = 64;
inline constexpr std::size_t io_chunk = 65536;
inline std::atomic<std::uint64_t> temporary_counter{0};

[[noreturn]] inline void fail(const char* stage, bool uncertain = false) {
    throw NativeCampaignSaveError(stage, uncertain);
}

[[noreturn]] inline void system_fail(const char* stage, int error, bool uncertain = false) {
    throw NativeCampaignSaveError(std::string(stage) + " (errno " + std::to_string(error) + ")",
                                  uncertain);
}

class Fd {
public:
    explicit Fd(int value = -1) noexcept : value_(value) {}
    Fd(const Fd&) = delete;
    Fd& operator=(const Fd&) = delete;
    Fd(Fd&& other) noexcept : value_(other.release()) {}
    Fd& operator=(Fd&& other) noexcept {
        if (this != &other) {
            if (value_ >= 0)
                (void)::close(value_);
            value_ = other.release();
        }
        return *this;
    }
    ~Fd() {
        if (value_ >= 0)
            (void)::close(value_);
    }
    int get() const noexcept { return value_; }
    int release() noexcept {
        const auto value = value_;
        value_ = -1;
        return value;
    }

private:
    int value_;
};

inline void checked_close(Fd& file, const char* stage) {
    const auto descriptor = file.release();
    // Linux close consumes the descriptor even on EINTR; never close a reused
    // number by retrying. During unwinding Fd preserves the first failure.
    if (::close(descriptor) != 0)
        system_fail(stage, errno);
}

inline struct stat status(int descriptor, const char* stage) {
    struct stat result{};
    if (::fstat(descriptor, &result) != 0)
        system_fail(stage, errno);
    return result;
}

inline bool same_identity(const struct stat& a, const struct stat& b) noexcept {
    return a.st_dev == b.st_dev && a.st_ino == b.st_ino;
}

inline bool same_file(const struct stat& a, const struct stat& b) noexcept {
    return same_identity(a, b) && a.st_size == b.st_size && a.st_mode == b.st_mode &&
           a.st_uid == b.st_uid && a.st_nlink == b.st_nlink &&
           a.st_mtim.tv_sec == b.st_mtim.tv_sec && a.st_mtim.tv_nsec == b.st_mtim.tv_nsec &&
           a.st_ctim.tv_sec == b.st_ctim.tv_sec && a.st_ctim.tv_nsec == b.st_ctim.tv_nsec;
}

inline void require_directory(const struct stat& value) {
    if (!S_ISDIR(value.st_mode) || value.st_uid != ::geteuid() || (value.st_mode & 07777u) != 0700u)
        fail("Save directory must be owned by this user with mode 0700");
}

inline void require_file(const struct stat& value) {
    if (!S_ISREG(value.st_mode) || value.st_uid != ::geteuid() || value.st_nlink != 1 ||
        value.st_size < static_cast<off_t>(header_bytes) ||
        value.st_size > static_cast<off_t>(max_bytes))
        fail("Save slot must be an owned single-link regular file within campaign save bounds");
}

inline std::uint32_t word(std::span<const std::uint8_t> bytes, std::size_t at) noexcept {
    std::uint32_t result = 0;
    for (unsigned i = 0; i < 4; ++i)
        result |= std::uint32_t{bytes[at + i]} << (8u * i);
    return result;
}

inline void require_framing(std::span<const std::uint8_t> bytes, std::size_t physicalSize) {
    constexpr std::array<std::uint8_t, 8> magic{'O', 'R', 'T', 'W', 'S', 'A', 'V', 'E'};
    if (bytes.size() < header_bytes || physicalSize < header_bytes || physicalSize > max_bytes)
        fail("Native save input exceeds campaign framing bounds");
    for (std::size_t i = 0; i < magic.size(); ++i)
        if (bytes[i] != magic[i])
            fail("Native save slot is not ORTWSAVE");
    const auto identity = word(bytes, 20), rgb = word(bytes, 24);
    const auto width = word(bytes, 28), height = word(bytes, 32), actors = word(bytes, 36);
    const auto version = word(bytes, 8);
    if (version < 1 || version > 3)
        fail("Native save slot has unsupported campaign save version");
    const auto frameHeader = version == 1 ? std::uint64_t{64} : std::uint64_t{80};
    const auto actorBytes = version == 1 ? std::uint64_t{12} : std::uint64_t{24};
    const auto cells = std::uint64_t{width} * height;
    const auto total = frameHeader + identity + rgb + actorBytes * actors;
    if (physicalSize < frameHeader || word(bytes, 12) != 2 || word(bytes, 16) != physicalSize ||
        word(bytes, 60) != 0 || identity == 0 || width == 0 || height == 0 || width > 8191 ||
        height > 8191 || actors > 4096 || cells > max_bytes / 3 || cells * 3 != rgb ||
        (version == 3 ? total >= physicalSize : total != physicalSize))
        fail("Native save slot has inconsistent campaign save framing");
    if (version == 3 && bytes.size() >= 80) {
        const auto fogBytes = word(bytes, 68), bindingBytes = word(bytes, 72);
        if (fogBytes == 0 || bindingBytes == 0 || bindingBytes > 256 ||
            total + fogBytes + bindingBytes != physicalSize)
            fail("Native Save3 has inconsistent fog framing");
    }
    // This gate deliberately needs only the common first64 bytes, even for
    // Save2/3. Full core decode validates the80-byte header extension and24-byte
    // actor rows, orders, source/map binding, calendar/AP and owned publication.
}

struct IoBudget {
    std::size_t calls = 0;
    std::size_t interrupts = 0;
    void call() {
        if (++calls > max_io_calls)
            fail("Native save I/O call budget exceeded");
    }
    void interrupted() {
        if (++interrupts > max_interrupts)
            fail("Native save I/O interruption budget exceeded");
    }
};

inline void read_exact(int descriptor, std::span<std::uint8_t> bytes, IoBudget& budget) {
    std::size_t position = 0;
    while (position < bytes.size()) {
        budget.call();
        const auto left = bytes.size() - position;
        const auto count = left < io_chunk ? left : io_chunk;
        const auto result = ::read(descriptor, bytes.data() + position, count);
        if (result < 0) {
            const auto error = errno;
            if (error == EINTR) {
                budget.interrupted();
                continue;
            }
            system_fail("Cannot read native campaign save", error);
        }
        if (result == 0)
            fail("Native campaign save was shortened during read");
        const auto progress = static_cast<std::size_t>(result);
        if (progress > count)
            fail("Native campaign save read exceeded its requested extent");
        position += progress;
    }
}

inline void require_eof(int descriptor, IoBudget& budget) {
    std::uint8_t byte = 0;
    for (;;) {
        budget.call();
        const auto result = ::read(descriptor, &byte, 1);
        if (result == 0)
            return;
        if (result > 0)
            fail("Native campaign save grew during read");
        const auto error = errno;
        if (error == EINTR) {
            budget.interrupted();
            continue;
        }
        system_fail("Cannot verify native campaign save EOF", error);
    }
}

inline void write_exact(int descriptor, std::span<const std::uint8_t> bytes) {
    IoBudget budget;
    std::size_t position = 0;
    while (position < bytes.size()) {
        budget.call();
        const auto left = bytes.size() - position;
        const auto count = left < io_chunk ? left : io_chunk;
        const auto result = ::write(descriptor, bytes.data() + position, count);
        if (result < 0) {
            const auto error = errno;
            if (error == EINTR) {
                budget.interrupted();
                continue;
            }
            system_fail("Cannot write native campaign save temporary", error);
        }
        if (result == 0)
            fail("Native campaign save write made no progress");
        const auto progress = static_cast<std::size_t>(result);
        if (progress > count)
            fail("Native campaign save write exceeded its requested extent");
        position += progress;
    }
}

inline void sync_file(int descriptor, const char* stage, bool uncertain = false) {
    for (std::size_t attempt = 0; attempt <= max_interrupts; ++attempt) {
        if (::fsync(descriptor) == 0)
            return;
        const auto error = errno;
        if (error != EINTR || attempt == max_interrupts)
            system_fail(stage, error, uncertain);
    }
}

inline bool inside(const std::filesystem::path& path, const std::filesystem::path& parent) {
    auto a = path.begin();
    for (auto b = parent.begin(); b != parent.end(); ++b, ++a)
        if (a == path.end() || *a != *b)
            return false;
    return true;
}

inline Fd open_parent(const std::filesystem::path& absolute, bool createLast) {
    std::vector<std::string> parts;
    for (const auto& part : absolute)
        if (part != "/" && part != "." && !part.empty())
            parts.push_back(part.string());
    Fd current(::open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    if (current.get() < 0)
        system_fail("Cannot open save directory root", errno);
    for (std::size_t i = 0; i < parts.size(); ++i) {
        bool created = false;
        auto descriptor = ::openat(current.get(), parts[i].c_str(),
                                   O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (descriptor < 0 && errno == ENOENT && createLast && i + 1 == parts.size()) {
            if (::mkdirat(current.get(), parts[i].c_str(), 0700) == 0)
                created = true;
            else if (errno != EEXIST)
                system_fail("Cannot create private save directory", errno);
            descriptor = ::openat(current.get(), parts[i].c_str(),
                                  O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        }
        if (descriptor < 0)
            system_fail("Cannot open non-symlink save directory component", errno);
        Fd next(descriptor);
        if (created) {
            const auto owner = status(next.get(), "Cannot inspect newly created save directory");
            if (!S_ISDIR(owner.st_mode) || owner.st_uid != ::geteuid())
                fail("New save directory ownership changed before permission initialization");
        }
        if (created && ::fchmod(next.get(), 0700) != 0)
            system_fail("Cannot set private save directory permissions", errno);
        checked_close(current, "Cannot close save directory ancestor");
        current = Fd(next.release());
    }
    return current;
}

inline std::string temporary_name() {
    auto current = temporary_counter.load(std::memory_order_relaxed);
    for (;;) {
        if (current == std::numeric_limits<std::uint64_t>::max())
            fail("Native save temporary counter exhausted");
        if (temporary_counter.compare_exchange_weak(current, current + 1,
                                                    std::memory_order_relaxed))
            return ".openrtw-save-" + std::to_string(::getpid()) + "-" +
                   std::to_string(current + 1) + ".tmp";
    }
}

} // namespace native_save_detail

// Linux owned-save adapter, not an original RTW save implementation. The
// caller owns a stable single-writer namespace; 0700 excludes other users but
// does not establish an adversarial same-UID/higher-privilege race boundary.
// Byte/call counts are bounded; synchronous filesystem latency is not bounded.
class NativeCampaignSaveSlot {
public:
    explicit NativeCampaignSaveSlot(std::filesystem::path file,
                                    std::filesystem::path protectedGameRoot = {}) {
        using namespace native_save_detail;
        const auto raw = file.native();
        const auto leaf = file.filename().string();
        if (raw.empty() || raw.size() > 4096 || raw.find('\0') != std::string::npos ||
            leaf.empty() || leaf == "." || leaf == ".." || leaf.size() > 128 ||
            leaf.find('/') != std::string::npos)
            fail("Native save path or slot leaf is invalid");
        std::error_code error;
        path_ = std::filesystem::absolute(file, error).lexically_normal();
        if (error)
            fail("Cannot resolve native save path");
        if (path_.native().size() > 4096)
            fail("Absolute native save path exceeds its bound");
        leaf_ = path_.filename().string();
        const auto candidate = std::filesystem::weakly_canonical(path_, error);
        if (error)
            fail("Cannot resolve prospective native save location");
        if (!protectedGameRoot.empty()) {
            if (protectedGameRoot.native().size() > 4096 ||
                protectedGameRoot.native().find('\0') != std::string::npos)
                fail("Protected game path is invalid");
            const auto game = std::filesystem::canonical(protectedGameRoot, error);
            if (error || !std::filesystem::is_directory(game, error) || error)
                fail("Protected game root is unavailable");
            if (inside(candidate, game))
                fail("Native save must be outside original game inputs");
        }
        auto directory = open_parent(path_.parent_path(), true);
        const auto directoryStatus = status(directory.get(), "Cannot inspect save directory");
        require_directory(directoryStatus);
        directoryStatus_ = directoryStatus;
        directoryFd_ = directory.release();
        try {
            (void)existing_target();
        } catch (...) {
            (void)::close(directoryFd_);
            directoryFd_ = -1;
            throw;
        }
    }

    NativeCampaignSaveSlot(const NativeCampaignSaveSlot&) = delete;
    NativeCampaignSaveSlot& operator=(const NativeCampaignSaveSlot&) = delete;
    NativeCampaignSaveSlot(NativeCampaignSaveSlot&&) = delete;
    NativeCampaignSaveSlot& operator=(NativeCampaignSaveSlot&&) = delete;
    ~NativeCampaignSaveSlot() {
        if (directoryFd_ >= 0)
            (void)::close(directoryFd_);
    }

    const std::filesystem::path& path() const noexcept { return path_; }

    void save(std::span<const std::uint8_t> input) {
        using namespace native_save_detail;
        if (input.size() < header_bytes || input.size() > max_bytes)
            fail("Native save input exceeds campaign framing bounds");
        // Own the caller's completed frame before opening any writable file.
        const std::vector<std::uint8_t> bytes(input.begin(), input.end());
        require_framing(bytes, bytes.size());
        // Construct the uncertainty report before any writable action. A
        // later allocation failure while constructing a detailed post-rename
        // error must not turn an already published save into "Save refused".
        const NativeCampaignSaveError completionUnknown(
            "Native save published but completion could not be established", true);
        verify_directory();
        const auto previous = existing_target();
        const auto temporary = temporary_name();
        if (temporary == leaf_)
            fail("Native save temporary name collides with the slot");
        Fd file(::openat(directoryFd_, temporary.c_str(),
                         O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
        if (file.get() < 0)
            system_fail("Cannot create exclusive native save temporary", errno);
        struct stat owned{};
        bool identityKnown = false;
        bool published = false;
        try {
            owned = status(file.get(), "Cannot identify native save temporary");
            identityKnown = true;
            if (::fchmod(file.get(), 0600) != 0)
                system_fail("Cannot set native save temporary permissions", errno);
            const auto permissions = status(file.get(), "Cannot inspect native save temporary");
            if (!same_identity(owned, permissions) || !S_ISREG(permissions.st_mode) ||
                permissions.st_uid != ::geteuid() || permissions.st_nlink != 1 ||
                (permissions.st_mode & 07777u) != 0600u)
                fail("Native save temporary ownership is invalid");
            write_exact(file.get(), bytes);
            sync_file(file.get(), "Cannot sync native campaign save temporary");
            const auto written =
                status(file.get(), "Cannot inspect completed native save temporary");
            require_file(written);
            if (!same_identity(owned, written) ||
                written.st_size != static_cast<off_t>(bytes.size()) ||
                (written.st_mode & 07777u) != 0600u)
                fail("Completed native save temporary metadata is invalid");
            checked_close(file, "Cannot close native campaign save temporary");
            verify_directory();
            confirm_target(previous);
            struct stat named{};
            if (::fstatat(directoryFd_, temporary.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0)
                system_fail("Native save temporary disappeared before publication", errno);
            require_file(named);
            if (!same_file(written, named) || named.st_size != static_cast<off_t>(bytes.size()) ||
                (named.st_mode & 07777u) != 0600u)
                fail("Native save temporary changed before publication");
            if (::renameat(directoryFd_, temporary.c_str(), directoryFd_, leaf_.c_str()) != 0)
                system_fail("Cannot publish native campaign save", errno);
            published = true;
            sync_file(directoryFd_, "Native save published but directory sync failed", true);
        } catch (...) {
            // Never remove a published slot or an unproved replacement temp.
            // Cleanup failure does not replace the first save-stage exception.
            if (!published && identityKnown) {
                struct stat named{};
                if (::fstatat(directoryFd_, temporary.c_str(), &named, AT_SYMLINK_NOFOLLOW) == 0 &&
                    same_identity(owned, named) && S_ISREG(named.st_mode))
                    (void)::unlinkat(directoryFd_, temporary.c_str(), 0);
            }
            if (published) {
                try {
                    throw;
                } catch (const NativeCampaignSaveError&) {
                    throw;
                } catch (...) {
                    throw completionUnknown;
                }
            }
            throw;
        }
    }

    std::vector<std::uint8_t> load() const {
        using namespace native_save_detail;
        verify_directory();
        struct stat namedBefore{};
        if (::fstatat(directoryFd_, leaf_.c_str(), &namedBefore, AT_SYMLINK_NOFOLLOW) != 0)
            system_fail("Cannot inspect native campaign save before opening", errno);
        require_file(namedBefore);
        Fd file(
            ::openat(directoryFd_, leaf_.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK));
        if (file.get() < 0)
            system_fail("Cannot open native campaign save", errno);
        const auto before = status(file.get(), "Cannot inspect native campaign save");
        require_file(before);
        if (!same_file(namedBefore, before))
            fail("Native campaign save changed before opening");
        std::vector<std::uint8_t> bytes(static_cast<std::size_t>(before.st_size));
        IoBudget budget;
        read_exact(file.get(), bytes, budget);
        require_eof(file.get(), budget);
        const auto after = status(file.get(), "Cannot reinspect native campaign save");
        if (!same_file(before, after))
            fail("Native campaign save changed while reading");
        struct stat named{};
        if (::fstatat(directoryFd_, leaf_.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0)
            system_fail("Native campaign save slot disappeared while reading", errno);
        if (!same_file(after, named))
            fail("Native campaign save slot changed while reading");
        require_framing(bytes, bytes.size());
        checked_close(file, "Cannot close native campaign save after read");
        return bytes;
    }

private:
    struct Target {
        bool exists = false;
        struct stat metadata{};
    };

    void verify_directory() const {
        using namespace native_save_detail;
        const auto held = status(directoryFd_, "Cannot inspect held native save directory");
        require_directory(held);
        if (!same_identity(held, directoryStatus_))
            fail("Held native save directory identity changed");
        auto named = open_parent(path_.parent_path(), false);
        const auto current = status(named.get(), "Cannot inspect named native save directory");
        require_directory(current);
        if (!same_identity(held, current))
            fail("Native save directory path identity changed");
        checked_close(named, "Cannot close named native save directory check");
    }

    Target existing_target() const {
        using namespace native_save_detail;
        struct stat named{};
        if (::fstatat(directoryFd_, leaf_.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0) {
            const auto error = errno;
            if (error == ENOENT)
                return {};
            system_fail("Cannot inspect existing native save slot", error);
        }
        require_file(named);
        Fd file(
            ::openat(directoryFd_, leaf_.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK));
        if (file.get() < 0)
            system_fail("Cannot open existing native save slot", errno);
        const auto before = status(file.get(), "Cannot inspect opened native save slot");
        require_file(before);
        if (!same_file(named, before))
            fail("Native save slot changed before header validation");
        std::array<std::uint8_t, header_bytes> header{};
        IoBudget budget;
        read_exact(file.get(), header, budget);
        require_framing(header, static_cast<std::size_t>(before.st_size));
        const auto after = status(file.get(), "Cannot reinspect existing native save slot");
        if (!same_file(before, after))
            fail("Native save slot changed during header validation");
        checked_close(file, "Cannot close existing native save slot");
        const Target result{true, after};
        confirm_target(result);
        return result;
    }

    void confirm_target(const Target& expected) const {
        using namespace native_save_detail;
        struct stat current{};
        if (::fstatat(directoryFd_, leaf_.c_str(), &current, AT_SYMLINK_NOFOLLOW) != 0) {
            const auto error = errno;
            if (error == ENOENT && !expected.exists)
                return;
            system_fail("Native save slot changed before publication", error);
        }
        if (!expected.exists || !same_file(expected.metadata, current))
            fail("Native save slot changed before publication");
    }

    std::filesystem::path path_;
    std::string leaf_;
    int directoryFd_ = -1;
    struct stat directoryStatus_{};
};

} // namespace openrtw
