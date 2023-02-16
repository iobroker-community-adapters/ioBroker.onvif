"use strict";

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios").default;
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
    this.deviceArray = [];
    this.devices = {};
    this.json2iob = new Json2iob(this);
    this.requestClient = axios.create();
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState("info.connection", false, true);

    if (!this.config.username || !this.config.password) {
      this.log.error("Please set username and password in the instance settings");
      return;
    }
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
          this.log.info("Device initialized: " + cam.hostname + ":" + cam.port);
          return cam;
        })
        .catch(async (err) => {
          this.log.error(`Error initializing device: ${err} device: ${JSON.stringify(device.native)}`);
          this.log.error(err.stack);
          return null;
        });
      if (camObj) {
        this.devices[camObj.hostname] = camObj;
      }
    }

    this.log.info("Start onvif discovery");
    await this.discovery();
    this.log.info("Finished onvif discovery");
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
        const urn = result["Envelope"]["Body"][0]["ProbeMatches"][0]["ProbeMatch"][0]["EndpointReference"][0]["Address"][0].payload;
        const xaddrs = result["Envelope"]["Body"][0]["ProbeMatches"][0]["ProbeMatch"][0]["XAddrs"][0].payload;
        let scopes = result["Envelope"]["Body"][0]["ProbeMatches"][0]["ProbeMatch"][0]["Scopes"][0].payload;
        scopes = scopes.split(" ");

        const scopeObject = {};
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
        this.log.info(`Discovery Reply from ${rinfo.address} (${scopeObject.name}) (${scopeObject.hardware}) (${xaddrs}) (${urn})`);
        if (this.devices[rinfo.address]) {
          this.log.info(`Skip device ${rinfo.address} because it is already configured via iob object`);
          return;
        }
        if (scopeObject.name === "Dahua") {
          this.log.info(`Try to login to ${rinfo.address}:${cam.port}` + " with " + this.config.username + ":" + this.config.password);
          await this.initDevice({ ip: rinfo.address, port: cam.port, username: this.config.username, password: this.config.password })
            .then(async (cam) => {
              this.log.info("Dahua device found");
              //  this.log.debug(JSON.stringify(cam, null, 2));
              const timeDate = await promisify(cam.getSystemDateAndTime).bind(cam)();

              const deviceInformation = await promisify(cam.getDeviceInformation).bind(cam)();
              const deviceProfiles = await promisify(cam.getProfiles).bind(cam)();
              const deviceCapabilities = await promisify(cam.getCapabilities).bind(cam)();
              const deviceServices = await promisify(cam.getServices).bind(cam)(true);
              const deviceServicesCapabilities = await promisify(cam.getServiceCapabilities).bind(cam)();
              const scopes = await promisify(cam.getScopes).bind(cam)();
              const videoSources = await promisify(cam.getVideoSources).bind(cam)();
              const status = await promisify(cam.getStatus).bind(cam)();
              let snapshotUrl;
              const streamUris = {};
              for (const profile of deviceProfiles) {
                streamUris[profile.name] = {};
                streamUris[profile.name].snapshotUrl = await promisify(cam.getSnapshotUri).bind(cam)({ ProfileToken: profile.$.token });
                if (!snapshotUrl) {
                  snapshotUrl = streamUris[profile.name].snapshotUrl.uri;
                }
                streamUris[profile.name].live_stream_tcp = await promisify(cam.getStreamUri).bind(cam)({
                  protocol: "RTSP",
                  stream: "RTP-Unicast",
                  ProfileToken: profile.$.token,
                });
                streamUris[profile.name].live_stream_udp = await promisify(cam.getStreamUri).bind(cam)({
                  protocol: "UDP",
                  stream: "RTP-Unicast",
                  ProfileToken: profile.$.token,
                });
                streamUris[profile.name].live_stream_multicast = await promisify(cam.getStreamUri).bind(cam)({
                  protocol: "UDP",
                  stream: "RTP-Multicast",
                  ProfileToken: profile.$.token,
                });
                streamUris[profile.name].http_stream = await promisify(cam.getStreamUri).bind(cam)({
                  protocol: "HTTP",
                  stream: "RTP-Unicast",
                  ProfileToken: profile.$.token,
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
              await this.setObjectNotExistsAsync(id + ".remote", {
                type: "channel",
                common: {
                  name: "Remote Controls",
                },
                native: {},
              });

              const remoteArray = [
                { command: "Refresh", name: "True = Refresh" },
                { command: "snapshot", name: "True = Switch On, False = Switch Off" },
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
              this.json2iob.parse(id + ".general", cam, { forceIndex: true, removePasswords: true });

              this.json2iob.parse(id + ".timeDate", timeDate, { forceIndex: true, channelName: "Time Date" });
              this.json2iob.parse(id + ".deviceInformation", deviceInformation, { forceIndex: true, channelName: "Device Information" });
              this.json2iob.parse(id + ".deviceProfiles", deviceProfiles, { forceIndex: true, channelName: "Device Profiles" });
              this.json2iob.parse(id + ".deviceCapabilities", deviceCapabilities, { forceIndex: true, channelName: "Device Capabilities" });
              this.json2iob.parse(id + ".deviceServices", deviceServices, { forceIndex: true, channelName: "Device Services" });
              this.json2iob.parse(id + ".deviceServicesCapabilities", deviceServicesCapabilities, {
                forceIndex: true,
                channelName: "Device Services Capabilities",
              });
              this.json2iob.parse(id + ".scopes", scopes, { forceIndex: true, channelName: "Scopes" });
              this.json2iob.parse(id + ".videoSources", videoSources, { forceIndex: true, channelName: "Video Sources" });
              this.json2iob.parse(id + ".status", status, { forceIndex: true, channelName: "Status" });
              this.json2iob.parse(id + ".streamUris", streamUris, { forceIndex: true, channelName: "Stream Uris" });
            })
            .catch((err) => {
              this.log.error(`Failed to login to ${rinfo.address}:${cam.port}` + " with " + this.config.username + ":" + this.config.password);
              this.log.error("Erro " + err);
              this.log.error(err.stack);
            });
        }
        this.log.debug(JSON.stringify(scopeObject));
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
          resolve(this);
        }
      );
    });
  }

  async getDeviceList() {
    const list = [];
    for (const device of list) {
      this.log.debug(JSON.stringify(device));
      const id = device.cid;
      // if (device.subDeviceNo) {
      //   id += "." + device.subDeviceNo;
      // }

      this.deviceArray.push(device);
      const name = device.deviceName;

      await this.setObjectNotExistsAsync(id, {
        type: "device",
        common: {
          name: name,
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

      const remoteArray = [
        { command: "Refresh", name: "True = Refresh" },
        { command: "snapshot", name: "True = Switch On, False = Switch Off" },
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
      this.json2iob.parse(id + ".general", device, { forceIndex: true });
    }
  }

  generateRange(startIp, endIp) {
    var startLong = toLong(startIp);
    var endLong = toLong(endIp);
    if (startLong > endLong) {
      var tmp = startLong;
      startLong = endLong;
      endLong = tmp;
    }
    var rangeArray = [];
    var i;
    for (i = startLong; i <= endLong; i++) {
      rangeArray.push(fromLong(i));
    }
    return rangeArray;
  }

  //toLong taken from NPM package 'ip'
  toLong(ip) {
    var ipl = 0;
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
      this.setState("info.connection", false, true);
      // this.refreshTimeout && clearTimeout(this.refreshTimeout);
      // this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      // this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      // this.updateInterval && clearInterval(this.updateInterval);
      // this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      callback();
    } catch (e) {
      callback();
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
        let command = id.split(".")[4];
        const type = command.split("-")[1];
        command = command.split("-")[0];

        if (id.split(".")[4] === "Refresh") {
          //    this.updateDevices();
          return;
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
