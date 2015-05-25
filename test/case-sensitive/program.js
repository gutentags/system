var test = require("test");
try {
    require("./a");
    require("./A");
    test.assert(false, "should fail to require alternate spelling");
} catch (error) {
    test.assert(error.message === "Can't refer to single module with multiple case conventions: \"a.js\" and \"A.js\"", 'error message for inconsistent case');
}
