var MARKER = '.dmtools-target-workingdir';
var SAFE_MARKER_COMMAND = 'bash -c "test ! -L ' + MARKER + ' -a ! -d ' + MARKER + '"';

function isUntrackedMarkerConflict(command, error) {
    var message = String(error);
    return /^git checkout (?!\-\-)/.test(command) &&
        /untracked working tree files would be overwritten by checkout:/i.test(message) &&
        /^\s*\.dmtools-target-workingdir\s*$/m.test(message);
}

function createCheckoutGuard(execute) {
    var active = false;
    var backup = null;

    function runMarkerCommand(command, workingDirectory) {
        var args = { command: command };
        if (workingDirectory) args.workingDirectory = workingDirectory;
        return execute(args);
    }

    function stash(workingDirectory) {
        var dir = String(runMarkerCommand('bash -c "mktemp -d -t dmtools-marker.XXXXXXXX"', workingDirectory)).trim();
        if (!/^\/[a-zA-Z0-9._/-]+\/dmtools-marker\.[a-zA-Z0-9._-]+$/.test(dir) ||
            dir.indexOf('/../') !== -1) {
            throw new Error('Unexpected temporary marker directory: ' + dir);
        }
        try {
            runMarkerCommand('bash -c "mv -- ' + MARKER + ' ' + dir + '/marker"', workingDirectory);
        } catch (e) {
            try { runMarkerCommand('bash -c "rmdir -- ' + dir + '"', workingDirectory); } catch (cleanupErr) {
                console.warn('Could not remove empty marker backup directory:', dir, cleanupErr);
            }
            throw e;
        }
        backup = { dir: dir, workingDirectory: workingDirectory };
        console.warn('Temporarily saved the existing working-directory marker:', dir + '/marker');
    }

    function restore() {
        if (!backup) return true;
        var dir = backup.dir;
        var workingDirectory = backup.workingDirectory;
        try {
            runMarkerCommand(SAFE_MARKER_COMMAND, workingDirectory);
            runMarkerCommand('bash -c "rm -f -- ' + MARKER + '"', workingDirectory);
            runMarkerCommand('bash -c "mv -- ' + dir + '/marker ' + MARKER + '"', workingDirectory);
        } catch (e) {
            console.error('Could not restore the existing working-directory marker; backup remains at ' + dir + '/marker:', e);
            return false;
        }
        backup = null;
        try { runMarkerCommand('bash -c "rmdir -- ' + dir + '"', workingDirectory); } catch (e) {
            console.warn('Could not remove empty marker backup directory:', dir, e);
        }
        return true;
    }

    return {
        begin: function() {
            if (backup) {
                throw new Error('A previous working-directory marker could not be restored; backup remains at ' +
                    backup.dir + '/marker');
            }
            active = true;
        },
        run: function(args) {
            try {
                return execute(args);
            } catch (e) {
                if (!active || backup || !isUntrackedMarkerConflict(args.command, e)) throw e;
                try {
                    stash(args.workingDirectory);
                } catch (backupErr) {
                    throw new Error('Could not preserve the existing working-directory marker: ' + backupErr + '; checkout failed: ' + e);
                }
                return execute(args);
            }
        },
        finish: function() {
            active = false;
            return restore();
        }
    };
}

function writeWorkingDirMarker(workingDir, execute, writeFile) {
    try {
        execute({ command: SAFE_MARKER_COMMAND });
    } catch (e) {
        throw new Error('Cannot safely write ' + MARKER + ': the path is a symlink, a directory, or could not be checked: ' + e);
    }
    try {
        writeFile({ path: MARKER, content: workingDir });
    } catch (e) {
        console.warn('Could not write ' + MARKER + ':', e);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        createCheckoutGuard: createCheckoutGuard,
        writeWorkingDirMarker: writeWorkingDirMarker
    };
}
