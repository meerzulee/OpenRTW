#include "pcm.hpp"
#include <SDL.h>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
struct Audio {
    SDL_AudioDeviceID device = 0;
    bool initialized = false;
    ~Audio() {
        if (device) {
            SDL_PauseAudioDevice(device, 1);
            SDL_ClearQueuedAudio(device);
            SDL_CloseAudioDevice(device);
        }
        if (initialized)
            SDL_QuitSubSystem(SDL_INIT_AUDIO);
    }
};
std::vector<std::uint8_t> read_pcm(const std::string& path) {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file)
        throw std::runtime_error("Cannot open selected PCM file");
    const auto size = file.tellg();
    if (size <= 0 || size > static_cast<std::streamoff>(openrtw::pcm_max_input_bytes))
        throw std::runtime_error("Selected PCM input exceeds byte limit");
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
    file.seekg(0);
    if (!file.read(reinterpret_cast<char*>(bytes.data()), size))
        throw std::runtime_error("Selected PCM read is incomplete");
    return bytes;
}
} // namespace

int main(int argc, char** argv) {
    try {
        if (argc != 3 || std::string(argv[1]) != "--pcm")
            throw std::runtime_error("Usage: openrtw-audio --pcm SELECTED.wav");
        const auto clip = openrtw::load_pcm(read_pcm(argv[2]));
        Audio audio;
        if (SDL_InitSubSystem(SDL_INIT_AUDIO) != 0)
            throw std::runtime_error(SDL_GetError());
        audio.initialized = true;
        SDL_AudioSpec wanted{}, obtained{};
        wanted.freq = static_cast<int>(clip.sampleRate);
        wanted.format = AUDIO_S16SYS;
        wanted.channels = 1;
        wanted.samples = 1024;
        audio.device = SDL_OpenAudioDevice(nullptr, 0, &wanted, &obtained, 0);
        if (!audio.device)
            throw std::runtime_error(SDL_GetError());
        if (obtained.freq != wanted.freq || obtained.format != wanted.format ||
            obtained.channels != 1)
            throw std::runtime_error("Audio device refused exact mono22050 signed16 format");
        // A short silence tail lets the backend's resampler emit the final
        // source samples. This is new output policy, not source-file data.
        auto output = clip.monoSamples;
        constexpr std::uint32_t silence_frames = 1024;
        output.resize(output.size() + silence_frames, 0);
        const auto bytes = static_cast<Uint32>(output.size() * sizeof(std::int16_t));
        if (SDL_QueueAudio(audio.device, output.data(), bytes) != 0)
            throw std::runtime_error(SDL_GetError());
        // SDL2-compat can derive this count from converted available bytes;
        // it is an observation, not an exact submitted-byte acknowledgement.
        const auto initially_queued = SDL_GetQueuedAudioSize(audio.device);
        SDL_PauseAudioDevice(audio.device, 0);
        const auto deadline = SDL_GetTicks64() + 3000;
        while (SDL_GetQueuedAudioSize(audio.device)) {
            if (SDL_GetTicks64() >= deadline)
                throw std::runtime_error("Audio queue did not drain before deadline");
            SDL_Delay(5);
        }
        // The backend can still own its final period after queue consumption.
        SDL_Delay(static_cast<Uint32>(1000u * obtained.samples / clip.sampleRate + 100u));
        std::cout << "{\"driver\":\"" << SDL_GetCurrentAudioDriver()
                  << "\",\"rate\":" << obtained.freq
                  << ",\"channels\":1,\"format\":" << obtained.format
                  << ",\"frames\":" << clip.monoSamples.size()
                  << ",\"silenceFrames\":" << silence_frames << ",\"bytesSubmitted\":" << bytes
                  << ",\"initialQueuedBytes\":" << initially_queued << ",\"queueDrained\":true}\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "OpenRTW audio: " << error.what() << '\n';
        return 1;
    }
}
