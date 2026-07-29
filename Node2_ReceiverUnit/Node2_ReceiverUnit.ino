/*
 * NODE 2 - RECEIVER / BRIDGE UNIT
 * ESP32 + SX1278 (LoRa), built-in WiFi
 *
 * - Receives telemetry from Node 1 over LoRa, forwards it to the
 *   backend (Node.js on Render) over HTTPS.
 * - Polls the backend for pending manual relay commands (from the
 *   React website) and forwards them to Node 1 over LoRa.
 *
 * Libraries required:
 *   - "LoRa" by Sandeep Mistry
 *   - WiFi.h, HTTPClient.h, WiFiClientSecure.h (bundled with ESP32 board package)
 */

#include <SPI.h>
#include <LoRa.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

// ---------- LoRa (SX1278) pins - same as Node 1 ----------
#define LORA_SCK   18
#define LORA_MISO  19
#define LORA_MOSI  23
#define LORA_CS    5
#define LORA_RST   14
#define LORA_DIO0  26
#define LORA_FREQ  433E6   // must match Node 1
#define LORA_SYNC_WORD 0xF3

// ---------- WiFi credentials ----------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ---------- Backend (Render) ----------
// Replace with your actual Render backend URL, e.g. https://tank-monitor-backend.onrender.com
const char* BACKEND_HOST = "https://YOUR-BACKEND-NAME.onrender.com";
const unsigned long COMMAND_POLL_INTERVAL_MS = 3000;

unsigned long lastCommandPoll = 0;

int  lastLevel    = -1;
int  lastDistance = -1;
bool lastPump     = false;
bool lastManual   = false;

void postTelemetry() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure(); // skip TLS cert validation - fine for a hobby/MVP build,
                         // swap for client.setCACert(...) if you want it hardened later

  HTTPClient http;
  String url = String(BACKEND_HOST) + "/api/telemetry";
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");

  String body = "{\"level\":" + String(lastLevel) +
                ",\"distance\":" + String(lastDistance) +
                ",\"pump\":" + String(lastPump ? "true" : "false") +
                ",\"manual\":" + String(lastManual ? "true" : "false") + "}";

  int code = http.POST(body);
  Serial.println("POST /api/telemetry -> " + String(code));
  http.end();
}

void pollForCommand() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String url = String(BACKEND_HOST) + "/api/command";
  http.begin(client, url);
  int code = http.GET();

  if (code == 200) {
    String response = http.getString();
    // Expecting: {"command":"ON"} or {"command":"OFF"} or {"command":null}
    if (response.indexOf("\"ON\"") >= 0) {
      sendCommandToNode1("CMD:ON");
    } else if (response.indexOf("\"OFF\"") >= 0) {
      sendCommandToNode1("CMD:OFF");
    } else if (response.indexOf("\"AUTO\"") >= 0) {
      sendCommandToNode1("CMD:AUTO");
    }
  }
  http.end();
}

void sendCommandToNode1(const String& cmd) {
  LoRa.beginPacket();
  LoRa.print(cmd);
  LoRa.endPacket();
  Serial.println("Forwarded to Node 1 -> " + cmd);
  LoRa.receive(); // make sure we go back to listening after transmit
}

void parsePayload(const String& payload) {
  // Expected format: "L:<level>,D:<distance>,P:<0/1>,M:<0/1>"
  int lIdx = payload.indexOf("L:");
  int dIdx = payload.indexOf(",D:");
  int pIdx = payload.indexOf(",P:");
  int mIdx = payload.indexOf(",M:");
  if (lIdx < 0 || dIdx < 0 || pIdx < 0) {
    Serial.println("WARN: malformed packet: " + payload);
    return;
  }
  lastLevel    = payload.substring(lIdx + 2, dIdx).toInt();
  lastDistance = payload.substring(dIdx + 3, pIdx).toInt();
  if (mIdx >= 0) {
    lastPump   = payload.substring(pIdx + 3, mIdx).toInt() == 1;
    lastManual = payload.substring(mIdx + 3).toInt() == 1;
  } else {
    lastPump   = payload.substring(pIdx + 3).toInt() == 1;
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Connected. IP address: ");
  Serial.println(WiFi.localIP());

  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_CS);
  LoRa.setPins(LORA_CS, LORA_RST, LORA_DIO0);
  if (!LoRa.begin(LORA_FREQ)) {
    Serial.println("FATAL: LoRa init failed. Check wiring/frequency.");
    while (1) delay(1000);
  }
  LoRa.setSyncWord(LORA_SYNC_WORD);

  Serial.println("Node 2 (bridge unit) ready.");
}

void loop() {
  int packetSize = LoRa.parsePacket();
  if (packetSize) {
    String received;
    received.reserve(packetSize);
    while (LoRa.available()) {
      received += (char)LoRa.read();
    }
    parsePayload(received);
    Serial.println("RX <- " + received + "  (RSSI: " + String(LoRa.packetRssi()) + ")");
    postTelemetry();
  }

  if (millis() - lastCommandPoll >= COMMAND_POLL_INTERVAL_MS) {
    lastCommandPoll = millis();
    pollForCommand();
  }
}
