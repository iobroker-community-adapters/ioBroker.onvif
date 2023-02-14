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

    this.log.info("Login to VeSync");
    await this.discovery();
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
      parser.parseString(xml, (err, result) => {
        if (err) {
          return;
        }
        const urn =
          result["Envelope"]["Body"][0]["ProbeMatches"][0]["ProbeMatch"][0]["EndpointReference"][0]["Address"][0]
            .payload;
        const xaddrs = result["Envelope"]["Body"][0]["ProbeMatches"][0]["ProbeMatch"][0]["XAddrs"][0].payload;
        let scopes = result["Envelope"]["Body"][0]["ProbeMatches"][0]["ProbeMatch"][0]["Scopes"][0].payload;
        scopes = scopes.split(" ");

        let hardware = "";
        let name = "";
        for (let i = 0; i < scopes.length; i++) {
          if (scopes[i].includes("onvif://www.onvif.org/name")) {
            name = decodeURI(scopes[i].substring(27));
          }
          if (scopes[i].includes("onvif://www.onvif.org/hardware")) {
            hardware = decodeURI(scopes[i].substring(31));
          }
        }
        const msg =
          "Discovery Reply from " + rinfo.address + " (" + name + ") (" + hardware + ") (" + xaddrs + ") (" + urn + ")";
        this.log.info(msg);
      });
    });
    Discovery.on("error", (err, xml) => {
      // The ONVIF library had problems parsing some XML
      this.log.error("Discovery error " + err);
      this.log.error(xml);
    });
    Discovery.probe();
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
