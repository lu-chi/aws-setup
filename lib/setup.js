// load node modules
var fs   = require("fs"),
    path = require("path");

// load npm modules
var extend = require("node.extend"),
    AWS    = require("aws-sdk"),
    async  = require("async");

// load local modules
var cli        = require("lib/cli.js"),
    Emitter    = require("lib/conversions.js").Emitter,
    logger     = require("lib/logger.js"),
    actions    = require("lib/actions.js"),
    formatters = require("lib/formatters.js");


var Setup = Emitter._extend({

  init: function(args) {
    this._super();

    this.args = args;

    this.logger = logger(args.logLevel);

    this.setupsDir      = null;
    this.mappingFile    = null;
    this.stepMapping    = null;
    this.formattersFile = null;
    this.formatters     = null;
    this.actions        = null;
    this.setupFile      = null;
    this.extension      = null;
    this.content        = null;

    this.loadCredentials();
    this.loadSetupsDir();
    this.loadMappings();
    this.loadFormatters();
    this.loadSetupContent();
  },

  abort: function() {
    this.logger.fatal.apply(this.logger, arguments);
    process.exit(1);
  },

  loadCredentials: function() {
    if (!fs.existsSync(this.args.credentialsFile))
      abort("no AWS credentials found");

    var cf = path.resolve(this.args.credentialsFile);

    AWS.config.loadFromPath(cf);
    this.logger.debug("load AWS credentials from '%s'", cf);

    return this;
  },

  loadSetupsDir: function() {
    this.setupsDir = path.resolve(this.args.setupsDir);
    return this;
  },

  loadMappings: function() {
    // the default mapping
    this.stepMapping = JSON.parse(fs.readFileSync(path.join("..", "stepmap.json")));

    if (fs.existsSync(this.args.stepMap))
      this.mappingFile = this.args.stepMap;
    else if (this.setupsDir && fs.existsSync(path.join(this.setupsDir, this.args.stepMap)))
      this.mappingFile = path.join(this.setupsDir, this.args.stepMap);
    else {
      this.logger.debug("no additional stepmap found");
      return this;
    }

    this.mappingFile = path.resolve(this.mappingFile);

    // extend our mapping
    try {
      var mapping = JSON.parse(fs.readFileSync(this.mappingFile));
      extend(true, this.stepMapping, mapping);
    } catch (err) {
      this.logger.warning("cannot parse the stepmap at '%s'", this.mappingFile);
    }

    return this;
  },

  loadFormatters: function() {
    // the default formatters
    this.formatters = extend(true, {}, formatters);

    if (fs.existsSync(this.args.formatters))
      this.formattersFile = this.args.formatters;
    else if (this.setupsDir && fs.existsSync(path.join(this.setupsDir, this.args.formatters)))
      this.formattersFile = path.join(this.setupsDir, this.args.formatters);
    else {
      this.logger.debug("no additional formatters found");
      return this;
    }

    this.formattersFile = path.resolve(this.formattersFile);

    // extend our formatters
    extend(true, this.formatters, require(this.formattersFile));

    return this;
  },

  loadSetupContent: function() {
    var find = function(file) {
      if (fs.existsSync(file))
        return file;
      else if (fs.existsSync(file + ".json"))
        return file + ".json";
      else if (fs.existsSync(file + ".js"))
        return file + ".js";
      else
        return null;
    };

    this.setupFile = find(this.args.setupFile);

    if (this.setupFile == null) {
      // the file does not exist, prepend the setups dir and try again
      if (!this.setupsDir || !fs.existsSync(this.setupsDir))
        abort("setups-dir '%s' does not exist", setupsDir);

      this.setupFile = find(path.join(this.setupsDir, this.args.setupFile));

      if (this.setupFile == null)
        abort("setup-file does not exist");
    } else
      this.setupFile = path.resolve(this.setupFile);

    this.logger.debug("use setup-file at '%s'", this.setupFile);

    // determine the file extension to read the setup content
    this.extension = this.setupFile.split(".").pop();
    if (!this.extension || !~["json", "js"].indexOf(this.extension.toLowerCase()))
      abort("setup-file extension '%s' not supported", this.extension);
    this.extension = this.extension.toLowerCase();
    this.logger.debug("setup-file extension is '%s'", this.extension);

    // read the content
    if (this.extension == "json")
      this.content = JSON.parse(fs.readFileSync(this.setupFile));
    else
      this.content = require(this.setupFile);
    this.logger.debug("read setup content");

    return this;
  },

  run: function() {
    // the list of calls that will be processed
    var calls = [];

    var payload = [];

    // determine the groups to process
    var groups = this.args.group;
    if (!groups || !groups.length) {
      this.logger.debug("no group set, use all groups");
      groups = Object.keys(this.content);
    }
    this.logger.debug("%s group%s found", groups.length, groups.length == 1 ? "" : "s");

    // determine the steps per group
    var steps = this.args.steps;
    if (steps) {
      if (steps.length != groups.length)
        this.abort("steps and groups cannot be matched");
    } else {
      steps = [];
      groups.forEach(function(group) {
        steps.push(this.content[group].steps || Object.keys(this.content[group]));
      }, this);
    }
    var l = 0;
    steps.forEach(function(_steps) { l += _steps.length; });
    this.logger.debug("%s step%s found", l, l == 1 ? "" : "s");

    // create the calls
    groups.forEach(function(group, i) {
      // omit groups with leading underscores
      if (group[0] == "_")
        return;

      var groupSteps = steps[i];
      groupSteps.forEach(function(step) {
        var action = actions(this.stepMapping, step);
        var configName = this.stepMapping[step].config;
        var config = this.content[group][configName];
        config = this.parseConfig(config);
        calls.push(function(callback) {
          action(config, callback, this.logger.error.bind(this.logger));
        }.bind(this));
        this.logger.info("queue step '%s.%s'", group, step);
      }, this);

    }, this);

    // finally, execute
    var execute = function() {
      this.logger.info("Executing ...\n");
      async.series(calls, function(err) {
        if (err)
          throw err;
        this.logger.info("done");
        process.exit(0);
      }.bind(this));
    };

    if (this.args.execute)
      execute.call(this);
    else {
      console.log("\nProcess queue? (y/n)");
      process.stdin.on("data", function(chunk) {
        if (String(chunk) == "y\n")
          execute.call(this);
        else
          process.exit(0);
      }.bind(this));
    }

    return this;
  },

  parseConfig: function(data) {
    if (isObject(data)) {
      Object.keys(data).forEach(function(key) {
        data[key] = this.parseConfig(data[key]);
      }, this);
      return data;
    }
    if (isArray(data))
      return data.map(this.parseConfig.bind(this));
    if (isNumber(data))
      return data;
    if (isBoolean(data))
      return data;

    // string => try to parse simple syntax

    // replace with payload
    var reVar = /.*(\$\{([^\|]+)(\|(.*))?\}).*/;

    var m = data.match(reVar);
    if (m && m.length == 5) {
      var val = this.args.payload[m[2]];
      if (val == null)
        val = m[4];
      if (val != null)
        data = data.replace(m[1], val);
      try {
        data = JSON.parse(data);
      } catch (err) {}
    }

    // apply formatters
    var reFmt = /.*(\%\[([^\:]+)(|\:|\:(.+))\]).*/;

    m = data.match(reFmt);
    if (m && m.length == 5) {
      var fmt = this.formatters;
      m[2].split(".").forEach(function(part) {
        if (!fmt[part])
          this.abort("formatter '%s' not found", m[2]);
        fmt = fmt[part];
      }, this);
      if (isFunction(fmt)) {
        var arg = m[3];
        if (arg[0] == ":")
          arg = arg.substr(1);
        var args = arg ? arg.split(",") : [];
        args.map(function(arg) {
          return arg.trim();
        });
        var val = fmt.apply(null, args);
        if (val != null)
          data = data.replace(m[1], val);
      }
    }

    return data;
  }
});


// type helper functions
var isObject = function(obj) {
  return Object.prototype.toString.call(obj) == "[object Object]";
};
var isArray = function(arr) {
  return arr instanceof Array;
};
var isNumber = function(num) {
  return typeof(num) == "number";
};
var isBoolean = function(b) {
  return typeof(b) == "boolean";
};
var isFunction = function(f) {
  return f instanceof Function;
};


// parse args and start the setup
var setup = new Setup(cli(process.argv));
setup.run();