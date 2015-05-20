"use strict";

var Q = require("q");
var URL = require("url");
var Identifier = require("./identifier");
var Module = require("./module");
var Resource = require("./resource");
var parseDependencies = require("./parse-dependencies");
var compile = require("./compile");
var has = Object.prototype.hasOwnProperty;

module.exports = System;

function System(location, description, options) {
    var self = this;
    options = options || {};
    description = description || {};
    self.name = description.name || '';
    self.location = location;
    self.description = description;
    self.dependencies = {};
    self.resources = options.resources || {}; // by system.name / module.id
    self.modules = options.modules || {}; // by system.name/module.id
    self.systems = options.systems || {}; // by system.name
    self.systemLoadedPromises = options.systemLoadedPromises || {}; // by system.name
    self.buildSystem = options.buildSystem; // or self if undefined
    self.analyzers = {js: self.analyzeJavaScript};
    self.compilers = {js: self.compileJavaScript, json: self.compileJson};
    self.translators = {};
    // TODO options.optimize
    // TODO options.instrument
    // TODO options.analyzers, options.compilers, options.translators (either
    // from the build system or from given functions)

    self.systems[self.name] = self;
    self.systemLoadedPromises[self.name] = Q(self);

    if (typeof description.browser === "string") {
        self.addRedirect("./.js", description.browser);
    } else if (description.browser && typeof description.browser === "object") {
        self.addRedirects(description.browser);
    }

    if (description.main != null) {
        self.addRedirect("./.js", "./" + description.main);
    }

    if (description.dependencies) {
        self.addDependencies(description.dependencies);
    }

    if (description.analyzers) {
        self.addAnalyzers(description.analyzers);
    }

    if (description.translators) {
        self.addTranslators(description.translators);
    }

    if (description.compilers) {
        self.addCompilers(description.compilers);
    }
}

System.prototype.addDependencies = function addDependencies(dependencies) {
    var self = this;
    var names = Object.keys(dependencies);
    for (var index = 0; index < names.length; index++) {
        var name = names[index];
        self.dependencies[name] = true;
    }
};

System.prototype.addRedirects = function addRedirects(redirects) {
    var self = this;
    var sources = Object.keys(redirects);
    for (var index = 0; index < sources.length; index++) {
        var source = sources[index];
        var target = redirects[source];
        self.addRedirect(source, target);
    }
};

System.prototype.addRedirect = function addRedirect(source, target) {
    var self = this;
    source = Identifier.resolve(source);
    target = Identifier.resolve(target, source);
    self.lookup(source).redirect = target;
};

// TODO addAnalyzers
// TODO addTranslators
// TODO addCompilers

System.prototype.import = function importModule(id) {
    var self = this;
    return self.load(id)
    .then(function onModuleLoaded() {
        return self.require(id);
    });
};

// system.require(rel, abs) must be called only after the module and its
// transitive dependencies have been loaded, as guaranteed by system.load(rel,
// abs)
System.prototype.require = function require(rel, abs) {
    var self = this;

    if (Identifier.isAbsolute(rel)) {
        var head = Identifier.head(rel);
        var tail = Identifier.tail(rel);
        return self.getSystem(head).require(tail);
    }

    var id = self.normalizeIdentifier(rel, abs);
    var module = self.lookup(id);

    // check for consistent case convention
    //if (module.id !== id) {
    //    throw new Error(
    //        "Can't require module " + JSON.stringify(module.id) +
    //        " by alternate spelling " + JSON.stringify(id)
    //    );
    //}

    // check for load error
    if (module.error) {
        var error = module.error;
        error.message = (
            "Can't require module " + JSON.stringify(module.id) +
            " via " + JSON.stringify(abs) +
            " in " + JSON.stringify(self.name || self.location) +
            " because " + error.message
        );
        throw error;
    }

    // handle redirects
    if (module.redirect !== null) {
        return self.require(module.redirect, abs);
    }

    // do not reinitialize modules
    if (module.exports !== null) {
        return module.exports;
    }

    // do not initialize modules that do not define a factory function
    if (module.factory === null) {
        throw new Error(
            "Can't require module " + JSON.stringify(module.key) +
            " because no factory or exports were created by the module"
        );
    }

    module.require = self.makeRequire(module.id);
    module.exports = {};
    module.dirname = URL.resolve(module.filename, ".");

    // Execute the factory function:
    module.factory.call(
        // in the context of the module:
        null, // this (defaults to global, except in strict mode)
        module.require,
        module.exports,
        module,
        module.filename,
        module.dirname
    );

    return module.exports;
};

