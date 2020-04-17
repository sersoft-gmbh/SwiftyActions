import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as tools from '@actions/tool-cache';
import * as io from '@actions/io';
import * as fs from "fs";
import * as util from "util";
import * as path from "path";

async function runCmd(cmd: string, args?: string[], failOnStdErr: boolean = true): Promise<string> {
    let stdOut = '';
    await exec.exec(cmd, args, {
        failOnStdErr: failOnStdErr,
        listeners: {
            stdline: (data: string) => stdOut += data
        }
    });
    return stdOut;
}

async function install(installBase: string, branchName: string, versionTag: string, platform: string) {
    const tempPath = await core.group('Setup paths', async () => {
        await io.mkdirP(installBase);
        return await util.promisify(fs.mkdtemp)('SwiftyActions');
    });

    const swiftPkg = path.join(tempPath, "swift.tar.gz");
    const swiftSig = path.join(tempPath, "swift.tar.gz.sig");
    const allKeysFile = path.join(tempPath, "all-keys.asc");
    await core.group('Downloading files', async () => {
        const swiftURL = `https://swift.org/builds/${branchName}/${platform.split('.').join('')}/${versionTag}/${versionTag}-${platform}.tar.gz`;
        await Promise.all([
            tools.downloadTool(swiftURL, swiftPkg),
            tools.downloadTool(`${swiftURL}.sig`, swiftSig),
            tools.downloadTool('https://swift.org/keys/all-keys.asc', allKeysFile),
        ]);
    });

    await core.group('Verifying files', async () => {
        await runCmd('gpg', ['--import', allKeysFile], false);
        await runCmd('gpg', ['--verify', '--quiet', swiftSig, swiftPkg], false);
    });

    await core.group('Unpacking files', async () => {
        // We need to pass 'strip-components', so we cannot use 'tools.extractTar'
        await runCmd('tar', ['x', '--strip-components=1', '-C', installBase, '-f', swiftPkg]);
        // We need the -R option and want to simply add r (not knowing what the other permissions are), so we use the command line here.
        await runCmd('chmod', ['-R', 'o+r', path.join(installBase, '/usr/lib/swift')]);

    });

    await core.group('Cleaning up', async () => {
        await io.rmRF(tempPath);
    });
}

async function main() {
    switch (process.platform) {
        case "linux": break;
        default: throw new Error("This action can only install Swift on linux!");
    }

    core.startGroup('Validate input');
    const swiftRelease = core.getInput('release-version');

    let swiftBranch: string, swiftVersion: string;
    if (!swiftRelease) {
        core.info("`release-version` was not set. Requiring `branch-name` and `version-tag` parameters!");
        swiftBranch = core.getInput('branch-name', { required: true });
        swiftVersion = core.getInput('version-tag', { required: true });
    } else {
        swiftBranch = `swift-${swiftRelease}-release`;
        swiftVersion = `swift-${swiftRelease}-RELEASE`;
    }

    const swiftPlatform = core.getInput('platform');
    const skipApt = core.getInput('skip-apt') == 'true';
    core.endGroup();

    if (!skipApt) {
        await core.group('Install dependencies', async () => {
            await runCmd('sudo', ['apt-get', '-q', 'update']);
            await runCmd('sudo', [
                'apt-get', '-q', 'install', '-y',
                'libatomic1',
                'libbsd0',
                'libcurl4',
                'libxml2',
                'libedit2',
                'libsqlite3-0',
                'libc6-dev',
                'binutils',
                'libgcc-5-dev',
                'libstdc++-5-dev',
                'libpython2.7',
                'tzdata',
                'git',
                'pkg-config',
                'curl',
            ]);
        });
    } else {
        core.info("Skipping installation of dependencies...");
    }

    const versionIdentifier = `${swiftBranch}-${swiftVersion}-${swiftPlatform}`
    const mangledName = `swift.${versionIdentifier}`;
    const cachedVersion = tools.find(mangledName, '1.0.0');
    const swiftInstallBase = path.join('/opt/swift', versionIdentifier);
    if (cachedVersion) {
        core.info("Using cached version!");
        await io.cp(cachedVersion, swiftInstallBase, { recursive: true });
    } else {
        await install(swiftInstallBase, swiftBranch, swiftVersion, swiftPlatform);
        await tools.cacheDir(swiftInstallBase, mangledName, '1.0.0');
    }

    if (swiftRelease) {
        await core.group('Validating installation', async () => {
            const version = await runCmd(path.join(swiftInstallBase, '/usr/bin/swift'), ['--version']);
            if (!version.includes(swiftRelease)) {
                throw new Error(`Swift installation of version '${swiftRelease}' seems to have failed. 'swift --version' output: ${version}`);
            }
        });
    }

    core.addPath(path.join(swiftInstallBase, '/usr/bin'));
    core.setOutput('install-path', swiftInstallBase);
}

try {
    main().catch((error) => {
        core.setFailed(error.message);
    });
} catch (error) {
    core.setFailed(error.message);
}

