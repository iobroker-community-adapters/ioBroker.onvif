# ioBroker Adapter Development with GitHub Copilot

**Version:** 0.4.0
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

## Project Context

You are working on an ioBroker adapter. ioBroker is an integration platform for the Internet of Things, focused on building smart home and industrial IoT solutions. Adapters are plugins that connect ioBroker to external systems, devices, or services.

## Adapter-Specific Context

- **Adapter Name**: ioBroker.onvif
- **Primary Function**: ONVIF camera integration adapter for ioBroker IoT platform
- **Key Dependencies**: onvif library for camera communication, ffmpeg for video processing, json2iob for object management
- **Target Devices**: IP cameras supporting ONVIF protocol (Pan-Tilt-Zoom cameras, fixed cameras, RTSP streams)
- **Configuration Requirements**: Camera credentials, network discovery settings, server configuration for snapshots/streaming
- **Key Features**: Camera discovery via ONVIF protocol, PTZ control, motion event handling, snapshot capture, RTSP stream integration

### ONVIF Camera Integration Patterns

- **Camera Discovery**: Uses ONVIF discovery protocol to automatically detect cameras on network
- **Authentication**: Handles different credential schemes (basic auth, digest auth) for various camera manufacturers
- **Event Handling**: Subscribes to motion detection and other camera events via ONVIF event service
- **PTZ Control**: Provides preset positions, home position, and manual pan/tilt/zoom controls
- **Stream Management**: Extracts RTSP stream URLs and snapshot endpoints from camera profiles
- **Error Recovery**: Implements reconnection logic for unstable camera connections

### Camera Vendor Considerations

When working with ONVIF cameras, consider manufacturer-specific variations:
- **Hikvision**: Typically uses digest authentication, may require specific ONVIF profiles
- **Dahua**: Often requires basic authentication, sometimes custom event subscriptions
- **Axis**: Usually standards-compliant, supports full ONVIF feature set
- **TAPO/TP-Link**: Recent models may need updated onvif library, limited PTZ support
- **Generic cameras**: May have incomplete ONVIF implementations, require error handling

## Testing

### Unit Testing
- Use Jest as the primary testing framework for ioBroker adapters
- Create tests for all adapter main functions and helper methods
- Test error handling scenarios and edge cases
- Mock external API calls and hardware dependencies
- For adapters connecting to APIs/devices not reachable by internet, provide example data files to allow testing of functionality without live connections
- Example test structure:
  ```javascript
  describe('AdapterName', () => {
    let adapter;
    
    beforeEach(() => {
      // Setup test adapter instance
    });
    
    test('should initialize correctly', () => {
      // Test adapter initialization
    });
  });
  ```

### Integration Testing

**IMPORTANT**: Use the official `@iobroker/testing` framework for all integration tests. This is the ONLY correct way to test ioBroker adapters.

**Official Documentation**: https://github.com/ioBroker/testing

#### Framework Structure
Integration tests MUST follow this exact pattern:

```javascript
const path = require('path');
const { tests } = require('@iobroker/testing');

// Define test coordinates or configuration
const TEST_COORDINATES = '52.520008,13.404954'; // Berlin
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Use tests.integration() with defineAdditionalTests
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Test adapter with specific configuration', (getHarness) => {
            let harness;

            before(() => {
                harness = getHarness();
            });

            it('should configure and start adapter', function () {
                return new Promise(async (resolve, reject) => {
                    try {
                        harness = getHarness();
                        
                        // Get adapter object using promisified pattern
                        const obj = await new Promise((res, rej) => {
                            harness.objects.getObject('system.adapter.your-adapter.0', (err, o) => {
                                if (err) return rej(err);
                                res(o);
                            });
                        });
                        
                        if (!obj) {
                            return reject(new Error('Adapter object not found'));
                        }

                        // Configure adapter properties
                        Object.assign(obj.native, {
                            position: TEST_COORDINATES,
                            createCurrently: true,
                            createHourly: true,
                            createDaily: true,
                            // Add other configuration as needed
                        });

                        // Set the updated configuration
                        harness.objects.setObject(obj._id, obj);

                        console.log('✅ Step 1: Configuration written, starting adapter...');
                        
                        // Start adapter and wait
                        await harness.startAdapterAndWait();
                        
                        console.log('✅ Step 2: Adapter started');

                        // Wait for adapter to process data
                        const waitMs = 15000;
                        await wait(waitMs);

                        console.log('🔍 Step 3: Checking states after adapter run...');
                        
                        // Check for expected states (customize based on adapter)
                        const states = await harness.states.getStateKeys('*');
                        console.log(`📊 Found ${states.length} states created by adapter`);
                        
                        if (states.length > 0) {
                            console.log('✅ SUCCESS: Adapter created expected states');
                            resolve();
                        } else {
                            reject(new Error('No states were created by the adapter'));
                        }
                        
                    } catch (error) {
                        console.error('❌ ERROR in test:', error.message);
                        reject(error);
                    }
                });
            }).timeout(30000);
        });
    }
});
```

