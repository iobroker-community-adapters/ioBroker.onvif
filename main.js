"use strict";

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const { request } = require("urllib");
const Json2iob = require("json2iob");
const Cam = require("onvif").Cam;
const xml2js = require("xml2js");
const Discovery = require("onvif").Discovery;
const { promisify } = require("util");

class Onvif extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: "onvif",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.deviceArray = [];
    this.devices = {};
    this.discoveredDevices = [];
    this.json2iob = new Json2iob(this);
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    await this.cleanOldVersion();

    this.subscribeStates("*");

    const adapterDevices = await this.getDevicesAsync();
    for (const device of adapterDevices) {
      this.log.info(`Found Adapter Device: ${device._id} ${device.common.name}`);
      this.log.debug("Device: " + JSON.stringify(device));
      const camObj = await this.initDevice({
        ip: device.native.ip,
        port: device.native.port,
        username: device.native.user,
        password: device.native.password,
      })
        .then(async (cam) => {
          this.log.info("Device successful initialized: " + cam.hostname + ":" + cam.port);
          return cam;
        })
        .catch(async (err) => {
          this.log.error(`Error initializing device: ${err} device: ${JSON.stringify(device.native)}`);
          this.log.error(`You can change user and password under object and edit device or delete device under objects and restart adapter`);
          this.log.error(err.stack);
          return null;
        });
      if (camObj) {
        this.devices[camObj.hostname] = camObj;
        await this.setObjectNotExistsAsync(device.native.id + ".events", {
          type: "channel",
          common: {
            name: "Camera Events",
          },
          native: {},
        });
        camObj.on("event", this.processEvent.bind(this, device));
        this.devices[camObj.hostname] = camObj;
      }
    }

    this.log.info("Start onvif discovery");
    await this.discovery();
    this.log.info("Finished onvif discovery");
  }
  async processEvent(device, event) {
    this.log.debug(`Received event: ${JSON.stringify(event)}`);
    const id = event.topic._.split(":")[1];
    let value = event.message.message.data.simpleItem.$.Value;
    const name = event.message.message.data.simpleItem.$.Name;
    if (typeof value === "object") {
      value = JSON.stringify(value);
    }
    await this.extendObjectAsync(device.native.id + ".events." + id, {
      type: "state",
      common: {
        name: name,
        type: typeof value,
        role: "indicator",
        read: true,
        write: false,
      },
      native: {},
    });
    await this.setStateAsync(device.native.id + ".events." + id, value, true);
  }
  async discovery() {
    Discovery.on("device", (cam, rinfo, xml) => {
      // Function will be called as soon as the NVT responses

      // Parsing of Discovery responses taken from my ONVIF-Audit project, part of the 2018 ONVIF Open Source Challenge
      // Filter out xml name spaces
      xml = xml.replace(/xmlns([^=]*?)=(".*?")/g, "");

      const parser = new xml2js.Parser({
        attrkey: "attr",
        charkey: "payload", // this ensures the payload is called .payload regardless of whether the XML Tags have Attributes or not
        explicitCharkey: true,
        tagNameProcessors: [xml2js.processors.stripPrefix], // strip namespace eg tt:Data -> Data
      });
      parser.parseString(xml, async (err, result) => {
        if (err) {
          return;
        }
        let scopeObject = { name: "", hardware: "" };
        let xaddrs = "";
        let urn = "";

        try {
          urn = result["Envelope"]["Body"][0]["ProbeMatches"][0]["ProbeMatch"][0]["EndpointReference"][0]["Address"][0].payload;
          xaddrs = result["Envelope"]["Body"][0]["ProbeMatches"][0]["ProbeMatch"][0]["XAddrs"][0].payload;
          let scopes = result["Envelope"]["Body"][0]["ProbeMatches"][0]["ProbeMatch"][0]["Scopes"][0].payload;
          scopes = scopes.split(" ");

          try {
            for (let i = 0; i < scopes.length; i++) {
              const scopeArray = scopes[i].split("/");

              const value = decodeURIComponent(scopeArray[4]);
              if (scopeArray.length <= 5) {
                if (scopeObject[scopeArray[3]]) {
                  if (Array.isArray(scopeObject[scopeArray[3]])) {
                    scopeObject[scopeArray[3]].push(value);
                    continue;
                  }
                  const array = [scopeArray[3]];
                  array.push(value);
                  scopeObject[scopeArray[3]] = array;
                } else {
                  scopeObject[scopeArray[3]] = value;
                }
              } else {
                const valueFinal = decodeURIComponent(scopeArray[5]);
                if (scopeObject[scopeArray[3]]) {
                  scopeObject[scopeArray[3]][value] = valueFinal;
                } else {
                  scopeObject[scopeArray[3]] = {};
                  scopeObject[scopeArray[3]][value] = valueFinal;
                }
              }
            }
          } catch (error) {
            this.log.error("Error parsing scopes: " + error);
            this.log.error(error.stack);
          }
        } catch (error) {
          this.log.warn("Skip parsing xml: " + error);
          this.log.warn(xml);
        }
        this.discoveredDevices.push(scopeObject.name + "_" + rinfo.address);
        this.log.info(`Discovery Reply from ${rinfo.address} (${scopeObject.name}) (${scopeObject.hardware}) (${xaddrs}) (${urn})`);
        if (this.devices[rinfo.address]) {
          this.log.info(
            `Skip device ${rinfo.address} because it is already configured via iobroker object. Delete the device under objects for reconfigure.`
          );
          return;
        }

        this.log.info(`Try to login to ${rinfo.address}:${cam.port}` + " with " + this.config.user + ":" + this.config.password);
        await this.initDevice({
          ip: rinfo.address,
          port: cam.port,
          username: this.config.user,
          password: this.config.password,
        })
          .then(async (cam) => {
            this.log.info("Device successful initialized: " + cam.hostname + ":" + cam.port);
            const native = await this.fetchCameraInfos(cam, rinfo);
            this.devices[cam.hostname] = cam;
            cam.on("event", this.processEvent.bind(this, { native: native }));
          })
          .catch((err) => {
            this.log.error(`Failed to login to ${rinfo.address}:${cam.port}` + " with " + this.config.user + ":" + this.config.password);
            this.log.error("Error " + err);
            this.log.debug(err.stack);
          });
      });
    });
    Discovery.on("error", (err, xml) => {
      // The ONVIF library had problems parsing some XML
      this.log.error("Discovery error " + err);
      this.log.error(xml);
    });
    await promisify(Discovery.probe)().catch((err) => {
      this.log.error("Error during discovery: " + err);
    });
  }
  async fetchCameraInfos(cam, rinfo) {
    const timeDate = await promisify(cam.getSystemDateAndTime)
      .bind(cam)()
      .catch((e) => {
        this.log.error(e);
      });
    const deviceInformation = await promisify(cam.getDeviceInformation)
      .bind(cam)()
      .catch((e) => {
        this.log.error(e);
      });
    const deviceProfiles = await promisify(cam.getProfiles)
      .bind(cam)()
      .catch((e) => {
        this.log.error(e);
      });
    const deviceCapabilities = await promisify(cam.getCapabilities)
      .bind(cam)()
      .catch((e) => {
        this.log.error(e);
      });
    const deviceServices = await promisify(cam.getServices)
      .bind(cam)(true)
      .catch((e) => {
        this.log.error(e);
      });
    const deviceServicesCapabilities = await promisify(cam.getServiceCapabilities)
      .bind(cam)()
      .catch((e) => {
        this.log.error(e);
      });
    const scopes = await promisify(cam.getScopes)
      .bind(cam)()
      .catch((e) => {
        this.log.error(e);
      });
    const videoSources = await promisify(cam.getVideoSources)
      .bind(cam)()
      .catch((e) => {
        this.log.error(e);
      });
    const status = await promisify(cam.getStatus)
      .bind(cam)()
      .catch((e) => {
        this.log.error(e);
      });
    const presets = await promisify(cam.getPresets)
      .bind(cam)()
      .catch((e) => {
        this.log.warn(`No presets found for ${cam.hostname}:${cam.port} ${e}`);
      });
    let snapshotUrl;
    const streamUris = {};
    //find image urls for each profile
    for (const profile of deviceProfiles) {
      streamUris[profile.name] = {};
      streamUris[profile.name].snapshotUrl = await promisify(cam.getSnapshotUri)
        .bind(cam)({ ProfileToken: profile.$.token })
        .catch((e) => {
          this.log.error(`${cam.hostname}:${cam.port} Error getting snapshot url: ${e}`);
        });
      if (!snapshotUrl && streamUris[profile.name].snapshotUrl) {
        snapshotUrl = streamUris[profile.name].snapshotUrl.uri;
      }
      streamUris[profile.name].live_stream_tcp = await promisify(cam.getStreamUri)
        .bind(cam)({
          protocol: "RTSP",
          stream: "RTP-Unicast",
          ProfileToken: profile.$.token,
        })
        .catch((e) => {
          this.log.error(`${cam.hostname}:${cam.port} Error getting livestream tcp url: ${e}`);
        });
      streamUris[profile.name].live_stream_udp = await promisify(cam.getStreamUri)
        .bind(cam)({
          protocol: "UDP",
          stream: "RTP-Unicast",
          ProfileToken: profile.$.token,
        })
        .catch((e) => {
          this.log.error(`${cam.hostname}:${cam.port} Error getting livestream udp url: ${e}`);
        });
      streamUris[profile.name].live_stream_multicast = await promisify(cam.getStreamUri)
        .bind(cam)({
          protocol: "UDP",
          stream: "RTP-Multicast",
          ProfileToken: profile.$.token,
        })
        .catch((e) => {
          this.log.error(`${cam.hostname}:${cam.port} Error getting livestream udp multi url: ${e}`);
        });
      streamUris[profile.name].http_stream = await promisify(cam.getStreamUri)
        .bind(cam)({
          protocol: "HTTP",
          stream: "RTP-Unicast",
          ProfileToken: profile.$.token,
        })
        .catch((e) => {
          this.log.error(`${cam.hostname}:${cam.port} Error getting livestream http url: ${e}`);
        });
    }

    const id = `${cam.hostname}_${cam.port}`.replace(/\./g, "_");
    let name = deviceInformation.manufacturer || "";
    name += " " + deviceInformation.model || "";
    name += " " + cam.hostname + ":" + cam.port;

    const native = {
      id: id,
      name: name,
      ip: rinfo.address,
      port: cam.port,
      hostname: cam.hostname,
      user: cam.username,
      password: cam.password,
      snapshotUrl: snapshotUrl,
    };

    await this.extendObjectAsync(id, {
      type: "device",
      common: {
        name: name,
      },
      native: native,
    });
    await this.setObjectNotExistsAsync(id + ".events", {
      type: "channel",
      common: {
        name: "Camera Events. If empty trigger the event on the camera",
      },
      native: {},
    });
    await this.setObjectNotExistsAsync(id + ".remote", {
      type: "channel",
      common: {
        name: "Remote Controls",
      },
      native: {},
    });
    await this.setObjectNotExistsAsync(id + ".infos", {
      type: "channel",
      common: {
        name: "Infos via ONVIF",
      },
      native: {},
    });

    const remoteArray = [
      { command: "Refresh", name: "True = Refresh" },
      { command: "snapshot", name: "True = Switch On, False = Switch Off" },
      { command: "gotoPreset", name: "PTZ preset", type: "number", role: "level", def: 0 },
      { command: "gotoHomePosition", name: "Goto Home Position" },
    ];
    remoteArray.forEach((remote) => {
      this.setObjectNotExists(id + ".remote." + remote.command, {
        type: "state",
        common: {
          name: remote.name || "",
          type: remote.type || "boolean",
          role: remote.role || "button",
          def: remote.def != null ? remote.def : false,
          write: true,
          read: true,
        },
        native: {},
      });
    });

    this.json2iob.parse(id + ".general", cam, {
      forceIndex: true,
      removePasswords: true,
      channelName: "General Information",
    });
    this.json2iob.parse(id + ".infos.timeDate", timeDate, { forceIndex: true, channelName: "Time Date" });
    this.json2iob.parse(id + ".infos.presets", presets, { forceIndex: true, channelName: "Presets of active source" });
    this.json2iob.parse(id + ".infos.deviceInformation", deviceInformation, {
      forceIndex: true,
      channelName: "Device Information",
    });
    this.json2iob.parse(id + ".infos.deviceProfiles", deviceProfiles, {
      forceIndex: true,
      channelName: "Device Profiles",
    });
    this.json2iob.parse(id + ".infos.deviceCapabilities", deviceCapabilities, {
      forceIndex: true,
      channelName: "Device Capabilities",
    });
    this.json2iob.parse(id + ".infos.deviceServices", deviceServices, {
      forceIndex: true,
      channelName: "Device Services",
    });
    this.json2iob.parse(id + ".infos.deviceServicesCapabilities", deviceServicesCapabilities, {
      forceIndex: true,
      channelName: "Device Services Capabilities",
    });
    this.json2iob.parse(id + ".infos.scopes", scopes, { forceIndex: true, channelName: "Scopes" });
    this.json2iob.parse(id + ".infos.videoSources", videoSources, { forceIndex: true, channelName: "Video Sources" });
    this.json2iob.parse(id + ".infos.status", status, { forceIndex: true, channelName: "Status" });
    this.json2iob.parse(id + ".infos.streamUris", streamUris, { forceIndex: true, channelName: "Stream Uris" });
    return native;
  }

  async initDevice(device) {
    return new Promise((resolve, reject) => {
      new Cam(
        {
          hostname: device.ip,
          username: device.username,
          password: device.password,
          port: device.port,
          timeout: 5000,
        },
        function (err) {
          if (err) {
            reject(err);
          }
          // @ts-ignore
          resolve(this);
        }
      );
    });
  }
  async getSnapshot(id) {
    const deviceObject = await this.getObjectAsync(id);
    if (!deviceObject || !deviceObject.native || !deviceObject.native.snapshotUrl) {
      this.log.warn("No snapshot url found for " + id);
      return;
    }
    const snapshotUrl = deviceObject.native.snapshotUrl;
    const response = await request(snapshotUrl, {
      method: "GET",
      auth: `${deviceObject.native.user}:${deviceObject.native.password}`,
    })
      .then(async (response) => {
        if (response.status === 401) {
          //if basic auth fails try digest auth
          return await request(snapshotUrl, {
            method: "GET",
            digestAuth: `${deviceObject.native.user}:${deviceObject.native.password}`,
          })
            .then((response) => {
              if (response.status >= 400) {
                this.log.error("Error getting snapshot via digest: " + response);
                return;
              }
              return response.data;
            })
            .catch((e) => {
              this.log.error("Error getting snapshot via basic: " + e);
            });
        }
        if (response.status >= 400) {
          this.log.error("Error getting snapshot basic: " + response);
          return;
        }
        return response.data;
      })
      .catch((e) => {
        this.log.error("Error getting snapshot: " + e);
      });
    return response;
  }

  async manualSearch(options) {
    try {
      const ipRange = this.generateRange(options.startIp, options.endIp);
      const devices = [];
      const portArray = options.port.replace(/\s/g, "").split(",");
      for (const ip of ipRange) {
        for (const port of portArray) {
          const deviceName = await this.initDevice({
            ip: ip,
            port: port,
            username: options.user,
            password: options.password,
          })
            .then(async (cam) => {
              this.log.info("Device successful initialized: " + cam.hostname + ":" + cam.port);
              const native = await this.fetchCameraInfos(cam, { address: cam.ip });
              this.devices[cam.hostname] = cam;
              cam.on("event", this.processEvent.bind(this, { native: native }));
              return native.name;
            })
            .catch((err) => {
              this.log.error(`Failed to login to ${ip}:${port}` + " with " + options.user + ":" + options.password);
              this.log.info("Error " + err);
              this.log.debug(err.stack);
              return;
            });

          deviceName && devices.push(deviceName);
        }
      }
      return devices;
    } catch (e) {
      this.log.error("Error searching for devices: " + e);
      return;
    }
  }
  async cleanOldVersion() {
    const cleanOldVersion = await this.getObjectAsync("oldVersionCleaned");
    if (!cleanOldVersion) {
      this.log.info("Clean old version devices");

      await this.delObjectAsync("", { recursive: true });
      await this.setObjectNotExistsAsync("oldVersionCleaned", {
        type: "state",
        common: {
          name: "oldVersionCleaned",
          type: "boolean",
          role: "indicator",
          write: false,
          read: true,
        },
        native: {},
      });
      this.log.info("Done with cleaning");
      return true;
    }
  }
  generateRange(startIp, endIp) {
    let startLong = this.toLong(startIp);
    let endLong = this.toLong(endIp);
    if (startLong > endLong) {
      const tmp = startLong;
      startLong = endLong;
      endLong = tmp;
    }
    const rangeArray = [];
    let i;
    for (i = startLong; i <= endLong; i++) {
      rangeArray.push(this.fromLong(i));
    }
    return rangeArray;
  }

  //toLong taken from NPM package 'ip'
  toLong(ip) {
    let ipl = 0;
    ip.split(".").forEach(function (octet) {
      ipl <<= 8;
      ipl += parseInt(octet);
    });
    return ipl >>> 0;
  }

  //fromLong taken from NPM package 'ip'
  fromLong(ipl) {
    return (ipl >>> 24) + "." + ((ipl >> 16) & 255) + "." + ((ipl >> 8) & 255) + "." + (ipl & 255);
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      callback();
    } catch (e) {
      callback();
    }
  }
  async onMessage(obj) {
    if (typeof obj === "object" && obj.message) {
      if (obj.command === "send") {
        // e.g. send email or pushover or whatever
        console.log("send command");
      }
      if (obj.command === "discover") {
        this.log.debug(`discover for ${obj.message}`);
        this.config.user = obj.message.user;
        this.config.password = obj.message.password;
        this.discoveredDevices = [];
        this.log.info("Starting discovery");
        await promisify(Discovery.probe)().catch((err) => {
          this.log.error("Error during discovery: " + err);
          this.sendTo(obj.from, obj.command, { error: `Discovery failed` }, obj.callback);
          return;
        });
        this.log.info("Discovery finished");
        this.log.info(`Found ${this.discoveredDevices.length} cameras: ${JSON.stringify(this.discoveredDevices, null, 2)}`);
        obj.callback &&
          this.sendTo(
            obj.from,
            obj.command,
            {
              result: `Found ${this.discoveredDevices.length} cameras: ${JSON.stringify(this.discoveredDevices, null, 2)}. See log for details`,
            },
            obj.callback
          );
      }
      if (obj.command === "manualSearch") {
        this.log.debug(`manualSearch for ${JSON.stringify(obj.message)}`);
        this.log.info("Starting manual search");
        const deviceArray = (await this.manualSearch(obj.message)) || [];
        this.log.info("Manual search finished");
        this.log.info("Found devices: " + deviceArray);
        obj.callback &&
          this.sendTo(
            obj.from,
            obj.command,
            { result: `Found ${deviceArray.length} cameras: ${JSON.stringify(deviceArray, null, 2)}` },
            obj.callback
          );
      }
      if (obj.command === "snapshot") {
        this.log.debug(`snapshot for ${obj.message}`);
        const snapshot = await this.getSnapshot(obj.message);
        if (snapshot) {
          this.sendTo(obj.from, obj.command, snapshot, obj.callback);
        }
      }
      if (obj.command === "getSnapshot") {
        this.log.debug(`getSnapshot for ${obj.message}`);
        if (!obj.message.id) {
          this.log.error("No id found for getSnapshot");
          return;
        }
        const snapshot = await this.getSnapshot(obj.message.id);
        if (snapshot) {
          this.sendTo(obj.from, obj.command, { img: { rawImage: snapshot } }, obj.callback);
        }
      }
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        const deviceId = id.split(".")[2];
        const folder = id.split(".")[3];
        if (folder != "remote") {
          return;
        }
        const command = id.split(".")[4];
        const deviceObject = await this.getObjectAsync(deviceId);
        if (!deviceObject || !deviceObject.native || !deviceObject.native.ip) {
          this.log.warn("No ip found for " + deviceId);
          return;
        }
        const cam = this.devices[deviceObject.native.ip];
        if (command === "Refresh") {
          this.fetchCameraInfos(cam, { address: deviceObject.native.ip });
          return;
        }
        if (command === "snapshot") {
          const snapshot = await this.getSnapshot(deviceId);
          if (snapshot) {
            await this.setObjectNotExistsAsync(deviceId + ".snapshot", {
              type: "state",
              common: {
                name: "Snapshot",
                type: "string",
                role: "image",
                read: true,
                write: false,
              },
              native: {},
            });
            await this.setStateAsync(deviceId + ".snapshot", `data:image/jpg;base64,${Buffer.from(snapshot).toString("base64")}`, true);
            this.log.info(`Snapshot saved in state ${deviceId}.snapshot`);
          }
          return;
        }

        if (command === "gotoPreset") {
          await promisify(cam[command])
            .bind(cam)({ preset: state.val })
            .then((res) => {
              this.log.info(`Result of command ${command} on device ${deviceId}: ${JSON.stringify(res)}`);
            })
            .catch((e) => {
              this.log.error(`Error while executing command ${command} on device ${deviceId}: ${e}`);
            });
          return;
        }

        await promisify(cam[command])
          .bind(cam)({})
          .then((res) => {
            this.log.info(`Result of command ${command} on device ${deviceId}: ${JSON.stringify(res)}`);
          })
          .catch((e) => {
            this.log.error(`Error while executing command ${command} on device ${deviceId}: ${e}`);
          });
      }
    }
  }
}
if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Onvif(options);
} else {
  // otherwise start the instance directly
  new Onvif();
}
