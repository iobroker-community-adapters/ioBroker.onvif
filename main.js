"use strict";

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const { request } = require("urllib");
const Json2iob = require("json2iob");
const Cam = require("./lib/onvif").Cam;
const xml2js = require("xml2js");
const Discovery = require("./lib/onvif").Discovery;
const { promisify } = require("util");
const http = require("http");

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
    this.deviceArrayManualSearch = [];
    this.deviceNatives = {};
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
      if (!device.native.ip) {
        this.log.error(`Device ${device.common.name} has no ip address, please delete device and rediscover the camera`);
        device.native.ip = device.native.hostname;
      }
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
        .catch(async (error) => {
          this.log.error(`Data: ${error.data} XML: ${error.xml}`);
          this.log.error(`Error initializing device: ${error.err} device: ${JSON.stringify(device.native)}`);
          this.log.error(
            `You can change user and password under object and edit device or delete device under objects and restart adapter`,
          );
          this.log.error(error.err.stack);
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
        const native = await this.fetchCameraInfos(camObj, { address: device.native.ip });
        this.deviceNatives[device.native.id] = native;
      }
    }

    this.log.info("Start onvif discovery");
    await this.discovery();
    this.log.info("Finished onvif discovery");
    if (this.config.activateServer) {
      this.log.info("Starting snapshot server");
      await this.startServer();
    }
    //reconnnect all cameras every 30min to prevent undetected disconnects and event lost
    this.reconnectInterval = this.setInterval(() => {
      this.reconnectAllCameras();
    }, 1000 * 30 * 60);
  }

  async reconnectAllCameras() {
    for (const deviceId in this.deviceNatives) {
      const camNative = this.deviceNatives[deviceId];
      this.log.debug(`Reconnecting to ${deviceId}`);
      let cam = this.devices[camNative.ip];
      if (!cam) {
        cam = await this.devices[camNative.hostname];
      }
      if (!cam) {
        this.log.info(`No cam found for ${deviceId}`);
        continue;
      }
      await promisify(cam.connect)
        .bind(cam)()
        .then(() => {
          this.setStateAsync(deviceId + ".connection", true, true);
        })
        .catch((e) => {
          this.setStateAsync(deviceId + ".connection", false, true);
          this.log.error(e);
        });

      // cam.removeListener("event", this.processEvent.bind(this, camNative));
      // cam.on("event", this.processEvent.bind(this, camNative));
    }
  }

  async startServer() {
    this.server = http.createServer(async (req, res) => {
      try {
        const camId = req.url.split("/")[1].split("?")[0];
        const native = this.deviceNatives[camId];
        if (native) {
          const image = await this.getSnapshot(camId);
          if (image != null) {
            res.writeHead(200, { "Content-Type": "image/jpg" });
            res.write(image);
            res.end();
          } else {
            res.writeHead(500);
            res.end();
          }
        } else {
          res.writeHead(404);
          res.write("No camera found");
          res.end();
        }
      } catch (error) {
        this.log.error(error);
        res.writeHead(500);
        res.end();
        this.log.error(error.stack);
      }
    });
    try {
      this.server.listen(this.config.serverPort);
    } catch (error) {
      this.log.error(`Error starting server: ${error} check port: ${this.config.serverPort} is not used by other application`);
    }
  }
  async processEvent(device, event) {
    this.log.debug(`Received event: ${JSON.stringify(event)}`);
    if (!event.topic || !event.topic._) {
      this.log.warn("Event without topic: " + JSON.stringify(event));
      this.sendSentry(event);
      return;
    }
    let id = event.topic._.split(":")[1];
    id = id.replace(/\./g, "_");

    if (!event.message) {
      this.log.warn("Event without message: " + JSON.stringify(event));
      this.sendSentry(event);
      return;
    }
    if (event.message.message.source && event.message.message.source.simpleItem) {
      if (Array.isArray(event.message.message.source.simpleItem)) {
        for (const item of event.message.message.source.simpleItem) {
          let sourceName = item.$.Name;
          sourceName = sourceName.replace(/\./g, "_");
          let sourceValue = item.$.Value;
          if (typeof sourceValue === "object") {
            sourceValue = JSON.stringify(sourceValue);
          }
          await this.setEventState(device, id + "_" + sourceName, sourceName, sourceValue);
        }
      } else {
        let sourceName = event.message.message.source.simpleItem.$.Name;
        let sourceValue = event.message.message.source.simpleItem.$.Value;
        sourceName = sourceName.replace(/\./g, "_");
        if (typeof sourceValue === "object") {
          sourceValue = JSON.stringify(sourceValue);
        }
        await this.setEventState(device, id, sourceName, sourceValue);
      }
    }
    if (event.message.message.data && event.message.message.data.simpleItem) {
      if (Array.isArray(event.message.message.data.simpleItem)) {
        for (const item of event.message.message.data.simpleItem) {
          let sourceName = item.$.Name;
          sourceName = sourceName.replace(/\./g, "_");
          let sourceValue = item.$.Value;
          if (typeof sourceValue === "object") {
            sourceValue = JSON.stringify(sourceValue);
          }
          await this.setEventState(device, id + "_" + sourceName, sourceName, sourceValue);
        }
      } else {
        let value = event.message.message.data.simpleItem.$.Value;
        let name = event.message.message.data.simpleItem.$.Name;
        name = name.replace(/\./g, "_");
        if (typeof value === "object") {
          value = JSON.stringify(value);
        }
        await this.setEventState(device, id, name, value);
      }
    } else if (event.message.message.data && event.message.message.data.elementItem) {
      const dataName = "elementItem";
      const dataValue = JSON.stringify(event.message.message.data.elementItem);
      await this.setEventState(device, id, dataName, dataValue);
    } else {
      this.log.warn("Event without event.message.message.data.simpleItem.$: " + JSON.stringify(event));
      this.sendSentry(event);
      return;
    }
  }
  async setEventState(device, id, name, value) {
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

  sendSentry(event) {
    if (this.supportsFeature && this.supportsFeature("PLUGINS")) {
      const sentryInstance = this.getPluginInstance("sentry");
      if (sentryInstance) {
        const Sentry = sentryInstance.getSentryObject();
        Sentry && Sentry.captureMessage("Wrong Event", { extra: { message: JSON.stringify(event) }, level: "info" });
      }
    }
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
        const scopeObject = { name: "", hardware: "" };
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
          this.log.warn("Skip parsing " + JSON.stringify(rinfo) + " xml: " + error);
          this.log.warn(xml);
        }
        this.log.info(`Discovery Reply from ${rinfo.address} (${scopeObject.name}) (${scopeObject.hardware}) (${xaddrs}) (${urn})`);
        if (this.devices[rinfo.address]) {
          this.log.info(
            `Skip device ${rinfo.address} because it is already configured via iobroker object. Delete the device under objects for reconfigure.`,
          );
          return;
        }

        this.log.info(
          `Try to login to ${rinfo.address}:${cam.port}` + " with " + this.config.user + ":" + this.maskPassword(this.config.password),
        );
        await this.initDevice({
          ip: rinfo.address,
          port: cam.port,
          username: this.config.user,
          password: this.config.password,
        })
          .then(async (cam) => {
            this.log.info("Device successful initialized: " + cam.hostname + ":" + cam.port);
            const native = await this.fetchCameraInfos(cam, rinfo);
            this.deviceNatives[native.id] = native;
            this.discoveredDevices.push(native.name);
            this.devices[cam.hostname] = cam;
            cam.on("event", this.processEvent.bind(this, { native: native }));
          })
          .catch((error) => {
            this.log.error(
              `Failed to login to ${rinfo.address}:${cam.port}` +
                " with " +
                this.config.user +
                ":" +
                this.maskPassword(this.config.password),
            );
            this.log.error("Error " + error.err);
            this.log.debug(error.err.stack);
            this.log.info(`Data: ${JSON.stringify(error.data)} xml: ${error.xml}`);
          });
      });
    });
    Discovery.on("error", (err, xml) => {
      // The ONVIF library had problems parsing some XML
      this.log.error("Discovery error " + err);
      this.log.error(xml);
      this.log.error(err.stack);
    });
    await promisify(Discovery.probe)().catch((err) => {
      this.log.error("Error during discovery: " + err);
    });
  }
  async fetchCameraInfos(cam, rinfo) {
    this.log.debug("Fetch camera infos for " + cam.hostname + ":" + cam.port);
    const timeDate = await promisify(cam.getSystemDateAndTime)
      .bind(cam)()
      .catch((e) => {
        this.log.error("Failed to get SystemDateAndTime");
        this.log.error(e);
      });
    const deviceInformation = await promisify(cam.getDeviceInformation)
      .bind(cam)()
      .catch((e) => {
        this.log.error("Failed to get DeviceInformation");
        this.log.error(e);
      });
    const deviceProfiles = await promisify(cam.getProfiles)
      .bind(cam)()
      .catch((e) => {
        this.log.error("Failed to get Profiles");
        this.log.error(e);
      });
    const deviceCapabilities = await promisify(cam.getCapabilities)
      .bind(cam)()
      .catch((e) => {
        this.log.error("Failed to get Capabilities");
        this.log.error(e);
      });
    const deviceServices = await promisify(cam.getServices)
      .bind(cam)(true)
      .catch((e) => {
        this.log.error("Failed to get Services");
        this.log.error(e);
      });
    const deviceServicesCapabilities = await promisify(cam.getServiceCapabilities)
      .bind(cam)()
      .catch((e) => {
        this.log.error("Failed to get ServiceCapabilities");
        this.log.error(e);
      });
    const scopes = await promisify(cam.getScopes)
      .bind(cam)()
      .catch((e) => {
        this.log.error("Failed to get Scopes");
        this.log.error(e);
      });
    const videoSources = await promisify(cam.getVideoSources)
      .bind(cam)()
      .catch((e) => {
        this.log.error("Failed to get VideoSources");
        this.log.error(e);
      });
    const status = await promisify(cam.getStatus)
      .bind(cam)()
      .catch((e, data, xml) => {
        this.log.debug(`Data: ${JSON.stringify(data)} xml: ${xml}`);
        this.log.debug(`No status found for ${cam.hostname}:${cam.port} ${e}`);
      });
    const presets = await promisify(cam.getPresets)
      .bind(cam)()
      .catch((e) => {
        this.log.warn(`No presets found for ${cam.hostname}:${cam.port} ${e}`);
      });
    let snapshotUrl = "";
    let minorStreamUrl = "";
    let majorStreamUrl = "";
    const streamUris = {};
    if (deviceProfiles && deviceProfiles.length > 0) {
      //find image urls for each profile
      for (const profile of deviceProfiles) {
        streamUris[profile.name] = {};
        streamUris[profile.name].snapshotUrl = await promisify(cam.getSnapshotUri)
          .bind(cam)({ ProfileToken: profile.$.token })
          .catch((e) => {
            this.log.warn(
              `${cam.hostname}:${cam.port} ${profile.name} No snapshot url available. Try to get it from the stream url via ffmpeg`,
            );
            this.log.warn(e);
          });
        if (!snapshotUrl && streamUris[profile.name].snapshotUrl) {
          snapshotUrl = streamUris[profile.name].snapshotUrl.uri;
          if (this.config.overwriteSnapshotPort) {
            //find generic port in url and replace it
            try {
              const urlObject = new URL(snapshotUrl);
              urlObject.port = cam.port;
              if (this.config.overwritePort) {
                urlObject.port = this.config.overwritePort;
              }
              snapshotUrl = urlObject.toString();
            } catch (error) {
              this.log.error("Failed to parse snapshot url" + snapshotUrl);
              this.log.error(error);
            }
          }
        }
        streamUris[profile.name].live_stream_tcp = await promisify(cam.getStreamUri)
          .bind(cam)({
            protocol: "RTSP",
            stream: "RTP-Unicast",
            profileToken: profile.$.token,
          })
          .catch((e) => {
            this.log.warn(`${cam.hostname}:${cam.port} No livestream tcp url available: ${e}`);
          });
        streamUris[profile.name].live_stream_udp = await promisify(cam.getStreamUri)
          .bind(cam)({
            protocol: "UDP",
            stream: "RTP-Unicast",
            profileToken: profile.$.token,
          })
          .catch((e) => {
            this.log.warn(`${cam.hostname}:${cam.port} No livestream udp url available: ${e}`);
          });
        streamUris[profile.name].live_stream_multicast = await promisify(cam.getStreamUri)
          .bind(cam)({
            protocol: "UDP",
            stream: "RTP-Multicast",
            profileToken: profile.$.token,
          })
          .catch((e) => {
            this.log.warn(`${cam.hostname}:${cam.port} No livestream udp multi url available: ${e}`);
          });
        streamUris[profile.name].http_stream = await promisify(cam.getStreamUri)
          .bind(cam)({
            protocol: "HTTP",
            stream: "RTP-Unicast",
            profileToken: profile.$.token,
          })
          .catch((e) => {
            this.log.warn(`${cam.hostname}:${cam.port} No livestream http url available: ${e}`);
          });
      }
      for (const profile of deviceProfiles) {
        if (streamUris[profile.name].live_stream_tcp) {
          majorStreamUrl = streamUris[profile.name].live_stream_tcp.uri;
          break;
        }
        if (streamUris[profile.name].live_stream_udp) {
          majorStreamUrl = streamUris[profile.name].live_stream_udp.uri;
          break;
        }
        if (streamUris[profile.name].live_stream_multicast) {
          majorStreamUrl = streamUris[profile.name].live_stream_multicast.uri;
          break;
        }
      }
      //iterate over all profiles from end to beginning
      for (const profile of deviceProfiles.reverse()) {
        if (streamUris[profile.name].live_stream_tcp) {
          minorStreamUrl = streamUris[profile.name].live_stream_tcp.uri;
          break;
        }
        if (streamUris[profile.name].live_stream_udp) {
          minorStreamUrl = streamUris[profile.name].live_stream_udp.uri;
          break;
        }
        if (streamUris[profile.name].live_stream_multicast) {
          minorStreamUrl = streamUris[profile.name].live_stream_multicast.uri;
          break;
        }
      }
    } else {
      this.log.warn(`${cam.hostname}:${cam.port} No profiles found to receive snapshot or stream urls`);
    }

    const id = `${cam.hostname}_${cam.port}`.replace(/\./g, "_");
    let name = "";
    if (deviceInformation && deviceInformation.manufacturer) {
      name += deviceInformation.manufacturer + " ";
    }
    if (deviceInformation && deviceInformation.model) {
      name += deviceInformation.model + " ";
    }

    name += cam.hostname + ":" + cam.port;

    const native = {
      id: id,
      name: name,
      ip: rinfo.address,
      port: cam.port,
      hostname: cam.hostname,
      user: cam.username,
      password: cam.password,
    };

    snapshotUrl && (native.snapshotUrl = snapshotUrl);
    majorStreamUrl && (native.majorStreamUrl = majorStreamUrl.replace("rtsp://", "rtsp://" + cam.username + ":" + cam.password + "@"));
    minorStreamUrl && (native.minorStreamUrl = minorStreamUrl.replace("rtsp://", "rtsp://" + cam.username + ":" + cam.password + "@"));
    this.log.debug(`Creating camera ${id} with native ${JSON.stringify(native)} and rinfo ${JSON.stringify(rinfo)}`);
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
    await this.setObjectNotExistsAsync(id + ".connection", {
      type: "state",
      common: {
        name: "Connection to camera",
        type: "boolean",
        role: "indicator.connected",
        def: true,
        write: false,
        read: true,
      },
      native: {},
    });
    await this.setStateAsync(id + ".connection", true, true);

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
      const cam = new Cam(
        {
          hostname: device.ip,
          username: device.username,
          password: device.password,
          port: device.port,
          timeout: 5000,
        },
        function (err, data, xml) {
          if (err) {
            reject({ err, data, xml });
          }
          // @ts-ignore
          resolve(this);
        },
      );
      // @ts-ignore
      cam.on("rawResponse", (data) => {
        this.log.debug("Raw response: " + data);
      });
      // @ts-ignore
      cam.on("rawRequest", (data) => {
        this.log.debug("Raw request: " + data);
      });
      // @ts-ignore
      cam.on("connect", () => {
        this.log.debug("Connected to " + cam.hostname + ":" + cam.port);
      });
    });
  }
  async getSnapshot(id) {
    const native = this.deviceNatives[id];
    if (!native) {
      this.log.error("No native found for cam " + id + " cannot get snapshot");
      return;
    }
    //check last snapshot was more than 5 seconds ago
    if (native.lastSnapshot && native.lastSnapshot + 500 > Date.now()) {
      this.log.debug("Last snapshot was less than 0.5 seconds ago. Skip snapshot");
      return;
    }
    this.deviceNatives[id].lastSnapshot = Date.now();

    if (!native || !native.snapshotUrl) {
      this.log.debug("No snapshot url found for " + id + " try ffmpeg as fallback");
      if (!this.ffmpeg) {
        this.ffmpeg = require("fluent-ffmpeg");
        const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
        const ffprobePath = require("@ffprobe-installer/ffprobe").path;
        this.ffmpeg.setFfmpegPath(ffmpegPath);
        this.ffmpeg.setFfprobePath(ffprobePath);
      }
      return new Promise((resolve, reject) => {
        const url = this.config.useHighRes ? native.majorStreamUrl : native.minorStreamUrl || native.majorStreamUrl;
        if (!url) {
          this.log.error("No stream url found for " + id + " cannot get snapshot. Delete cam under objects and restart adapter");
          resolve(null);
          return;
        }

        const command = this.ffmpeg(url)
          .inputOptions(["-rtsp_transport tcp"])
          .addOptions(["-f", "image2", "-vframes", "1"])
          .on("error", (err) => {
            this.log.error("An ffmpeg error occurred: " + err.message);
            reject(err);
          })
          .on("end", () => {});

        const ffstream = command.pipe();
        const buffers = [];
        ffstream.on("data", (chunk) => {
          buffers.push(chunk);
        });
        ffstream.on("end", async () => {
          const buffer = Buffer.concat(buffers);
          resolve(buffer);
        });
      });
    } else {
      const snapshotUrl = native.snapshotUrl;
      const response = await request(snapshotUrl, {
        method: "GET",
        auth: `${native.user}:${native.password}`,
        timeout: 7000,
      })
        .then(async (response) => {
          if (response.status === 401) {
            this.log.debug("Basic auth failed, trying digest auth");
            //if basic auth fails try digest auth
            return await request(snapshotUrl, {
              method: "GET",
              digestAuth: `${native.user}:${native.password}`,
            })
              .then((response) => {
                if (response.status >= 400) {
                  this.log.error("Error getting snapshot via digest: " + JSON.stringify(response));
                  return;
                }
                return response.data;
              })
              .catch((e) => {
                this.log.error("Error getting snapshot via basic: " + JSON.stringify(e));
              });
          }
          if (response.status >= 400) {
            this.log.error("Error getting snapshot basic: " + JSON.stringify(response));
            return;
          }
          return response.data;
        })
        .catch((e) => {
          this.log.error("Error getting snapshot: " + JSON.stringify(e));
        });
      return response;
    }
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
              this.log.info("Device successful initialized via manual search: " + cam.hostname + ":" + cam.port + " with IP " + cam.ip);
              if (!cam.ip) {
                this.log.info("No IP found, using hostname instead");
                this.log.debug(JSON.stringify(cam));
                cam.ip = cam.hostname;
              }
              const native = await this.fetchCameraInfos(cam, { address: cam.ip });
              this.deviceNatives[native.id] = native;
              this.devices[cam.hostname] = cam;
              cam.on("event", this.processEvent.bind(this, { native: native }));

              return native.name;
            })
            .catch((error) => {
              this.log.error(`Failed to login to ${ip}:${port}` + " with " + options.user + ":" + this.maskPassword(options.password));
              this.log.info("Error " + error.err);
              this.log.debug(error.err.stack);

              this.log.info(`Data: ${JSON.stringify(error.data)} xml: ${error.xml}`);
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
      try {
        await this.delObjectAsync("", { recursive: true });
      } catch (error) {
        this.log.error("Error cleaning old version devices: " + error);
        this.log.info("Please update node and js-controller to latest version");
      }
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
  maskPassword(password) {
    if (!password) return password;
    let replaced = password.replace(/./g, "*");
    //use first and last character of password
    replaced = password.charAt(0) + replaced.substring(1, replaced.length - 1) + password.charAt(password.length - 1);
    return replaced;
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
  async sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
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
        await this.sleep(5000);
        this.log.info("Discovery finished");
        this.log.info(`Added ${this.discoveredDevices.length} cameras: ${JSON.stringify(this.discoveredDevices, null, 2)}`);
        obj.callback &&
          this.sendTo(
            obj.from,
            obj.command,
            {
              result: `Added ${this.discoveredDevices.length} cameras: ${JSON.stringify(
                this.discoveredDevices,
                null,
                2,
              )}. See log for details`,
            },
            obj.callback,
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
            obj.callback,
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
          if (!cam) {
            this.log.warn("No camera found for " + deviceId + " with ip " + deviceObject.native.ip);
            return;
          }
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
          if (!cam) {
            this.log.warn("No camera found for " + deviceId + " with ip " + deviceObject.native.ip);
            return;
          }
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
        if (cam[command]) {
          if (!cam) {
            this.log.warn("No camera found for " + deviceId + " with ip " + deviceObject.native.ip);
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
        } else {
          this.log.error(`Command ${command} not found on device ${deviceId}`);
        }
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