### Camera Testing with Mock Data

For ONVIF camera adapters, create mock camera responses for testing without physical hardware:

```javascript
// Create test/fixtures/camera-responses.json with sample ONVIF responses
const mockCameraData = {
  discovery: {
    address: '192.168.1.100',
    port: 80,
    xaddrs: 'http://192.168.1.100:80/onvif/device_service',
    name: 'Test Camera',
    hardware: 'Mock Camera Hardware'
  },
  capabilities: {
    media: true,
    ptz: true,
    events: true,
    imaging: true
  },
  profiles: [
    {
      name: 'Profile_1',
      token: 'MediaProfile_Channel1_MainStream',
      videoSource: 'VideoSource_1',
      encoder: 'VideoEncoder_1'
    }
  ]
};
```

## Logging and Debugging

### ioBroker Logging Levels
- `this.log.error()` - Critical errors that prevent adapter function
- `this.log.warn()` - Warnings about recoverable issues
- `this.log.info()` - Important status information
- `this.log.debug()` - Detailed debugging information
- `this.log.silly()` - Verbose debugging (rarely used)

### ONVIF-Specific Logging
```javascript
// Good logging for camera operations
this.log.info(`Discovered camera at ${address}:${port} (${name})`);
this.log.debug(`Camera capabilities: ${JSON.stringify(capabilities)}`);
this.log.warn(`Failed to connect to camera ${address}, retrying...`);
this.log.error(`Authentication failed for camera ${address}: ${error.message}`);
```

## Error Handling

### Connection Management
Always implement proper connection cleanup and error recovery:

```javascript
async unload(callback) {
  try {
    // Stop discovery
    if (this.discovery) {
      this.discovery.stop();
      this.discovery = null;
    }
    
    // Close camera connections
    if (this.cameras) {
      for (const [address, cam] of Object.entries(this.cameras)) {
        try {
          cam.removeAllListeners();
          // Clean close camera connection if method exists
          if (cam.close) cam.close();
        } catch (e) {
          this.log.warn(`Error closing camera ${address}: ${e.message}`);
        }
      }
      this.cameras = {};
    }
    
    // Clear any timers
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
    }
    // Close connections, clean up resources
    callback();
  } catch (e) {
    callback();
  }
}
```

## Code Style and Standards

- Follow JavaScript/TypeScript best practices
- Use async/await for asynchronous operations
- Implement proper resource cleanup in `unload()` method
- Use semantic versioning for adapter releases
- Include proper JSDoc comments for public methods

## CI/CD and Testing Integration

### GitHub Actions for API Testing
For adapters with external API dependencies, implement separate CI/CD jobs:

```yaml
# Tests API connectivity with demo credentials (runs separately)
demo-api-tests:
  if: contains(github.event.head_commit.message, '[skip ci]') == false
  
  runs-on: ubuntu-22.04
  
  steps:
    - name: Checkout code
      uses: actions/checkout@v4
      
    - name: Use Node.js 20.x
      uses: actions/setup-node@v4
      with:
        node-version: 20.x
        cache: 'npm'
        
    - name: Install dependencies
      run: npm ci
      
    - name: Run demo API tests
      run: npm run test:integration-demo
```

### CI/CD Best Practices
- Run credential tests separately from main test suite
- Use ubuntu-22.04 for consistency
- Don't make credential tests required for deployment
- Provide clear failure messages for API connectivity issues
- Use appropriate timeouts for external API calls (120+ seconds)

### Package.json Script Integration
Add dedicated script for credential testing:
```json
{
  "scripts": {
    "test:integration-demo": "mocha test/integration-demo --exit"
  }
}
```

### Practical Example: Complete API Testing Implementation
Here's a complete example based on lessons learned from the Discovergy adapter:

