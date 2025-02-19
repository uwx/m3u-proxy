#!/usr/bin/env node

//@ts-check

const fs = require('fsxt');
const path = require('path');
const { Readable, Writable } = require('stream');

const byline = require('byline');
const flow = require('xml-flow');

const debug = require('debug')('m3u-proxy');

// Definitions for command line araguments
const definitions = [
  { name: 'config', alias: 'c', type: String, defaultValue: './config.json' }
];
const cmdLineArgs = require('command-line-args');
// const { resolve } = require('path');
// Set passed arguments
const args = cmdLineArgs(definitions);

const config = require(args.config);

/**
 * @param {string} url 
 * @param {string} filename 
 * @returns 
 */
async function getFile(url, filename) {
  debug(`> getFile: ${filename}`);

  // Prepare destination
  const dirname = path.dirname(filename);
  if (!await fs.pathExists(dirname)) await fs.mkdirp(dirname);
  const file = fs.createWriteStream(filename + '.tmp');
  // and download
  const response = await fetch(url);
  if (!response.ok) {
    await fs.unlink(filename + '.tmp');
    throw new Error(response.statusText);
  }
  await response.body?.pipeTo(Writable.toWeb(file));
  
  if (await fs.pathExists(filename)) await fs.unlink(filename);
  await fs.rename(filename + '.tmp', filename);
  debug(`< getFile: ${filename}`);
}

const M3UFilePrefix = /^#EXTM3U/;
const M3UPrefix = /^#EXTINF/;
const M3UFields = /^#EXTINF:-?\d+,?(?: *?([\w-]*)="(.*?)")?(?: *?([\w-]*)="(.*?)")?(?: *?([\w-]*)="(.*?)")?(?: *?([\w-]*)="(.*?)")?(?: *?([\w-]*)="(.*?)")?.*,(.*)/;

function processM3U(source, model) {
  debug(`> M3U-Process: ${source.name}${model.name}`);
  return new Promise(resolve => {
    // Preparation
    if (model.filters) {
      for (let i = 0; i < model.filters.length; i++)
        model.filters[i].regex = new RegExp(model.filters[i].regex, 'i');
    }
    if (model.transformations) {
      for (let i = 0; i < model.transformations.length; i++)
        model.transformations[i].regex = new RegExp(model.transformations[i].regex, 'i');
    }
    // Loop
    const stream = byline.createStream(fs.createReadStream(`${config.importFolder}/${source.name}.m3u`, { encoding: 'utf8' }));
    const streams = [];
    let fields = {};
    stream.on('data', (line) => {
      // byline skips empty lines
      if (line.match(M3UFilePrefix)) {
        // First line
      } else if (line.match(M3UPrefix)) {
        // We get fields
        const matches = line.match(M3UFields);
        // if (!matches) {
        // }
        try {
          for (let i = 1; i < 8; i += 2) {
            if (matches[i])
              fields[matches[i]] = matches[i + 1];
          }
          if (!fields['tvg-name'])
            fields['tvg-name'] = matches[11].trim();
          if (!fields['group-title'])
            fields['group-title'] = fields['tvg-name'].match(/\w*/); // Compact M3U files = no group-title
        } catch (err) {
          console.error(line);
        }
      } else {
        // And stream URL
        fields['stream'] = line;
        // Now let's check filters
        let valid;
        if (!model.filters) {
          valid = true;
        } else {
          valid = false;
          for (let i = 0; i < model.filters.length; i++) {
            if (model.filters[i].regex.test(fields[model.filters[i].field])) {
              valid = true;
              break;
            }
          }
        }
        // Do we need to apply transformations?
        if (valid && model.transformations) {
          for (let i = 0; i < model.transformations.length; i++) {
            fields[model.transformations[i].field] = fields[model.transformations[i].field].replace(model.transformations[i].regex, model.transformations[i].substitution);
          }
        }
        if (valid)
          streams.push(fields);
        fields = {};
      }
    });
    stream.on('end', () => {
      debug(`< M3U-Process: ${source.name}${model.name}`);
      resolve(streams);
    });
  });
}

async function exportM3U(source, model, streams) {
  debug(`> M3U-Write: ${source.name}${model.name}`);
  // Prepare destination
  if (!await fs.pathExists(`${config.exportFolder}`))
    await fs.mkdirp(`${config.exportFolder}`);
  const file = fs.createWriteStream(`${config.exportFolder}/${source.name}${model.name}.m3u`);
  // And export
  file.write('#EXTM3U\n');
  streams.forEach(stream => {
    file.write(`#EXTINF:-1`);
    if (stream['tvg-id'])
      file.write(` tvg-id="${stream['tvg-id']}"`);
    if (stream['tvg-name'])
      file.write(` tvg-name="${stream['tvg-name']}"`);
    if (stream['tvg-logo'])
      file.write(` tvg-logo="${stream['tvg-logo']}"`);
    file.write(` group-title="${stream['group-title']}",${stream['tvg-name']}\n`);
    file.write(`${stream['stream']}\n`);
  });
  file.end();
  debug(`< M3U-Write: ${source.name}${model.name}`);
}

/**
 * @param {string} dtStr
 */
function diffHours(dtStr) {
  const pattern = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2}) ([+\-0-9]{3})(\d{2})/;
  const dt = new Date(dtStr.replace(pattern, '$1-$2-$3 $4:$5:$6 $7:$8'));

  return (dt - new Date()) / 1000 / 60 / 60;
}

function processEPG(source, streams) {
  debug(`> EPG-Process: ${source.name}`);
  return new Promise(resolve => {
    // Always M3U before EPG, so no need to check export folder
    const xmlStream = flow(fs.createReadStream(`${config.importFolder}/${source.name}.xml`));
    const epg = fs.createWriteStream(`${config.exportFolder}/${source.name}.xml`);
    //
    epg.write('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv>\n');
    xmlStream.on('tag:channel', (node) => {
      if (typeof node.$attrs !== 'undefined' && node.$attrs.id !== '' && streams.indexOf(node.$attrs.id) >= 0) {
        epg.write(flow.toXml(node));
        epg.write('\n');
      }
    });
    xmlStream.on('tag:programme', (node) => {
      if (streams.indexOf(node.$attrs.channel) >= 0) {
        if (diffHours(node.$attrs.start) < 48 && diffHours(node.$attrs.stop) > -1) { // Starts in less than 48 hours and Finishes less than 1 hour ago
          epg.write(flow.toXml(node));
          epg.write('\n');
        }
      }
    });
    xmlStream.on('end', () => {
      epg.write('</tv>');
      debug(`< EPG-Process: ${source.name}`);
      resolve();
    });
  });
}

async function processSource(source) {
  debug(`> Source: ${source.name}`);

  let streams;

  try {
    await getFile(source.m3u, `${config.importFolder}/${source.name}.m3u`);
    const models = [];
    for (const model of source.models) {
      models.push(
        processM3U(source, model)
          .then(async result => await exportM3U(source, model, result))
      );
    }
    await Promise.all(models);
  } catch (err) {
    console.log(err);
  }

  if (source.epg) {
    try {
      await getFile(source.epg, `${config.importFolder}/${source.name}.xml`);
      streams = await processM3U(source, source.models[0]);
      await processEPG(source, streams.map(x => x['tvg-id']));
    } catch (err) {
      console.log(err);
    }
  }

  debug(`< Source: ${source.name}`);
}

(async () => {
  for (const source of config.sources) {
    await processSource(source);
  }
})();