System.prototype.makeRequire = function makeRequire(abs) {
    var self = this;
    return function require(rel) {
        return self.require(rel, abs);
    };
};

// System:

// Should only be called if the system is known to have already been loaded by
// system.loadSystem.
System.prototype.getSystem = function getSystem(name) {
    var self = this;
    var hasDependency = self.dependencies[name];
    if (!hasDependency) {
        throw new Error("Can't get dependency " + name); // TODO
    }
    var dependency = self.systems[name];
    if (!dependency) {
        throw new Error("Can't get dependency " + name); // TODO
    }
    return dependency;
};

System.prototype.loadSystem = function (name) {
    var self = this;
    var hasDependency = self.dependencies[name];
    if (!hasDependency) {
        throw new Error("Can't load module " + name + " because not in dependencies of " + self.name); // TODO
    }
    var loadingSystem = self.systemLoadedPromises[name];
    if (!loadingSystem) {
         loadingSystem = self.actuallyLoadSystem(name);
         self.systemLoadedPromises[name] = loadingSystem;
    }
    return loadingSystem;
};

// TODO consider harnessing loadResource
System.prototype.loadSystemDescription = function loadSystemDescription(location) {
    var self = this;
    var descriptionLocation = URL.resolve(location, "package.json")
    return self.read(descriptionLocation, "utf-8", "application/json")
    .then(function (json) {
        try {
            return JSON.parse(json);
        } catch (error) {
            error.message = error.message + " in " + JSON.stringify(descriptionLocation);
            throw error;
        }
    })
};

System.prototype.actuallyLoadSystem = function (name) {
    var self = this;
    var System = self.constructor;
    var location = URL.resolve(self.location, "node_modules/" + name + "/");
    var buildSystem;
    if (self.buildSystem) {
        buildSystem = self.buildSystem.actuallyLoadSystem(name);
    }
    return Q.all([
        self.loadSystemDescription(location),
        buildSystem
    ]).spread(function onDescriptionAndBuildSystem(description, buildSystem) {
        var system = new System(location, description, {
            resources: self.resources,
            modules: self.modules,
            systems: self.systems,
            systemLoadedPromises: self.systemLoadedPromises,
            buildSystem: buildSystem
        });
        self.systems[system.name] = system;
        return system;
    });
};

System.prototype.getBuildSystem = function getBuildSystem() {
    return self.buildSystem || self;
};

// Resource:

System.prototype.getResource = function getResource(rel, abs) {
    var self = this;
    if (Identifier.isAbsolute(rel)) {
        var head = Identifier.head(rel);
        var tail = Identifier.tail(rel);
        return self.getSystem(head).getInternalResource(tail);
    } else {
        return self.getInternalResource(Identifier.resolve(rel, abs));
    }
};

System.prototype.locateResource = function locateResource(rel, abs) {
    var self = this;
    if (Identifier.isAbsolute(rel)) {
        var head = Identifier.head(rel);
        var tail = Identifier.tail(rel);
        return self.loadSystem(head)
        .then(function onSystemLoaded(subsystem) {
            return subsystem.getInternalResource(tail);
        });
    } else {
        return Q(self.getInternalResource(Identifier.resolve(rel, abs)));
    }
};

System.prototype.getInternalResource = function getInternalResource(id) {
    var self = this;
    // TODO redirects
    var filename = self.name + "/" + id;
    var key = filename.toLowerCase();
    var resource = self.resources[key];
    if (!resource) {
        resource = new Resource();
        resource.id = id;
        resource.filename = filename;
        resource.dirname = Identifier.dirname(filename);
        resource.key = key;
        resource.location = URL.resolve(self.location, id);
        resource.system = self;
        self.resources[key] = resource;
    }
    return resource;
};