#### test/integration-demo.js
```javascript
const path = require("path");
const { tests } = require("@iobroker/testing");

// Helper function to encrypt password using ioBroker's encryption method
async function encryptPassword(harness, password) {
    const systemConfig = await harness.objects.getObjectAsync("system.config");
    
    if (!systemConfig || !systemConfig.native || !systemConfig.native.secret) {
        throw new Error("Could not retrieve system secret for password encryption");
    }
    
    const secret = systemConfig.native.secret;
    let result = '';
    for (let i = 0; i < password.length; ++i) {
        result += String.fromCharCode(secret[i % secret.length].charCodeAt(0) ^ password.charCodeAt(i));
    }
    
    return result;
}

// Run integration tests with demo credentials
tests.integration(path.join(__dirname, ".."), {
    defineAdditionalTests({ suite }) {
        suite("API Testing with Demo Credentials", (getHarness) => {
            let harness;
            
            before(() => {
                harness = getHarness();
            });

            it("Should connect to API and initialize with demo credentials", async () => {
                console.log("Setting up demo credentials...");
                
                if (harness.isAdapterRunning()) {
                    await harness.stopAdapter();
                }
                
                const encryptedPassword = await encryptPassword(harness, "demo_password");
                
                await harness.changeAdapterConfig("your-adapter", {
                    native: {
                        username: "demo@provider.com",
                        password: encryptedPassword,
                        // other config options
                    }
                });

                console.log("Starting adapter with demo credentials...");
                await harness.startAdapter();
                
                // Wait for API calls and initialization
                await new Promise(resolve => setTimeout(resolve, 60000));
                
                const connectionState = await harness.states.getStateAsync("your-adapter.0.info.connection");
                
                if (connectionState && connectionState.val === true) {
                    console.log("✅ SUCCESS: API connection established");
                    return true;
                } else {
                    throw new Error("API Test Failed: Expected API connection to be established with demo credentials. " +
                        "Check logs above for specific API errors (DNS resolution, 401 Unauthorized, network issues, etc.)");
                }
            }).timeout(120000);
        });
    }
});
```

## JSON-Config Management

### Admin Interface Configuration
ioBroker adapters use JSON-based configuration. For the admin interface:

```javascript
// Proper state creation with JSON config support
await this.extendObject('camera.settings', {
  type: 'state',
  common: {
    name: 'Camera Settings',
    type: 'object',
    role: 'config',
    read: true,
    write: true
  },
  native: {}
});
```

### Configuration Schema Validation
Always validate configuration before using:

```javascript
// Example configuration validation for ONVIF adapter
validateConfig(config) {
  const errors = [];
  
  if (!config.user || config.user.trim() === '') {
    errors.push('Username is required for camera authentication');
  }
  
  if (!config.password || config.password.trim() === '') {
    errors.push('Password is required for camera authentication');
  }
  
  if (config.serverPort && (isNaN(config.serverPort) || config.serverPort < 1024 || config.serverPort > 65535)) {
    errors.push('Server port must be between 1024 and 65535');
  }
  
  return errors;
}
```

## State Management

### Proper State Creation
Always use proper state structure for ioBroker:

```javascript
// Camera state creation pattern
await this.extendObject(`cameras.${cameraId}.info.connection`, {
  type: 'state',
  common: {
    name: 'Connection Status',
    type: 'boolean',
    role: 'indicator.connected',
    read: true,
    write: false
  },
  native: {}
});

// PTZ control states
await this.extendObject(`cameras.${cameraId}.ptz.preset`, {
  type: 'state',
  common: {
    name: 'Go to Preset Position',
    type: 'string',
    role: 'button',
    read: true,
    write: true,
    def: '1'
  },
  native: {}
});
```

## Message Handling

### Proper Message Box Implementation
For adapters that need to handle messages:

```javascript
async onMessage(obj) {
  if (typeof obj === 'object' && obj.message) {
    switch (obj.command) {
      case 'discovery':
        try {
          const cameras = await this.performDiscovery();
          this.sendTo(obj.from, obj.command, { result: cameras }, obj.callback);
        } catch (error) {
          this.sendTo(obj.from, obj.command, { error: error.message }, obj.callback);
        }
        break;
        
      case 'testConnection':
        try {
          const result = await this.testCameraConnection(obj.message.ip, obj.message.port, obj.message.user, obj.message.password);
          this.sendTo(obj.from, obj.command, { result }, obj.callback);
        } catch (error) {
          this.sendTo(obj.from, obj.command, { error: error.message }, obj.callback);
        }
        break;
    }
  }
}
```

## Performance and Resource Management

### Memory Management for Camera Streams
When working with camera streams and images:

```javascript
// Proper memory management for snapshot handling
async takeSnapshot(cameraId) {
  let buffer = null;
  try {
    buffer = await this.cameras[cameraId].getSnapshot();
    
    // Process the buffer
    await this.setState(`cameras.${cameraId}.snapshot`, buffer);
    
  } catch (error) {
    this.log.error(`Failed to take snapshot from ${cameraId}: ${error.message}`);
  } finally {
    // Clean up buffer reference
    buffer = null;
  }
}
```

### Connection Pooling
Implement connection pooling for multiple cameras:

```javascript
constructor(options) {
  super(options);
  this.cameras = new Map(); // Use Map for better performance
  this.connectionPool = new Map();
  this.maxConcurrentConnections = 5;
}

async initCamera(cameraConfig) {
  const key = `${cameraConfig.ip}:${cameraConfig.port}`;
  
  if (this.connectionPool.size >= this.maxConcurrentConnections) {
    // Wait for available slot or implement queue
    await this.waitForConnectionSlot();
  }
  
  const camera = new Cam(cameraConfig, (err) => {
    if (err) {
      this.connectionPool.delete(key);
      throw err;
    }
  });
  
  this.connectionPool.set(key, camera);
  return camera;
}
```