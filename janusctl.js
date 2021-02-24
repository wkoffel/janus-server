#!/usr/bin/env node

require('dotenv').config();

/* ******************************** */
/* CLI Client for Janus Door Server */
/* ******************************** */

/**
 * GCS Initialization
 */
const {Storage} = require('@google-cloud/storage');
const storage = new Storage();
const bucketName = 'janus-223601';
const bucket = storage.bucket(bucketName);

/**
 * Firebase initialization
 */
const {Firestore} = require('@google-cloud/firestore');
const firestore = new Firestore();
const doorCollection = "door_requests";
const imageCollection = "image_requests"

function doorButtonPressed(buttonIndex = 0) {
  let collectionRef = firestore.collection(doorCollection);
  collectionRef.add({
    "door": buttonIndex,
    "requested_at": Firestore.FieldValue.serverTimestamp(),
    "status": "pending",
    "user": "cli@koffel.org"
  }).then(documentReference => {
    console.log(`Added document with name: ${documentReference.id}`);
  });
}

function downloadLatestImage(filename = 'garage-image.jpg') {
  dest = `${process.env.HOME}/Downloads/${filename}`
  file = bucket.file(filename);
  file.download({
    destination: dest
  }, function(err) {
    if(err) {
      console.log("Failed to download image from Cloud Storage: " + err);
    } else {
      console.log("Downloaded to " + dest);
    }
  });
}

function requestFreshImage() {
  let collectionRef = firestore.collection(imageCollection);
  collectionRef.add({
    "requested_at": Firestore.FieldValue.serverTimestamp(),
    "status": "pending",
    "user": "cli@koffel.org"
  }).then(documentReference => {
    console.log(`Added document with name: ${documentReference.id}`);
  });
}

argv = require('yargs') // eslint-disable-line
  .scriptName("janusctrl.js")
  .usage("$0 <cmd> [args]")
  .version(false)
  .command('door [num]', 'push door button [num]', (yargs) => {
    yargs
      .positional('num', {
        type: 'number',
        describe: 'door button number',
        default: 0
      })
  }, (argv) => {
    if (argv.verbose) console.info(`door button :${argv.num}`)
    if(Math.abs(argv.num) <= 1) {
      doorButtonPressed(argv.num)
    } else {
      console.log("Error: door button number must be 0 or 1");
    }
  })
  .command('image <action>', 'refresh or download image', (yargs) => {
    yargs
      .positional('action', {
        type: 'string',
        describe: 'image action, "refresh" or "download"',
        default: "refresh"
      })
  }, (argv) => {
    if (argv.verbose) console.info(`fetching new image`);
    if(argv.action == "refresh") {
      requestFreshImage();
    } else if(argv.action == "download") {
      downloadLatestImage();
    } else {
      console.log("Error: unknown image action: " + argv.action);
    }
  })
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    description: 'Run with verbose logging'
  })
  .argv

