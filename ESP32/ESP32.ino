#include <Arduino.h>
#include <driver/i2s.h>
#include <math.h>

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#include <WiFi.h>
#include <HTTPClient.h>

// =================== WiFi ===================
const char* WIFI_SSID = "Vodafone-25DC";
const char* WIFI_PASS = "sGtyn6ZJmtzybPsX"; 

// =================== Backend API ===================

// AWS
const char* BACKEND_URL = "http://noise-sensor-alb-899662008.eu-central-1.elb.amazonaws.com/api/noise-data";

//// Locally
//const char* BACKEND_URL = "http://192.168.0.240:8080/api/noise-data";

const char* DEVICE_ID   = "ESP32_003";

// =================== OLED (SSD1306) ===================
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define OLED_ADDR 0x3C

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// Graph settings
const float DB_MIN = 20.0;
const float DB_MAX = 80.0;
const uint8_t GRAPH_X = 0;
const uint8_t GRAPH_Y = 22;
const uint8_t GRAPH_W = 128;
const uint8_t GRAPH_H = 42;

float ringBuf[SCREEN_WIDTH];
uint8_t head = 0;
float currentDb = 50.0;

// Display refresh timing
const unsigned long SAMPLE_EVERY_MS = 120;
unsigned long lastDisplayMs = 0;

// =================== MIC (SPH0645) via I2S ===================
#define I2S_WS 5
#define I2S_SCK 16
#define I2S_SD 17

static const i2s_port_t I2S_PORT = I2S_NUM_0;
static const uint32_t SAMPLE_RATE = 16000;

static const i2s_config_t i2s_config = {
  .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
  .sample_rate = SAMPLE_RATE,
  .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
  .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
  .communication_format = I2S_COMM_FORMAT_I2S,
  .intr_alloc_flags = 0,
  .dma_buf_count = 4,
  .dma_buf_len = 512,
  .use_apll = false,
  .tx_desc_auto_clear = false,
  .fixed_mclk = 0
};

static const i2s_pin_config_t pin_config = {
  .bck_io_num = I2S_SCK,
  .ws_io_num = I2S_WS,
  .data_out_num = -1,
  .data_in_num = I2S_SD
};

#define BLOCK_SAMPLES 1024
static const float NORM_DIV = 131072.0f;
static float CAL_OFFSET_DBA = 96.0f;
static const float EPS_F = 1e-12f;

// Simple HPF
struct OnePoleHPF {
  float a = 0.995f;
  float y = 0.0f;
  float x_prev = 0.0f;
  float process(float x) {
    y = a * (y + x - x_prev);
    x_prev = x;
    return y;
  }
} hpf;

int32_t rx_buf[BLOCK_SAMPLES];

// 1s aggregation
double sumsq_1s = 0.0;
uint32_t samples_1s = 0;
uint32_t t1_start_ms = 0;

// =================== FreeRTOS queue for sending ===================
static QueueHandle_t sendQueue;

// ======== Helpers for graph ========
float clampf(float v, float lo, float hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

int mapDbToY(float dB) {
  float t = (clampf(dB, DB_MIN, DB_MAX) - DB_MIN) / (DB_MAX - DB_MIN);
  int y = GRAPH_Y + GRAPH_H - 1 - (int)(t * (GRAPH_H - 1));
  return y;
}

void pushSample(float dB) {
  ringBuf[head] = dB;
  head = (head + 1) % GRAPH_W;
}

void drawGraph() {
  display.drawRect(GRAPH_X, GRAPH_Y, GRAPH_W, GRAPH_H, SSD1306_WHITE);

  const float WHO_DAY = 55.0;
  int yWho = mapDbToY(WHO_DAY);
  for (int x = GRAPH_X + 1; x < GRAPH_X + GRAPH_W - 1; x += 4) {
    display.drawPixel(x, yWho, SSD1306_WHITE);
  }

  int prevX = 0, prevY = mapDbToY(ringBuf[(head) % GRAPH_W]);
  for (int i = 1; i < GRAPH_W; i++) {
    int idx = (head + i) % GRAPH_W;
    int x = i;
    int y = mapDbToY(ringBuf[idx]);
    display.drawLine(prevX, prevY, x, y, SSD1306_WHITE);
    prevX = x;
    prevY = y;
  }
}

void drawHeader() {
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.print(currentDb, 1);
  display.print(" dB");

  int limit = 55;
  const char* label = "OK";
  if (currentDb > limit + 5) label = "HIGH";
  else if (currentDb > limit - 5) label = "CAUTION";

  int16_t x1, y1;
  uint16_t w, h;
  display.setTextSize(1);
  display.getTextBounds(label, 0, 0, &x1, &y1, &w, &h);
  display.setCursor(SCREEN_WIDTH - w - 2, 4);
  display.print(label);
}

// =================== Network task (runs separately) ===================
bool postToBackend(float dba) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  http.setTimeout(800); // mag best iets langer; blokkeert alleen de send-task

  http.begin(BACKEND_URL);
  http.addHeader("Content-Type", "application/json");

  String payload = "{\"dba_instant\":" + String(dba, 2) +
                   ",\"device_id\":\"" + String(DEVICE_ID) + "\"}";

  int code = http.POST(payload);
  http.end();

  if (code > 0) {
    Serial.printf("[SEND] OK %.2f dBA code=%d\n", dba, code);
    return true;
  } else {
    Serial.printf("[SEND] FAIL code=%d\n", code);
    return false;
  }
}

