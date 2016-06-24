/// <reference path="../../definitions/vsts-task-lib.d.ts" />

import fs = require('fs');
import os = require('os');
import path = require('path');
import tl = require('vsts-task-lib/task');

var repoRoot : string = tl.getVariable('build.sourcesDirectory');

var rootFolder: string = makeAbsolute(path.normalize(tl.getPathInput('rootFolder', true, false).trim()));
var includeRootFolder:  boolean = tl.getBoolInput('includeRootFolder', true); 
var archiveType: string = tl.getInput('archiveType', true);
var archiveFile: string = path.normalize(tl.getPathInput('archiveFile', true, false).trim());
var replaceExistingArchive: boolean = tl.getBoolInput('replaceExistingArchive', true);

tl.debug('repoRoot: ' + repoRoot);

var win = os.type().match(/^Win/);
tl.debug('win: ' + win);

// archivers
var xpTarLocation : string;
var xpZipLocation : string;
// 7zip
var xpSevenZipLocation: string;
var winSevenZipLocation: string = path.join(process.cwd(), '7zip/7z.exe');

function getSevenZipLocation() : string {
    if(win){
        return winSevenZipLocation;
    } else {
        if (typeof xpTarLocation == "undefined") {
            xpSevenZipLocation = tl.which('7z', true);
        }
        return xpSevenZipLocation; 
    }
}

function findFiles(): string[] {
    if(includeRootFolder){
        return [path.basename(rootFolder)];
    } else {
        var fullPaths: string[] = fs.readdirSync(rootFolder);
        var baseNames: string[] = [];
        for(var i=0; i<fullPaths.length; i++){
            baseNames[i] = path.basename(fullPaths[i]);
        }
        return baseNames;
    }
}

function makeAbsolute(normalizedPath: string): string {
    tl.debug('makeAbsolute:' + normalizedPath);

    var result = normalizedPath;
    if (!path.isAbsolute(normalizedPath)) {
        result = path.join(repoRoot, normalizedPath);
        tl.debug('Relative file path: '+ normalizedPath+' resolving to: ' + result);
    }
    return result;
}

// Find matching archive files
var files: string [] = findFiles();
tl.debug('Found: ' + files.length + ' files to archive:');
for (var i = 0; i < files.length; i++) {
    tl.debug(files[i]);
}

// replaceExistingArchive before creation?
if (tl.exist(archiveFile)) {
    if(replaceExistingArchive){
        try {
            var stats = tl.stats(archiveFile);
            if(stats.isFile){
                console.log('removing existing archive file before creation: ' + archiveFile);
            } else {
                failTask('Specified archive file: '+ archiveFile + ' already exists and is not a file.');
            }
        } catch(e){
            failTask('Specified archive file: ' + archiveFile + ' can not be created because it can not be accessed: ' + e);
        }
    } else {
        console.log('Archive file: '+archiveFile +' already exists.  Attempting to add files to it.');
    }
}

function getOptions() {
    if(includeRootFolder){
        tl.debug("cwd (include root folder)= "+path.dirname(rootFolder));
        return {cwd: path.dirname(rootFolder)};
    } else {
        tl.debug("cwd (exclude root folder)= "+rootFolder);
        return {cwd: rootFolder};
    }
}

function sevenZipArchive(archive: string, compression: string, files : string []) {
    tl.debug('Creating archive with 7-zip: ' + archive);
    var sevenZip = tl.createToolRunner(getSevenZipLocation());
    sevenZip.arg('a');
    sevenZip.arg('-t' + compression);
    sevenZip.arg(archive);
    for(var i=0; i<files.length; i++){
        sevenZip.arg(files[i]);
    }
    return handleExecResult(sevenZip.execSync(getOptions()), archive);
}

// linux & mac only
function zipArchive(archive: string, files : string []) {
    tl.debug('Creating archive with zip: ' + archive);
    if(typeof xpZipLocation == "undefined") {
        xpZipLocation = tl.which('zip', true);
    }
    var zip = tl.createToolRunner(xpZipLocation);
    zip.arg('-r');
    zip.arg(archive);
    for(var i=0; i<files.length; i++){
        zip.arg(files[i]);
    }
    return handleExecResult(zip.execSync(getOptions()), archive);
}

// linux & mac only
function tarArchive(archive: string, compression: string, files: string[]) {
    tl.debug('Creating archive with tar: ' + archive+ ' using compression: '+compression);
    if (typeof xpTarLocation == "undefined") {
        xpTarLocation = tl.which('tar', true);
    }
    var tar = tl.createToolRunner(xpTarLocation);
    if(tl.exist(archive)){
        tar.arg('-r'); // append files to existing tar
    } else {
        tar.arg('-c'); // create new tar otherwise
    }
    if(compression){
        tar.arg('--'+compression);
    }
    tar.arg('-f');
    tar.arg(archive);
    for(var i=0; i<files.length; i++){
        tar.arg(files[i]);
    }
    return handleExecResult(tar.execSync(getOptions()), archive);
}

