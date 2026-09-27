// Bridge between the Rust helper and moonlight-common-c.
//
// The library wants its own structures and plain C callbacks. This file fills
// them in and hands Rust two simple callbacks: a whole video frame in one
// contiguous buffer, and events (stages, errors, log lines). Audio is not
// needed (the stream is watched, not played on this machine) and is dropped.

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "Limelight.h"

typedef void (*ml_frame_cb)(const unsigned char* data, int length, int frame_number, int frame_type,
                            int video_format, int width, int height, unsigned long long pts_us);
typedef void (*ml_event_cb)(int kind, int code, const char* text);

enum {
    EV_SETUP = 1,
    EV_STAGE_START = 2,
    EV_STAGE_DONE = 3,
    EV_STAGE_FAILED = 4,
    EV_STARTED = 5,
    EV_TERMINATED = 6,
    EV_LOG = 7,
    EV_STATUS = 8,
};

static ml_frame_cb on_frame;
static ml_event_cb on_event;
static int cur_format;
static int cur_width;
static int cur_height;
static unsigned char* frame_buf;
static int frame_cap;

// the library keeps pointers to these for the whole connection
static char* keep_address;
static char* keep_app_version;
static char* keep_gfe_version;
static char* keep_rtsp_url;

static int dr_setup(int video_format, int width, int height, int redraw_rate, void* context, int dr_flags) {
    (void)redraw_rate;
    (void)context;
    (void)dr_flags;
    cur_format = video_format;
    cur_width = width;
    cur_height = height;
    on_event(EV_SETUP, video_format, "");
    return 0;
}

static void dr_nothing(void) {}

static void dr_cleanup(void) {
    free(frame_buf);
    frame_buf = NULL;
    frame_cap = 0;
}

static int dr_submit(PDECODE_UNIT du) {
    if (du->fullLength > frame_cap) {
        int cap = du->fullLength * 2;
        unsigned char* grown = (unsigned char*)realloc(frame_buf, (size_t)cap);
        if (!grown) return DR_NEED_IDR;
        frame_buf = grown;
        frame_cap = cap;
    }
    int at = 0;
    for (PLENTRY e = du->bufferList; e != NULL; e = e->next) {
        memcpy(frame_buf + at, e->data, (size_t)e->length);
        at += e->length;
    }
    on_frame(frame_buf, at, du->frameNumber, du->frameType, cur_format, cur_width, cur_height, du->presentationTimeUs);
    return DR_OK;
}

static int ar_init(int audio_configuration, const POPUS_MULTISTREAM_CONFIGURATION opus_config, void* context, int ar_flags) {
    (void)audio_configuration;
    (void)opus_config;
    (void)context;
    (void)ar_flags;
    return 0;
}

static void ar_nothing(void) {}

static void ar_sample(char* data, int length) {
    (void)data;
    (void)length;
}

static void cl_stage_starting(int stage) { on_event(EV_STAGE_START, stage, LiGetStageName(stage)); }
static void cl_stage_complete(int stage) { on_event(EV_STAGE_DONE, stage, LiGetStageName(stage)); }
static void cl_stage_failed(int stage, int error_code) { on_event(EV_STAGE_FAILED, error_code, LiGetStageName(stage)); }
static void cl_started(void) { on_event(EV_STARTED, 0, ""); }
static void cl_terminated(int error_code) { on_event(EV_TERMINATED, error_code, ""); }
static void cl_status(int status) { on_event(EV_STATUS, status, ""); }

static void cl_log(const char* format, ...) {
    char line[1024];
    va_list ap;
    va_start(ap, format);
    vsnprintf(line, sizeof(line), format, ap);
    va_end(ap);
    on_event(EV_LOG, 0, line);
}

static char* dup_or_null(const char* s) {
    if (!s || !*s) return NULL;
    size_t n = strlen(s) + 1;
    char* d = (char*)malloc(n);
    if (d) memcpy(d, s, n);
    return d;
}

const char* ml_launch_query(void) {
    return LiGetLaunchUrlQueryParameters();
}

int ml_start(const char* address, const char* app_version, const char* gfe_version, const char* rtsp_url,
             int server_codec_mode_support, int width, int height, int fps, int bitrate_kbps, int packet_size,
             int video_formats, const unsigned char* aes_key, const unsigned char* aes_iv,
             ml_frame_cb frame_cb, ml_event_cb event_cb) {
    on_frame = frame_cb;
    on_event = event_cb;

    keep_address = dup_or_null(address);
    keep_app_version = dup_or_null(app_version);
    keep_gfe_version = dup_or_null(gfe_version);
    keep_rtsp_url = dup_or_null(rtsp_url);

    SERVER_INFORMATION si;
    LiInitializeServerInformation(&si);
    si.address = keep_address;
    si.serverInfoAppVersion = keep_app_version;
    si.serverInfoGfeVersion = keep_gfe_version;
    si.rtspSessionUrl = keep_rtsp_url;
    si.serverCodecModeSupport = server_codec_mode_support;

    STREAM_CONFIGURATION sc;
    LiInitializeStreamConfiguration(&sc);
    sc.width = width;
    sc.height = height;
    sc.fps = fps;
    sc.bitrate = bitrate_kbps;
    sc.packetSize = packet_size;
    sc.streamingRemotely = STREAM_CFG_AUTO;
    sc.audioConfiguration = AUDIO_CONFIGURATION_STEREO;
    sc.supportedVideoFormats = video_formats;
    sc.clientRefreshRateX100 = fps * 100;
    sc.colorSpace = COLORSPACE_REC_709;
    sc.colorRange = COLOR_RANGE_LIMITED;
    sc.encryptionFlags = ENCFLG_AUDIO;
    memcpy(sc.remoteInputAesKey, aes_key, sizeof(sc.remoteInputAesKey));
    memcpy(sc.remoteInputAesIv, aes_iv, sizeof(sc.remoteInputAesIv));

    DECODER_RENDERER_CALLBACKS dr;
    LiInitializeVideoCallbacks(&dr);
    dr.setup = dr_setup;
    dr.start = dr_nothing;
    dr.stop = dr_nothing;
    dr.cleanup = dr_cleanup;
    dr.submitDecodeUnit = dr_submit;
    // frames go straight from the receive thread to the pipe: no extra queue
    dr.capabilities = CAPABILITY_DIRECT_SUBMIT;

    AUDIO_RENDERER_CALLBACKS ar;
    LiInitializeAudioCallbacks(&ar);
    ar.init = ar_init;
    ar.start = ar_nothing;
    ar.stop = ar_nothing;
    ar.cleanup = ar_nothing;
    ar.decodeAndPlaySample = ar_sample;

    CONNECTION_LISTENER_CALLBACKS cl;
    LiInitializeConnectionCallbacks(&cl);
    cl.stageStarting = cl_stage_starting;
    cl.stageComplete = cl_stage_complete;
    cl.stageFailed = cl_stage_failed;
    cl.connectionStarted = cl_started;
    cl.connectionTerminated = cl_terminated;
    cl.logMessage = cl_log;
    cl.connectionStatusUpdate = cl_status;

    return LiStartConnection(&si, &sc, &cl, &dr, &ar, NULL, 0, NULL, 0);
}

void ml_stop(void) {
    LiStopConnection();
}

void ml_request_idr(void) {
    LiRequestIdrFrame();
}