void sendTask(void* param) {
  float dba = 0.0f;

  unsigned long backoffMs = 1000;
  const unsigned long BACKOFF_MAX = 30000;

  for (;;) {
    // Wacht op nieuw punt uit de queue (blokkeert hier, dat is prima)
    if (xQueueReceive(sendQueue, &dba, portMAX_DELAY) == pdTRUE) {
      bool ok = postToBackend(dba);

      if (!ok) {
        // backoff bij backend down
        vTaskDelay(pdMS_TO_TICKS(backoffMs));
        backoffMs = min(backoffMs * 2, BACKOFF_MAX);
      } else {
        backoffMs = 1000;
      }

      // Als er veel punten in queue zitten, pak alleen de nieuwste (dropping old)
      while (uxQueueMessagesWaiting(sendQueue) > 1) {
        xQueueReceive(sendQueue, &dba, 0);
      }
    }
  }
}

// =================== Setup helpers ===================
void initializeSerial() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nESP32 Noise Meter -> Backend");
}

void connectToWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("Connecting to WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 8000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Connected! IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi not connected yet (OLED still runs).");
  }

  Serial.print("Backend URL: ");
  Serial.println(BACKEND_URL);
}

void initializeI2SMicrophone() {
  i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  i2s_set_pin(I2S_PORT, &pin_config);
  i2s_start(I2S_PORT);
}

void initializeOLEDDisplay() {
  Wire.begin(21, 22);
  Wire.setClock(400000);

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("SSD1306 allocation failed");
    while (true) {}
  }

  display.clearDisplay();
  display.setCursor(0, 0);
  display.println("Noise meter init...");
  display.display();
}

void initializeRingBuffer() {
  for (int i = 0; i < GRAPH_W; i++) ringBuf[i] = 50.0;
  t1_start_ms = millis();
}

// =================== Loop helpers ===================
bool readI2SAudioData(size_t& bytes_read, size_t& num_samples) {
  if (i2s_read(I2S_PORT, (void*)rx_buf, sizeof(rx_buf), &bytes_read, portMAX_DELAY) != ESP_OK) {
    return false;
  }
  num_samples = bytes_read / sizeof(int32_t);
  return (num_samples > 0);
}

float calculateMean(size_t num_samples) {
  long long mean_acc = 0;
  for (size_t i = 0; i < num_samples; i++) mean_acc += (rx_buf[i] >> 14);
  return (float)mean_acc / (float)num_samples;
}

double calculateSumOfSquares(size_t num_samples, float mean) {
  double sumsq_block = 0.0;
  for (size_t i = 0; i < num_samples; i++) {
    float s = (float)((rx_buf[i] >> 14) - mean) / NORM_DIV;
    s = hpf.process(s);
    sumsq_block += (double)s * (double)s;
  }
  return sumsq_block;
}

float convertToDecibels(float rms_value) {
  float dBFS = 20.0f * log10f(fmaxf(rms_value, EPS_F));
  return dBFS + CAL_OFFSET_DBA;
}

void accumulateAudioData(double sumsq_block, size_t num_samples) {
  sumsq_1s += sumsq_block;
  samples_1s += num_samples;
}

void updateDisplay() {
  pushSample(currentDb);
  display.clearDisplay();
  drawHeader();
  drawGraph();
  display.display();
}

void processDisplayUpdate(unsigned long now) {
  if (now - lastDisplayMs >= SAMPLE_EVERY_MS) {
    lastDisplayMs = now;
    updateDisplay();
  }
}

// =================== SETUP ===================
void setup() {
  initializeSerial();

  // Queue for sending 1s values (keep a few; we drop old anyway)
  sendQueue = xQueueCreate(5, sizeof(float));

  connectToWiFi();
  initializeI2SMicrophone();
  initializeOLEDDisplay();
  initializeRingBuffer();

  // Start send task on the other core (ESP32 has 2 cores)
  xTaskCreatePinnedToCore(
    sendTask,
    "sendTask",
    4096,
    nullptr,
    1,
    nullptr,
    0 // core 0 for network task
  );

  Serial.println("Setup complete.");
}

// =================== LOOP ===================
void loop() {
  size_t bytes_read = 0;
  size_t num_samples = 0;
  if (!readI2SAudioData(bytes_read, num_samples)) return;

  // Process audio block
  float mean = calculateMean(num_samples);
  double sumsq_block = calculateSumOfSquares(num_samples, mean);

  // Instant dBA for OLED
  float rms_block = sqrt(sumsq_block / (double)num_samples);
  currentDb = convertToDecibels(rms_block);

  // Accumulate for 1-second average
  accumulateAudioData(sumsq_block, num_samples);

  uint32_t now = millis();

  // Every 1 second: compute 1s average and push to queue (non-blocking)
  if (now - t1_start_ms >= 1000) {
    float rms_1s = sqrt(sumsq_1s / (double)samples_1s);
    float dBA_1s = convertToDecibels(rms_1s);

    // Push to queue without waiting; if full, drop oldest and insert newest
    if (xQueueSend(sendQueue, &dBA_1s, 0) != pdTRUE) {
      float dummy;
      xQueueReceive(sendQueue, &dummy, 0);
      xQueueSend(sendQueue, &dBA_1s, 0);
    }

    sumsq_1s = 0.0;
    samples_1s = 0;
    t1_start_ms = now;
  }

  // OLED update always smooth
  processDisplayUpdate(now);
}