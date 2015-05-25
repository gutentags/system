"use strict";

var Q = require("q");
var URL = require("./url");
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
    self.main = null;
    self.resources = options.resources || {}; // by system.name / module.id
    self.modules = options.modules || {}; // by system.name/module.id
    self.systems = options.systems || {}; // by system.name
    self.systemLoadedPromises = options.systemLoadedPromises || {}; // by system.name
    self.buildSystem = options.buildSystem; // or self if undefined
    self.analyzers = {js: self.analyzeJavaScript};
    self.compilers = {js: self.compileJavaScript, json: self.compileJson};
    self.translators = {};
    self.node = !!options.node;
    self.browser = !!options.browser;
    self.parent = options.parent;
    self.root = options.root || self;
    // TODO options.optimize
    // TODO options.instrument
    // TODO options.analyzers, options.compilers, options.translators (either
    // from the build system or from given functions)
    self.systems[self.name] = self;
    self.systemLoadedPromises[self.name] = Q(self);

    if (options.name != null && options.name !== description.name) {
        console.warn("Package loaded by name " + JSON.stringify(options.name) + " bears name " + JSON.stringify(description.name));
    }

    if (description.main != null) { self.addRedirect("", description.main); }

    // Overlays:
    if (options.browser) { self.overlayBrowser(description); }
    if (options.node) { self.overlayNode(description); }

    if (description.dependencies) { self.addDependencies(description.dependencies); }
    if (description.devDependencies) { self.addDependencies(description.devDependencies); }
    if (description.redirects) { self.addRedirects(description.redirects); }
    if (description.translators) { self.addTranslators(description.translators); }
    if (description.analyzers) { self.addAnalyzers(description.analyzers); }
    if (description.compilers) { self.addCompilers(description.compilers); }
}

System.prototype.import = function importModule(id) {
    var self = this;
    return self.load(id)
    .then(function onModuleLoaded() {
        self.root.main = self.lookup(id);
        return self.require(id);
    });
};

// system.require(rel, abs) must be called only after the module and its
// transitive dependencies have been loaded, as guaranteed by system.load(rel,
// abs)
System.prototype.require = function require(rel, abs) {
    var self = this;

    var id, module;
    if (Identifier.isAbsolute(rel)) {
        var head = Identifier.head(rel);
        var tail = Identifier.tail(rel);
        if (self.dependencies[head]) {
            return self.getSystem(head, abs).requireInternalModule(tail, abs);
        } else if (self.modules[head]) {
            return self.requireInternalModule(rel, abs, self.modules[rel]);
        } else {
            var via = abs ? " via " + JSON.stringify(abs) : "";
            throw new Error("Can't require " + JSON.stringify(rel) + via);
        }
    } else {
        id = self.normalizeIdentifier(Identifier.resolve(rel, abs));
        return self.requireInternalModule(id, abs);
    }

};

System.prototype.requireInternalModule = function requireInternalModule(id, abs, module) {
    var self = this;
    module = module || self.lookupInternalModule(id);

    //// handle redirects
    //while (module.redirect != null) {
    //    module = self.modules[module.redirect];
    //}

    // check for load error
    if (module.error) {
        var error = module.error;
        var via = abs ? " via " + JSON.stringify(abs) : "";
        error.message = (
            "Can't require module " + JSON.stringify(module.id) +
            via +
            " in " + JSON.stringify(self.name || self.location) +
            " because " + error.message
        );
        throw error;
    }

    // do not reinitialize modules
    if (module.exports !== null) {
        return module.exports;
    }

    // do not initialize modules that do not define a factory function
    if (typeof module.factory === "undefined") {
        throw new Error(
            "Can't require module " + JSON.stringify(module.key) +
            " because no factory or exports were created by the module"
        );
    }

    module.require = self.makeRequire(module.id, self.root.main);
    module.exports = {};

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

System.prototype.makeRequire = function makeRequire(abs, main) {
    var self = this;
    function require(rel) {
        return self.require(rel, abs);
    };
    require.main = main;
    return require;
};

// System:

// Should only be called if the system is known to have already been loaded by
// system.loadSystem.
System.prototype.getSystem = function getSystem(rel, abs) {
    var self = this;
    var hasDependency = self.dependencies[rel];
    if (!hasDependency) {
        var via = abs ? " via " + JSON.stringify(abs) : "";
        throw new Error("Can't get dependency " + JSON.stringify(rel) + " in package named " + JSON.stringify(self.name) + via);
    }
    var dependency = self.systems[rel];
    if (!dependency) {
        var via = abs ? " via " + JSON.stringify(abs) : "";
        throw new Error("Can't get dependency " + JSON.stringify(rel) + " in package named " + JSON.stringify(self.name) + via); // TODO
    }
    return dependency;
};

System.prototype.loadSystem = function (name) {
    var self = this;
    //var hasDependency = self.dependencies[name];
    //if (!hasDependency) {
    //    var error = new Error("Can't load module " + JSON.stringify(name));
    //    error.module = true;
    //    throw error;
    //}
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
            parent: self,
            root: self.root,
            name: name,
            resources: self.resources,
            modules: self.modules,
            systems: self.systems,
            systemLoadedPromises: self.systemLoadedPromises,
            buildSystem: buildSystem,
            browser: self.browser,
            node: self.node
        });
        self.systems[system.name] = system;
        return system;
    });
};

System.prototype.getBuildSystem = function getBuildSystem() {
    var self = this;
    return self.buildSystem || self;
};

// Resource:

System.prototype.getResource = function getResource(rel, abs) {
    var self = this;
    if (Identifier.isAbsolute(rel)) {
        var head = Identifier.head(rel);
        var tail = Identifier.tail(rel);
        return self.getSystem(head, abs).getInternalResource(tail);
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

System.prototype.normalizeIdentifier = function (id) {
    var self = this;
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
        if (self.dependencies[head]) {
            return self.loadSystem(head).invoke("loadInternalModule", tail);
        } else {
            return Q();
        }
    } else {
        return self.loadInternalModule(rel, abs);
    }
};

System.prototype.loadInternalModule = function loadInternalModule(rel, abs) {
    var self = this;
    var id = self.normalizeIdentifier(rel);
    var module = self.lookupInternalModule(id, abs);
    if (module.loadedPromise) {
        // Returning a resolved promise allows us to continue if there is a
        // dependency cycle.
        // TODO race condition with multiple parallel loads. The loadedPromise
        // map should be created for each entry into the load() function.
        return Q();
    }
    module.loadedPromise = Q.try(function () {
        if (module.factory == null && module.exports == null) {
            return self.read(module.location, "utf-8")
            .then(function (text) {
                module.text = text;
            });
        }
    }).then(function () {
        return self.translate(module);
        // TODO optimize
        // TODO instrument
        // TODO facilitate source maps and source map transforms
    }).then(function () {
        return self.analyze(module);
    }).then(function () {
        return Q.all(module.dependencies.map(function (dependency) {
            return self.load(dependency, module.id);
        }));
    }).then(function () {
        return self.compile(module);
    }, function (error) {
        module.error = error;
    });
    return module.loadedPromise;
};

System.prototype.lookup = function lookup(rel, abs) {
    var self = this;
    if (Identifier.isAbsolute(rel)) {
        var head = Identifier.head(rel);
        var tail = Identifier.tail(rel);
        if (self.dependencies[head]) {
            return self.getSystem(head, abs).lookup(tail);
        } else if (self.modules[head] && !tail) {
            return self.modules[head];
        } else {
            throw new Error("Can't lookup"); // TODO
        }
    }
    return self.lookupInternalModule(rel, abs);
};

System.prototype.lookupInternalModule = function lookupInternalModule(rel, abs) {
    var self = this;

    var normal = Identifier.resolve(rel, abs);
    var id = self.normalizeIdentifier(normal);

    var filename = self.name + '/' + id;
    // This module system is case-insensitive, but mandates that a module must
    // be consistently identified by the same case convention to avoid problems
    // when migrating to case-sensitive file systems.
    var key = filename.toLowerCase();
    var module = self.modules[key];

    if (module && module.redirect) {
        return self.lookupInternalModule(module.redirect);
    }

    if (!module) {
        module = new Module();
        module.id = id;
        module.extension = Identifier.extension(id);
        module.location = URL.resolve(self.location, id);
        module.filename = filename;
        module.dirname = Identifier.dirname(filename);
        module.key = key;
        module.system = self;
        module.modules = self.modules;
        self.modules[key] = module;
    }

    if (module.filename !== filename) {
        module.error = new Error(
            "Can't refer to single module with multiple case conventions: " +
            JSON.stringify(filename) + " and " +
            JSON.stringify(module.filename)
        );
    }

    return module;
};

// Translate:

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

System.prototype.addTranslators = function addTranslators(translators) {
    var self = this;
    var extensions = Object.keys(translators);
    for (var index = 0; index < extensions.length; index++) {
        var extension = extensions[index];
        var id = translators[extension];
        self.addTranslator(extension, id);
    }
};

System.prototype.addTranslator = function (extension, id) {
    var self = this;
    self.translators[extension] = self.makeTranslator(id);
};

System.prototype.makeTranslator = function makeTranslator(id) {
    var self = this;
    return function translate(module) {
        return self.getBuildSystem()
        .import(id)
        .then(function (translate) {
            module.extension = "js";
            return translate(module);
        })
    }
};

// Analyze:

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

System.prototype.analyzeJavaScript = function analyzeJavaScript(module) {
    var self = this;
    module.dependencies.push.apply(module.dependencies, parseDependencies(module.text));
};

// TODO addAnalyzers
// TODO addAnalyzer

// Compile:

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

System.prototype.compileJavaScript = function compileJavaScript(module) {
    compile(module);
};

System.prototype.compileJson = function compileJson(module) {
    module.exports = JSON.parse(module.text);
};

System.prototype.addCompilers = function addCompilers(compilers) {
    var self = this;
    var extensions = Object.keys(compilers);
    for (var index = 0; index < extensions.length; index++) {
        var extension = extensions[index];
        var id = compilers[extension];
        self.addCompiler(extension, id);
    }
};

System.prototype.addCompiler = function (extension, id) {
    var self = this;
    self.compilers[extension] = self.makeCompiler(id);
};

System.prototype.makeCompiler = function makeCompiler(id) {
    var self = this;
    return function compile(module) {
        return self.getBuildSystem()
        .import(id)
        .then(function (compile) {
            return compile(module);
        });
    }
};

// Dependencies:

System.prototype.addDependencies = function addDependencies(dependencies) {
    var self = this;
    var names = Object.keys(dependencies);
    for (var index = 0; index < names.length; index++) {
        var name = names[index];
        self.dependencies[name] = true;
    }
};

// Redirects:

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
    source = self.normalizeIdentifier(Identifier.resolve(source));
    target = self.normalizeIdentifier(Identifier.resolve(target, source));
    self.modules[self.name + "/" + source] = {redirect: target};
};

// Etc:

System.prototype.overlayBrowser = function overlayBrowser(description) {
    var self = this;
    if (typeof description.browser === "string") {
        self.addRedirect("", description.browser);
    } else if (description.browser && typeof description.browser === "object") {
        self.addRedirects(description.browser);
    }
};

System.prototype.inspect = function () {
    var self = this;
    return {type: "system", location: self.location};
};

