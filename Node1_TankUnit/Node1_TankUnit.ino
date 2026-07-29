/*
 * NODE 1 - TANK UNIT
 * ESP32 + SX1278 (LoRa) + VL53L1X (ToF) + Relay module
 *
 * Reads water level via ToF distance sensor, controls a relay (pump)
 * with hysteresis, and transmits level data over LoRa to Node 2.
 *
 * Libraries required (Arduino Library Manager):
 *   - "LoRa" by Sandeep Mistry
 *   - "VL53L1X" by Pololu
 */

#include <SPI.h>
#include <LoRa.h>
#include <Wire.h>
#include <VL53L1X.h>

// ---------- LoRa (SX1278) pins ----------
#define LORA_SCK   18
#define LORA_MISO  19
#define LORA_MOSI  23
#define LORA_CS    5
#define LORA_RST   14
#define LORA_DIO0  26
#define LORA_FREQ  433E6   // change to 868E6 / 915E6 for other module variants
#define LORA_SYNC_WORD 0xF3

// ---------- VL53L1X (I2C) pins ----------
#define I2C_SDA    21
#define I2C_SCL    22
#define TOF_XSHUT  27      // optional, tie high or leave unused if not wired

// ---------- Relay ----------
#define RELAY_PIN  25
#define RELAY_ACTIVE_HIGH true   // set false if your relay board is active-LOW

// ---------- Status LEDs ----------
#define LED_GREEN_PIN 32   // lit when tank is at/above HIGH_THRESHOLD (full)
#define LED_RED_PIN   33   // lit when tank is at/below LOW_THRESHOLD (empty/low)
#define LED_BLUE_PIN  4    // lit whenever the pump/relay is ON

// ---------- Tank calibration (mm) ----------
// Measure once installed: distance from sensor to the BOTTOM of the tank (empty),
// and the distance from sensor to water surface when tank is FULL.
const int TANK_HEIGHT_MM      = 2000;  // sensor-to-bottom distance (empty tank)
const int TANK_FULL_OFFSET_MM = 100;   // sensor-to-water distance when 100% full

// ---------- Relay hysteresis thresholds (%) ----------
const int LOW_THRESHOLD  = 20;  // turn pump ON at or below this level
const int HIGH_THRESHOLD = 90;  // turn pump OFF at or above this level

// ---------- Manual override (from website, via Node 2) ----------
bool manualOverrideActive = false;
bool manualOverrideState  = false; // true = force pump ON
unsigned long manualOverrideSetAt = 0;
const unsigned long MANUAL_OVERRIDE_TIMEOUT_MS = 15UL * 60UL * 1000UL; // 15 min safety expiry

// ---------- Timing ----------
const unsigned long SEND_INTERVAL_MS = 5000;

VL53L1X sensor;
unsigned long lastSend = 0;
bool pumpOn = false;

void relayWrite(bool on) {
  bool level = RELAY_ACTIVE_HIGH ? on : !on;
  digitalWrite(RELAY_PIN, level ? HIGH : LOW);
  digitalWrite(LED_BLUE_PIN, on ? HIGH : LOW);
}

void updateStatusLEDs(int levelPercent) {
  digitalWrite(LED_RED_PIN, levelPercent <= LOW_THRESHOLD ? HIGH : LOW);
  digitalWrite(LED_GREEN_PIN, levelPercent >= HIGH_THRESHOLD ? HIGH : LOW);
}

void controlRelay(int levelPercent) {
  // Manual override expiry - revert to automatic control if stale
  if (manualOverrideActive && millis() - manualOverrideSetAt > MANUAL_OVERRIDE_TIMEOUT_MS) {
    manualOverrideActive = false;
    Serial.println("Manual override expired, reverting to auto control.");
  }

  if (manualOverrideActive) {
    if (pumpOn != manualOverrideState) {
      pumpOn = manualOverrideState;
      relayWrite(pumpOn);
      Serial.println(pumpOn ? "Relay: pump ON (manual)" : "Relay: pump OFF (manual)");
    }
    return;
  }

  // Automatic hysteresis control
  if (!pumpOn && levelPercent <= LOW_THRESHOLD) {
    pumpOn = true;
    relayWrite(true);
    Serial.println("Relay: pump ON (auto)");
  } else if (pumpOn && levelPercent >= HIGH_THRESHOLD) {
    pumpOn = false;
    relayWrite(false);
    Serial.println("Relay: pump OFF (auto)");
  }
}

