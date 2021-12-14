#!/usr/bin/env node

"use strict"

const request = require('request'),
    path = require('path'),
    tar = require('tar'),
    zlib = require('zlib'),
    mkdirp = require('mkdirp'),
    fs = require('fs'),
    exec = require('child_process').exec,
    process = require('process'),
    octokit = require('@octokit/endpoint');

// Mapping from Node's `process.arch` to Golang's `$GOARCH`
const ARCH_MAPPING = {
    "ia32": "386",
    "x64": "amd64",
    "arm": "arm",
    "arm64": "arm64"
};

// Mapping between Node's `process.platform` to Golang's 
const PLATFORM_MAPPING = {
    "darwin": "darwin",
    "linux": "linux",
    "win32": "windows",
    "freebsd": "freebsd"
};

function getInstallationPath(callback) {

    // `npm bin` will output the path where binary files should be installed
    exec("npm bin", function(err, stdout, stderr) {

        let dir =  null;
        if (err || stderr || !stdout || stdout.length === 0)  {

            // We couldn't infer path from `npm bin`. Let's try to get it from
            // Environment variables set by NPM when it runs.
            // npm_config_prefix points to NPM's installation directory where `bin` folder is available
            // Ex: /Users/foo/.nvm/versions/node/v4.3.0
            let env = process.env;
            if (env && env.npm_config_prefix) {
                dir = path.join(env.npm_config_prefix, "bin");
            }
        } else {
            dir = stdout.trim();
        }

        if (!dir) {
            dir = path.join(process.cwd(), 'node_modules/.bin')
        }

        callback(null, dir);
    });

}

function verifyAndPlaceBinary(binName, binPath, callback) {
    if (!fs.existsSync(path.join(binPath, binName))) return callback(`Downloaded binary does not contain the binary specified in configuration - ${binName}`);

    getInstallationPath(function(err, installationPath) {
        if (err) return callback("Error getting binary installation path from `npm bin`");

        // Move the binary file
        fs.renameSync(path.join(binPath, binName), path.join(installationPath, binName));

        callback(null);
    });
}

function validateConfiguration(packageJson) {

    if (!packageJson.goBinary.version) {
        return "'version' property must be specified";
    }

    if (!packageJson.goBinary || typeof(packageJson.goBinary) !== "object") {
        return "'goBinary' property must be defined and be an object";
    }

    if (!packageJson.goBinary.name) {
        return "'name' property is necessary";
    }

    if (!packageJson.goBinary.path) {
        return "'path' property is necessary";
    }

    if (!packageJson.goBinary.owner) {
        return "'owner' property is necessary";
    }

    if (!packageJson.goBinary.repo) {
        return "'repo' property is necessary";
    }

    if (!packageJson.goBinary.assetName) {
        return "'assetName' property is required";
    }
}

function parsePackageJson() {
    if (!(process.arch in ARCH_MAPPING)) {
        console.error("Installation is not supported for this architecture: " + process.arch);
        return;
    }

    if (!(process.platform in PLATFORM_MAPPING)) {
        console.error("Installation is not supported for this platform: " + process.platform);
        return
    }

    const packageJsonPath = path.join(".", "package.json");
    if (!fs.existsSync(packageJsonPath)) {
        console.error("Unable to find package.json. " +
            "Please run this script at root of the package you want to be installed");
        return
    }

    let packageJson = JSON.parse(fs.readFileSync(packageJsonPath));
    let error = validateConfiguration(packageJson);
    if (error && error.length > 0) {
        console.error("Invalid package.json: " + error);
        return
    }

    // We have validated the config. It exists in all its glory
    let binName = packageJson.goBinary.name;
    let binPath = packageJson.goBinary.path;
    let auth = packageJson.goBinary.auth;
    let owner = packageJson.goBinary.owner;
    let repo = packageJson.goBinary.repo;
    let assetName = packageJson.goBinary.assetName;
    let version = packageJson.goBinary.version;

    if (version[0] === 'v') version = version.substr(1);  // strip the 'v' if necessary v0.0.1 => 0.0.1

    // Binary name on Windows has .exe suffix
    if (process.platform === "win32") {
        binName += ".exe"
    }

    assetName = assetName.replace(/{{arch}}/g, ARCH_MAPPING[process.arch]);
    assetName = assetName.replace(/{{platform}}/g, PLATFORM_MAPPING[process.platform]);
    assetName = assetName.replace(/{{version}}/g, version);
    assetName = assetName.replace(/{{bin_name}}/g, binName);

    return {
        binName,
        binPath,
        version,
        auth,
        owner,
        repo,
        assetName
    }
}

