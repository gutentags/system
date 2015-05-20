"use strict";

module.exports = Module;

function Module() {
    this.id = null;
    this.extension = null;
    this.system = null;
    this.key = null;
    this.filename = null;
    this.dirname = null;
    this.type = null; // XXX ???
    this.exports = null;
    this.redirect = null;
    this.resource = null;
    this.factory = null;
    this.dependencies = [];
    this.dependees = {};
    this.loadedPromise = null;
}
