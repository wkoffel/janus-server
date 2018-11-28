require('dotenv').config();

runningOnPi = (process.env.ON_PI == "true");

var gpio;
if(runningOnPi) {
  gpio = require("pi-gpio");
}

var door0_pin = 16; // Pi GPIO23
var door1_pin = 18; // Pi GPIO24

const {Storage} = require('@google-cloud/storage');
const projectId = 'janus-223601';
const bucketName = 'janus-223601';
const storage = new Storage({projectId: projectId});
const bucket = storage.bucket(bucketName);

const fs = require('fs');

var spawn = require('child_process').spawn;
var proc;

// launch a raspistill process to continuously capture the current image
var args = ["-n", "-w", "640", "-h", "480", "-hf", "-vf", "-o", "/tmp/garage-image.jpg", "-t", "0", "-tl", "500"];
if(runningOnPi) {
  proc = spawn('raspistill', args);
} else {
  console.log("[nopi] Launching raspistill")
}

var pubnub = require("pubnub")({
    ssl           : true,  // <- enable TLS Tunneling over TCP
    publish_key   : process.env.PN_PUB_KEY,
    subscribe_key : process.env.PN_SUB_KEY
});

function uploadNewImage() {
  sourceFile = '/tmp/garage-image.jpg'
  // upload and then notify
  fs.stat(sourceFile, function(err, stat) {
    if(err == null) {
      // the file exists
      bucket.upload('/tmp/garage-image.jpg', function(err, file, apiResponse) {
        if(err) {
          console.log("Error uploading image.", err, data);
        } else {
          file.makePublic();
          notifyNewImage("garage-image.jpg")
        }
      });
    } else if(err.code == 'ENOENT') {
        // file does not exist
        console.log("File " + sourceFile + " does not exist, skipping upload.")
    } else {
        console.log('Error looking for image file: ', err.code);
    }
  });
}

function notifyNewImage(imageKey) {
  pubnub.publish({
      channel   : 'image_ready',
      message   : {"url" : imageKey, "ts" : Date.now()},
      error     : function(e) { console.log( "Failed to send image_ready notification.", e ); }
  });
}

function pushGarageButton(door) {
    console.log("toggle garage door ", door);
    var door_pin = door0_pin;
    if(door > 0) {
      door_pin = door1_pin;
    }

    if(runningOnPi) {
      gpio.open(door_pin, "output pullup", function() {
        gpio.write(door_pin, 0);
        console.log("on");
        setTimeout(function() {
          console.log("off");
          gpio.write(door_pin, 1);
          gpio.close(door_pin);
        }, 1000);
      });
    } else {
      console.log("[nopi] GPIO pin triggered")
    }
}

/* ---------------------------------------------------------------------------
Listen for Messages
--------------------------------------------------------------------------- */
pubnub.subscribe({
    channel  : "capture_image",
    callback : function(message) {
      console.log( " > ", message );
      uploadNewImage();
    }
});

pubnub.subscribe({
    channel  : "door_button",
    callback : function(message) {
      console.log( " > ", message );
      pushGarageButton(parseInt(message.door));
    }
});

console.log("Booted and ready to serve.")
