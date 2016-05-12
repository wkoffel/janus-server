require('dotenv').config();

var gpio = require("pi-gpio");

var door0_pin = 16; // Pi GPIO23
var door1_pin = 18; // Pi GPIO24

var AWS = require('aws-sdk');
var accessKey = process.env.AWS_ACCESS_KEY;
var secretKey = process.env.AWS_SECRET_KEY;
AWS.config.update({accessKeyId: accessKey, secretAccessKey: secretKey});
var s3 = new AWS.S3({apiVersion: '2006-03-01'});

const fs = require('fs');

var spawn = require('child_process').spawn;
var proc;

// launch a raspistill process to continuously capture the current image
var args = ["-n", "-w", "640", "-h", "480", "-hf", "-vf", "-o", "/tmp/garage-image.jpg", "-t", "0", "-tl", "500"];
proc = spawn('raspistill', args);

var pubnub = require("pubnub")({
    ssl           : true,  // <- enable TLS Tunneling over TCP
    publish_key   : process.env.PN_PUB_KEY,
    subscribe_key : process.env.PN_SUB_KEY
});

function uploadNewImage() {
  // upload and then notify
  stream = fs.createReadStream('/tmp/garage-image.jpg')
  var params = {
    Bucket: 'clearlytech',
    Key: 'garage-image.jpg',
    Body: stream,
    ContentType: 'image/jpg',
    ACL: 'public-read'
  };
  s3.putObject(params, function(err, data) {
    if(err) {
      console.log("Error uploading image.", err, data);
    } else {
      notifyNewImage("garage-image.jpg")
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

    gpio.open(door_pin, "output pullup", function() {
      gpio.write(door_pin, 0);
      console.log("on");
      setTimeout(function() {
        console.log("off");
        gpio.write(door_pin, 1);
        gpio.close(door_pin);
      }, 1000);
    });
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