function handleExecResult(execResult, archive) {
    if (execResult.code != tl.TaskResult.Succeeded) {
        var message = 'Archive creation failed for archive file: ' + archive + ' See log for details.';
        failTask(message);
    }
}

function failTask(message: string) {
    tl.setResult(tl.TaskResult.Failed, message);
}

/**
 * Windows only
 * standard gnu-tar extension formats with recognized auto compression formats
 * https://www.gnu.org/software/tar/manual/html_section/tar_69.html
 *   
 * Computes the name of the tar to use inside a compressed tar.
 * E.g. foo.tar.gz is expected to have foo.tar inside
 */
function computeTarName(archiveName : string) : string {
    
    var lowerArchiveName = archiveName.toLowerCase();

    //standard full extensions
    //                     gzip        xz        bzip2
    var fullExtensions = ['.tar.gz', '.tar.xz', '.tar.bz2'];
    for(var i=0; i<fullExtensions.length; i++){
        if(lowerArchiveName.endsWith(fullExtensions[i])){
            return archiveName.substring(0, archiveName.lastIndexOf('.'));
        }
    }

    //standard abbreviated extensions
    //                 gzip    gzip    bzip2   bzip2   bzip2   xz
    var extensions = ['.tgz', '.taz', '.tz2', 'tbz2', '.tbz', '.txz'];
    for(var i=0; i<extensions.length; i++){
        if(lowerArchiveName.endsWith(extensions[i])){
            return archiveName.substring(0, archiveName.lastIndexOf('.')) + '.tar';
        }
    }

    // if 7zip falls down here, or if a .tz2 file is encountered, there is occasionally strange
    // behavior resulting in archives that are correct but are renamed
    // e.g. test.tz2 has test inside of it instead of test.tar (7z decides to rename it)
    // e.g. test_tgz has an outer name of test_tgz.gz (7z decides to add the .gz to it).

    //non standard name

    //foo.tar.anything --> foo.tar
    if (lowerArchiveName.lastIndexOf('.tar.') > 0){
        return archiveName.substring(0, lowerArchiveName.lastIndexOf('.tar.') + 4);
    }
    // foo.anything --> foo.tar
    else if (lowerArchiveName.lastIndexOf('.') > 0){
        return archiveName.substring(0, lowerArchiveName.lastIndexOf('.'))+'.tar';
    }
    // foo --> foo.tar
    return lowerArchiveName + '.tar';
}

//ensure output folder exists
var destinationFolder = path.dirname(archiveFile);
tl.debug("Checking for archive destination folder:"+destinationFolder);
if(!tl.exist(destinationFolder)){
    tl.debug("Destination folder does not exist, creating:"+destinationFolder);
    tl.mkdirP(destinationFolder);
}

if(win) { // windows only
    if(archiveType == "default"){ //default is zip format
        sevenZipArchive(archiveFile, "zip", files);
    } else if(archiveType == "tar"){
        var tarCompression: string = tl.getInput('tarCompression', true);
        if(tarCompression == "none"){
            sevenZipArchive(archiveFile, archiveType, files);        
        } else {
            var tarFile = computeTarName(archiveFile);
            var tarExists = tl.exist(tarFile);
            try {
                if(tarExists){
                    console.log('Intermediate tar: '+tarFile +' already exists.  Attempting to add files to it.');
                }
                
                // this file could already exist, but not checking because by default files will be added to it
                // create the tar file
                sevenZipArchive(tarFile, archiveType, files);
                // compress the tar file
                var sevenZipCompressionFlag = tarCompression;
                if(tarCompression == 'gz'){
                    sevenZipCompressionFlag = 'gzip';
                } else if (tarCompression == 'bz2'){
                    sevenZipCompressionFlag = 'bzip2';
                }
                sevenZipArchive(archiveFile, sevenZipCompressionFlag, [tarFile]);
            } finally {
                // delete the tar file if we created it.
                if(!tarExists){
                    fs.unlinkSync(tarFile);
                }
            }
        }
    } else {
        sevenZipArchive(archiveFile, archiveType, files);
    }
} else { // not windows
    if (archiveType == "default"){ //default is zip format
        zipArchive(archiveFile, files);
    } else if(archiveType == "tar"){
        var tarCompression: string = tl.getInput('tarCompression', true);
        var tarCompressionFlag;
        if(tarCompression == "none"){
            tarCompressionFlag = null;
        } else if (tarCompression == "gz"){
            tarCompressionFlag = "gz";
        } else if (tarCompression == "bz2"){
            tarCompressionFlag = "bzip2";
        } else if (tarCompression == "xz"){
            tarCompressionFlag = "xz";
        }
        tarArchive(archiveFile, tarCompressionFlag, files);
    } else {
        sevenZipArchive(archiveFile, archiveType, files);
    }
}

tl.setResult(tl.TaskResult.Succeeded, 'Successfully created archive: '+archiveFile);