void handleCommand(const String& cmd) {
  if (cmd == "CMD:ON") {
    manualOverrideActive = true;
    manualOverrideState = true;
    manualOverrideSetAt = millis();
    Serial.println("Received manual command: ON");
  } else if (cmd == "CMD:OFF") {
    manualOverrideActive = true;
    manualOverrideState = false;
    manualOverrideSetAt = millis();
    Serial.println("Received manual command: OFF");
  } else if (cmd == "CMD:AUTO") {
    manualOverrideActive = false;
    Serial.println("Received manual command: back to AUTO");
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(RELAY_PIN, OUTPUT);
  relayWrite(false); // start with pump off

  pinMode(LED_GREEN_PIN, OUTPUT);
  pinMode(LED_RED_PIN, OUTPUT);
  pinMode(LED_BLUE_PIN, OUTPUT);
  digitalWrite(LED_GREEN_PIN, LOW);
  digitalWrite(LED_RED_PIN, LOW);
  digitalWrite(LED_BLUE_PIN, LOW);

  // --- VL53L1X init ---
  Wire.begin(I2C_SDA, I2C_SCL);
  sensor.setTimeout(500);
  if (!sensor.init()) {
    Serial.println("FATAL: VL53L1X not detected. Check wiring/I2C address.");
    while (1) delay(1000);
  }
  sensor.setDistanceMode(VL53L1X::Long);       // up to ~4m range
  sensor.setMeasurementTimingBudget(50000);    // 50ms budget, decent accuracy
  sensor.startContinuous(100);                 // continuous reads every 100ms

  // --- LoRa init ---
  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_CS);
  LoRa.setPins(LORA_CS, LORA_RST, LORA_DIO0);
  if (!LoRa.begin(LORA_FREQ)) {
    Serial.println("FATAL: LoRa init failed. Check wiring/frequency.");
    while (1) delay(1000);
  }
  LoRa.setSyncWord(LORA_SYNC_WORD);

  Serial.println("Node 1 (tank unit) ready.");
}

void loop() {
  // Check for incoming manual commands from Node 2 on every cycle,
  // not just when we're about to transmit.
  int cmdPacketSize = LoRa.parsePacket();
  if (cmdPacketSize) {
    String cmd;
    cmd.reserve(cmdPacketSize);
    while (LoRa.available()) cmd += (char)LoRa.read();
    handleCommand(cmd);
  }

  if (millis() - lastSend < SEND_INTERVAL_MS) return;
  lastSend = millis();

  int distanceMM = sensor.read();
  if (sensor.timeoutOccurred()) {
    Serial.println("WARN: VL53L1X read timeout, skipping this cycle.");
    return;
  }

  // Convert raw distance to a 0-100% water level.
  int waterColumnMM = TANK_HEIGHT_MM - distanceMM;
  int usableRangeMM = TANK_HEIGHT_MM - TANK_FULL_OFFSET_MM;
  waterColumnMM = constrain(waterColumnMM, 0, usableRangeMM);
  int levelPercent = map(waterColumnMM, 0, usableRangeMM, 0, 100);

  updateStatusLEDs(levelPercent);
  controlRelay(levelPercent);

  // Simple CSV-style payload: easy to parse, easy to extend later.
  String payload = "L:" + String(levelPercent) +
                    ",D:" + String(distanceMM) +
                    ",P:" + String(pumpOn ? 1 : 0) +
                    ",M:" + String(manualOverrideActive ? 1 : 0);

  LoRa.beginPacket();
  LoRa.print(payload);
  LoRa.endPacket();

  Serial.println("TX -> " + payload);
}