/**
 * Reads the configuration from application's package.json,
 * validates properties, downloads the binary, untars, and stores at
 * ./bin in the package's root. NPM already has support to install binary files
 * specific locations when invoked with "npm install -g"
 *
 *  See: https://docs.npmjs.com/files/package.json#bin
 */
const INVALID_INPUT = "Invalid inputs";
function install(callback) {

    let opts = parsePackageJson();
    if (!opts) return callback(INVALID_INPUT);

    mkdirp.sync(opts.binPath);
    let ungz = zlib.createGunzip();
    let untar = tar.Extract({path: opts.binPath});

    ungz.on('error', callback);
    untar.on('error', callback);

    // First we will Un-GZip, then we will untar. So once untar is completed,
    // binary is downloaded into `binPath`. Verify the binary and call it good
    untar.on('end', verifyAndPlaceBinary.bind(null, opts.binName, opts.binPath, callback));

    let req;
    let token;

    if (opts.auth) {
        token = process.env['GITHUB_TOKEN'];

        if (!token) {
            console.error("Please provide username in options and GITHUB_TOKEN environment variable to authenticate");
            return
        }
    }

    const releasesOptions = octokit.endpoint("GET /repos/{owner}/{repo}/releases", {
        headers: {
            authorization: !!token ? `token ${token}` : undefined
        },
        owner: opts.owner,
        repo: opts.repo
    });

    const onReleaseResponse = (error, res, body) => {
        if (error) {
            return callback("Error downloading from URL: " + releasesOptions.url + " " + error)
        }

        if (res.statusCode !== 200) return callback("Error requesting release info. HTTP Status Code: " + res.statusCode);

        let tag = 'v' + opts.version;

        const responseBody = JSON.parse(body);

        let release = responseBody.find(function (x) {
            return x.tag_name === tag;
        });

        if (!release) {
            return callback('Release with tag ' + tag + ' not found');
        }

        let asset = release.assets.find(function (x) {
            return x.name === opts.assetName;
        });

        if (!asset) {
            return callback('Asset with name ' + opts.assetName + ' not found');
        }

        let assetOptions = octokit.endpoint("GET /repos/{owner}/{repo}/releases/assets/{asset_id}", {
            headers: {
                authorization: !!token ? 'token ' + token : undefined,
                Accept: "application/octet-stream"
            },
            owner: opts.owner,
            repo: opts.repo,
            asset_id: asset.id
        });

        let assetRequest = request(assetOptions);

        assetRequest.on('error', callback.bind(null, "Error downloading from URL: " + opts.url));
        assetRequest.on('response', function (res) {
            if (res.statusCode !== 200) return callback("Error downloading binary. HTTP Status Code: " + res.statusCode);

            assetRequest.pipe(ungz).pipe(untar);
        });
    }

    request(releasesOptions, onReleaseResponse);
}

function uninstall(callback) {

    let opts = parsePackageJson();
    getInstallationPath(function(err, installationPath) {
        if (err) callback("Error finding binary installation directory");

        try {
            fs.unlinkSync(path.join(installationPath, opts.binName));
        } catch(ex) {
            // Ignore errors when deleting the file.
        }

        return callback(null);
    });
}


// Parse command line arguments and call the right method
let actions = {
    "install": install,
    "uninstall": uninstall
};

let argv = process.argv;
if (argv && argv.length > 2) {
    let cmd = process.argv[2];
    if (!actions[cmd]) {
        console.log("Invalid command to go-npm. `install` and `uninstall` are the only supported commands");
        process.exit(1);
    }

    actions[cmd](function(err) {
        if (err) {
            console.error(err);
            process.exit(1);
        } else {
            process.exit(0);
        }
    });
}