// Module:

System.prototype.normalizeIdentifier = function (rel, abs) {
    var self = this;
    var id = Identifier.resolve(rel, abs);
    var extension = Identifier.extension(id);
    if (
        !has.call(self.translators, extension) &&
        !has.call(self.compilers, extension) &&
        extension !== "js" &&
        extension !== "json"
    ) {
        id += ".js";
    }
    return id;
};

// Loads a module and its transitive dependencies.
System.prototype.load = function load(rel, abs) {
    var self = this;
    if (Identifier.isAbsolute(rel)) {
        var head = Identifier.head(rel);
        var tail = Identifier.tail(rel);
        return self.loadSystem(head).invoke("loadInternalModule", "./" + tail);
    } else {
        return self.loadInternalModule(rel, abs);
    }
};

System.prototype.loadInternalModule = function loadInternalModule(rel, abs) {
    var self = this;
    var id = self.normalizeIdentifier(rel, abs);
    var module = self.lookup(id);
    if (module.loadedPromise) {
        return Q();
    }
    module.resource = self.getInternalResource(module.id);
    module.extension = Identifier.extension(id);
    module.loadedPromise = Q.try(function () {
        if (module.factory == null && module.exports == null) {
            return self.read(module.resource.location, "utf-8")
            .then(function (text) {
                module.text = text;
            });
        }
    }).then(function () {
        return self.translate(module);
    }).then(function () {
        return self.analyze(module);
    }).then(function () {
        return Q.all(module.dependencies.map(function (dependency) {
            return self.load(dependency, id);
        }));
    }).then(function () {
        return self.compile(module);
    });
    return module.loadedPromise;
};

System.prototype.lookup = function lookup(rel, abs, memo) {
    var self = this;
    var module = self.lookupRedirect(rel, abs);

    // Handle rdirects
    if (module.redirect) {
        memo = memo || {};
        if (memo[module.key]) {
            throw new Error("Can't resolve redirect cycle about " + module.key);
        }
        memo[module.key] = true;
        return self.lookup(module.redirect, abs, memo);
    }

    return module;
};

System.prototype.lookupRedirect = function lookupRedirect(rel, abs) {
    var self = this;
    var filename = self.name + '/' + rel;
    // This module system is case-insensitive, but mandates that a module must
    // be consistently identified by the same case convention to avoid problems
    // when migrating to case-sensitive file systems.
    var key = filename.toLowerCase();
    var module = self.modules[key];
    if (!module) {
        module = new Module();
        module.id = rel;
        module.filename = filename;
        module.dirname = Identifier.dirname(filename);
        module.key = key;
        module.system = self;
        module.modules = self.modules;
        self.modules[key] = module;
    }

    // Check for consistent case convention
    if (module.id !== rel) {
        throw new Error(
            "Can't lookup module " + JSON.stringify(module.id) +
            " by alternate spelling " + JSON.stringify(rel)
        );
    }

    return module;
};

System.prototype.translate = function translate(module) {
    var self = this;
    if (
        module.text != null &&
        module.extension != null &&
        self.translators[module.extension]
    ) {
        return self.translators[module.extension](module);
    }
};

System.prototype.analyze = function analyze(module) {
    var self = this;
    if (
        module.text != null &&
        module.extension != null &&
        self.analyzers[module.extension]
    ) {
        return self.analyzers[module.extension](module);
    }
};

System.prototype.compile = function (module) {
    var self = this;
    if (
        module.factory == null &&
        module.redirect == null &&
        module.exports == null &&
        module.extension != null &&
        self.compilers[module.extension]
    ) {
        return self.compilers[module.extension](module);
    }
};

System.prototype.inspect = function () {
    var self = this;
    return {type: "system", location: self.location};
};

System.prototype.analyzeJavaScript = function (module) {
    var self = this;
    module.dependencies.push.apply(module.dependencies, parseDependencies(module.text));
};

System.prototype.compileJavaScript = function (module) {
    compile(module);
};

System.prototype.compileJson = function (module) {
    module.exports = JSON.parse(module.text);
};

