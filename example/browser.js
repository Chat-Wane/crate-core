
// #1 parse information in the url
var SIGNAL = null;
var PUBLIC = null;
var ACCESS = null;
var STUN = null;
var LOG = 10;
var WAIT = 0;
var INSERT = 1000;
var args = document.URL.split("?");
if (args.length > 1){
    var splittedArgs = args[1].split("&");
    for (var i = 0; i < splittedArgs.length; ++i){
        var arg = splittedArgs[i].split("=");
        switch (arg[0]){
        case "signal": SIGNAL = arg[1]; break;
        case "public": PUBLIC = arg[1]; break;
        case "access": ACCESS = arg[1]; break;
        case "stun"  : STUN   = arg[1]; break;
        case "log"   : LOG    = parseInt(arg[1])*60*1000; break;
        case "wait"  : WAIT   = parseInt(arg[1])*1000; break;
        case "insert": INSERT = parseInt(arg[1]); break;
        default: console.log("Unknow argument"); break;
        };
    };
};

console.log("SIGNAL = "+ SIGNAL);
console.log("ACCESS = "+ ACCESS);
console.log("PUBLIC = "+ PUBLIC);
console.log("STUN   = "+ STUN);
console.log("LOG    = "+ LOG);
console.log("WAIT   = "+ WAIT);
console.log("INSERT = "+ INSERT);

// #2 initialize the core of CRATE
var Core = require("crate-core");

var options = new Object();
if (STUN !== null){ options.config = new Object();
                    options.config.iceServers = [{url:STUN}]  };

var crate = new Core(null, options);
var n = crate.broadcast.source;
var s = crate.sequence;
var id = n.ID;

var startTime = null;
var signaling = null;
if ( SIGNAL !== null ){
    signaling = io.connect(SIGNAL);

    signaling.on('connect', function(){
        console.log('Successful connection to the signaling service');
        if (PUBLIC !== null){ signaling.emit('share', PUBLIC); };
        if (ACCESS !== null){
            startTime = new Date();
            n.launch(function(offerTicket){
                console.log('Create an offer ticket');
                signaling.emit('launch',
                               ACCESS, PUBLIC || offerTicket.id,
                               offerTicket);
            });
        };
    });
    signaling.on('disconnect', function(){
        console.log('Disconnected from the signaling service');
    });

    signaling.on('launchResponse', function(destUid, offerTicket){
        n.answer(offerTicket, function(stampedTicket){
            console.log('Create a stamped ticket');
            signaling.emit('answer', PUBLIC, destUid, stampedTicket);
        });
    });

    signaling.on('answerResponse', function(stampedTicket){
        console.log('Handshake');
        var firstConnectionTime = new Date() - startTime;
        signaling.emit('log', 'first connection time: '+firstConnectionTime+" ms");
        n.handshake(stampedTicket);
        if (PUBLIC === null){ signaling.disconnect(); }
    });

    function randomLog(){
        setTimeout(function(){
            var d = new Date();
            var t = d.toTimeString();
            var stringToLog = t+"; @peer "+n.ID+"; pv "+n.partialView.length()+
                "; dup "+ (n.partialView.length()-n.sockets.length()) +
                "; fwd "+ n.forwards.length() +
                "; pnd " + n.pending.length();
            signaling.emit("log", stringToLog);
            randomLog();
        }, Math.ceil(Math.random()*LOG)); // 5 minutes maximum
    };
    randomLog();
};

$("#idPeer").html("Ready - ID: "+id);

// #2 send logs to the signaling server
// #A concerning the membership protocol
setInterval(function(){
    var stringPartialView = ""
    if (n.partialView.length()>0){
        stringPartialView = " @@@@@ ";
        for (var i = 0; i < n.partialView.length(); ++i){
            stringPartialView += n.partialView.array.arr[i].id + "; ";
        };
    };
    $("#idPartialView").html("|partialView|: "+n.partialView.length()+
                             stringPartialView);
    $("#idSockets").html("|sockets|: " +n.sockets.length());
    $("#idForwards").html("|forwards|: "+n.forwards.length());
    $("#idPending").html("|pending|: "+n.pending.length());
},1000);

// #B concerning the sequence
setTimeout(function(){
    setInterval(function(){
        if (s.length >500000){return; };
        var d = new Date();
        var t = d.toTimeString();
        var freshId = crate.insert("A", s.length);
        var stringToLog = t+"; @peer "+n.ID+"; id "+
            JSON.stringify(freshId).length;
        signaling.emit("log", stringToLog);
        console.log(s.length + " ; " + stringToLog)
    }, INSERT);
}, WAIT);


n.on('statechange', function(state){
    $("#idPeer").html("Ready - ID: "+id+" ("+state+")");
});

$("#offer").click(function(){
    n.launch(function(message){
        $("#textID").val(JSON.stringify(message));
    });
});

$("#join").click(function(){
    var message = JSON.parse($("#textID").val());
    n.answer(message, function(stamped){
        $("#textID").val(JSON.stringify(stamped));
    });
});
$("#handshake").click(function(){
    var message = JSON.parse($("#textID").val());
    n.handshake(message);
});
