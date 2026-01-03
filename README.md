# Mesh Map Docker

A dockerized version of the [Mesh Map](https://github.com/kallanreed/mesh-map) project, designed for easy deployment of a self-hosted Meshcore map and MQTT ingest service.

## 🚀 Getting Started

### 1. Configuration
Copy the example environment file to create your own configuration:

```bash
cp .env.example .env
```

Edit `.env` and configure the following variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `MQTT_HOST` | The hostname or IP of your MQTT broker. | `mqtt.example.org` |
| `MQTT_PORT` | The MQTT port (use 1883 for TCP, 8883 for TLS, 443 for WSS). | `1883` |
| `MQTT_USERNAME` | Username for MQTT authentication. | `meshdev` |
| `MQTT_PASSWORD` | Password for MQTT authentication. | `large_bananas` |
| `MQTT_TOPIC` | Root topic for mesh traffic. | `msh/` |
| `MQTT_USE_WEBSOCKETS` | Set to `true` to use WebSockets instead of TCP. | `false` |
| `MQTT_USE_TLS` | Set to `true` to enable TLS encryption. | `false` |
| `MQTT_USE_AUTH_TOKEN` | Set to `true` if your broker requires auth tokens. | `false` |
| `CENTER_POSITION` | Map center coordinates `[LAT, LON]`. | `[47.6205, -122.3494]` |
| `VALID_DIST` | Max distance (miles) to show nodes from center. | `150` |
| `SERVICE_HOST` | Internal URL for the API service (usually correct as-is). | `http://server:3000` |

### 2. Run with Docker
Use Docker Compose to build and start the services:

**Build and Start:**
```bash
docker-compose up --build -d
```

**View Logs:**
```bash
docker-compose logs -f
```

**Stop Services:**
```bash
docker-compose down
```

## 🗺️ Accessing the Map
Once running, the map is available at:
`http://localhost:3000/wardrive.html`

## 🏗️ Architecture
- **Server**: Node.js API (ported from Cloudflare Workers) dealing with SQLite data storage and serving frontend assets.
- **MQTT Service**: Python-based ingest service that connects to the specified broker, decodes packets, and posts them to the Server API.

## 🔗 Credits
Original project by [kallanreed](https://github.com/kallanreed/mesh-map).

