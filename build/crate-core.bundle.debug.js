require=(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/*
 * \url https://github.com/justayak/yutils/blob/master/yutils.js
 * \author justayak
 */

/*!
 * \brief get a globally unique (with high probability) identifier
 * \return a string being the identifier
 */
function GUID(){
    var d = new Date().getTime();
    var guid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = (d + Math.random() * 16) % 16 | 0;
        d = Math.floor(d / 16);
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    return guid;
};

module.exports = GUID;

},{}],2:[function(require,module,exports){
/*!
 * \brief object that represents the result of an insert operation
 * \param insert the result of the local insert operation
 */
function MInsertOperation(insert){
    this.type = "MInsertOperation";
    this.insert = insert;
};
module.exports.MInsertOperation = MInsertOperation;

function MAEInsertOperation(insert, id){
    this.type = "MAEInsertOperation";
    this.payload = new MInsertOperation(insert);
    this.id = id;
    this.isReady = null;
};
module.exports.MAEInsertOperation = MAEInsertOperation;

/*!
 * \brief object that represents the result of a delete operation
 * \param remove the result of the local delete operation
 */
function MRemoveOperation(remove){
    this.type = "MRemoveOperation";
    this.remove = remove;
};
module.exports.MRemoveOperation = MRemoveOperation;

/*!
 * \brief object that represents the result of a caretMoved Operation
 * \param remove the result of the local caretMoved Operation
 */
function MCaretMovedOperation(caretMoved){
    this.type = "MCaretMovedOperation";
    this.caretMoved = caretMoved;
};
module.exports.MCaretMovedOperation = MCaretMovedOperation;
},{}],3:[function(require,module,exports){
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var GUID = require('./guid.js');

var MBroadcast = require('./messages').MBroadcast;
var MAntiEntropyRequest = require('./messages.js').MAntiEntropyRequest;
var MAntiEntropyResponse = require('./messages.js').MAntiEntropyResponse;

var Unicast = require('unicast-definition');

util.inherits(CausalBroadcast, EventEmitter);

/*!
 * It takes a unique value for peer and a counter to distinguish a message. It
 * emits 'receive' event when the message is considered ready
 * \param source the protocol receiving the messages
 * \param causality the causality tracking structure
 */
function CausalBroadcast(source, causality, name) {
    EventEmitter.call(this);
    this.name = name || 'causal';
    this.source = source;
    this.causality = causality;
    this.deltaAntiEntropy = 1000*60*1/2; // (TODO) configurable (currently 30s)
    this.unicast = new Unicast(this.source, this.name+'-unicast');

    // buffer of operations
    this.buffer = []; 
    // buffer of anti-entropy messages (chunkified because of large size)
    this.bufferAntiEntropy = new MAntiEntropyResponse('init');
    
    var self = this;
    this.source.on(self.name+'-broadcast-receive', function(socket, message){
        self.receiveBroadcast(message);
    });
    this.unicast.on('receive', function(socket, message){
        self.receiveUnicast(socket, message);
    });
    this.source.on('statechange', function(state){
        if (state==='connect'){
            self.unicast.send(new MAntiEntropyRequest(self.causality));
        };
    });
    setInterval(function(){
        self.unicast.send(new MAntiEntropyRequest(self.causality));
    }, self.deltaAntiEntropy);    
};

/*!
 * \brief broadcast the message to all participants
 * \param message the message to broadcast
 * \param id the id of the message
 * \param isReady the id(s) that must exist to deliver the message
 */
CausalBroadcast.prototype.send = function(message, id, isReady){
    // #1 get the neighborhood and create the message
    var links = this.source.getPeers(Number.MAX_VALUE);
    var mBroadcast = new MBroadcast(this.name, id || GUID(), isReady, message);
    // #2 register the message in the structure
    this.causality.incrementFrom(id);
    // #3 send the message to the neighborhood
    for (var i = 0; i < links.length; ++i){
        if (links[i].connected &&
            links[i]._channel && links[i]._channel.readyState==='open'){
            links[i].send(mBroadcast);
        };
    };
};

/*!
 * \brief answers to an antientropy request message with the missing elements
 * \param socket the origin of the request
 * \param causalityAtReceipt the local causality structure when the message was
 * received
 * \param messages the missing messages
 */ 
CausalBroadcast.prototype.sendAntiEntropyResponse =
    function(socket, causalityAtReceipt, messages){
        var id = GUID();
        // #1 metadata of the antientropy response
        this.unicast.send(new MAntiEntropyResponse(id,
                                                   causalityAtReceipt,
                                                   messages.length), socket);
        for (var i = 0; i < messages.length; ++i){
            this.unicast.send(new MAntiEntropyResponse(id,
                                                       null,
                                                       messages.length,
                                                       messages[i]),  socket);
        };
    };

/*!
 * \brief receive a broadcast message
 * \param message the received message
 */
CausalBroadcast.prototype.receiveBroadcast = function(message){
    var id = message.id,
        isReady = message.isReady;

    if (!this.stopPropagation(message)){
        // #1 register the operation
        this.buffer.push(message);
        // #2 deliver
        this.reviewBuffer();
        // #3 rebroadcast
        var links = this.source.getPeers(Number.MAX_VALUE);
        for (var i = 0; i < links.length; ++i){
            if (links[i].connected &&
                links[i]._channel && links[i]._channel.readyState==='open'){
                links[i].send(message);
            };
        };
    };
};

/*!
 * \brief go through the buffer of messages and delivers all
 * ready operations
 */
CausalBroadcast.prototype.reviewBuffer = function(){
    var found = false,
        i = this.buffer.length - 1;
    while(i>=0){
        var message = this.buffer[i];
        if (this.causality.isLower(message.id)){
            this.buffer.splice(i, 1);
        } else {
            if (this.causality.isReady(message.isReady)){
                found = true;
                this.causality.incrementFrom(message.id);
                this.buffer.splice(i, 1);
                this.emit('receive', message.payload);
            };
        };
        --i;
    };
    if (found){ this.reviewBuffer();  };
};

/*!
 * \brief receive a unicast message, i.e., either an antientropy request or an
 * antientropy response
 * \brief socket the origin of the message
 * \brief message the message received 
 */
CausalBroadcast.prototype.receiveUnicast = function(socket, message){
    switch (message.type){
    case 'MAntiEntropyRequest':
        this.emit('antiEntropy',
                  socket, message.causality, this.causality.clone());
        break;
    case 'MAntiEntropyResponse':
        // #A replace the buffered message
        if (this.bufferAntiEntropy.id !== message.id){
            this.bufferAntiEntropy = message;
        };
        // #B add the new element to the buffer        
        if (message.element){
            this.bufferAntiEntropy.elements.push(message.element);
        };
        // #C add causality metadata
        if (message.causality){
            this.bufferAntiEntropy.causality = message.causality;
        };
        // #D the buffered message is fully arrived, deliver
        if (this.bufferAntiEntropy.elements.length ===
            this.bufferAntiEntropy.nbElements){
            // #1 considere each message in the response independantly
            for (var i = 0; i<this.bufferAntiEntropy.elements.length; ++i){
                var element = this.bufferAntiEntropy.elements[i];
                // #2 only check if the message has not been received yet
                if (!this.stopPropagation(element)){
                    this.causality.incrementFrom(element.id);
                    this.emit('receive', element.payload);
                };
            };
            // #3 merge causality structures
            this.causality.merge(this.bufferAntiEntropy.causality);
        };
        break;
    };
};

/*!
 * \brief gets called when a broadcast message reaches this node.  this
 * function evaluates if the node should propagate the message further or if it
 * should stop sending it.
 * \param message a broadcast message
 * \return true if the message is already known, false otherwise
 */
CausalBroadcast.prototype.stopPropagation = function (message) {
    return this.causality.isLower(message.id) ||
        this.bufferIndexOf(message.id)>=0;
};

/*!
 * \brief get the index in the buffer of the message identified by id
 * \param id the identifier to search
 * \return the index of the message in the buffer, -1 if not found
 */
CausalBroadcast.prototype.bufferIndexOf = function(id){
    var found = false,
        index = -1,
        i = 0;
    while (!found && i<this.buffer.length){
        // (TODO) fix uglyness
        if (JSON.stringify(this.buffer[i].id) === JSON.stringify(id)){ 
            found = true; index = i;
        };
        ++i
    };
    return index;
};

module.exports = CausalBroadcast;

},{"./guid.js":4,"./messages":5,"./messages.js":5,"events":43,"unicast-definition":7,"util":64}],4:[function(require,module,exports){
arguments[4][1][0].apply(exports,arguments)
},{"dup":1}],5:[function(require,module,exports){

/*!
 * \brief message containing data to broadcast
 * \param name the name of the protocol, default 'causal'
 * \param id the identifier of the broadcast message
 * \param isReady the identifier(s) that must exist to deliver this message
 * \param payload the broadcasted data
 */
function MBroadcast(name, id, isReady, payload){
    this.protocol = (name && name+'-broadcast') || 'causal-broadcast';
    this.id = id;
    this.isReady = isReady;
    this.payload = payload;
};
module.exports.MBroadcast = MBroadcast;

/*!
 * \brief message that request an AntiEntropy 
 * \param causality the causality structure
 */
function MAntiEntropyRequest(causality){
    this.type = 'MAntiEntropyRequest';
    this.causality = causality;
};
module.exports.MAntiEntropyRequest = MAntiEntropyRequest;

/*!
 * \brief message responding to the AntiEntropy request
 * \param id the identifier of the response message
 * \param causality the causality structure
 * \param nbElements the number of element to send
 * \param element each element to send 
 */
function MAntiEntropyResponse(id, causality, nbElements, element){
    this.type = 'MAntiEntropyResponse';
    this.id = id;
    this.causality = causality;
    this.nbElements = nbElements;
    this.element = element;
    this.elements = [];
};
module.exports.MAntiEntropyResponse = MAntiEntropyResponse;


},{}],6:[function(require,module,exports){

/*!
 * \brief message containing data to unicast
 * \param name the protocol name
 * \param payload the sent data
 */
function MUnicast(name, payload){
    this.protocol = name || 'unicast';
    this.payload = payload;
};
module.exports.MUnicast = MUnicast;

},{}],7:[function(require,module,exports){
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var MUnicast = require('./messages').MUnicast;

util.inherits(Unicast, EventEmitter);

/*!
 * Unicast component that simply chose a random peer and send a message
 * \param source the protocol receiving the messages
 * \param name the name of the protocol, default is 'unicast'
 */
function Unicast(source, max, name) {
    EventEmitter.call(this);
    this.name = name || 'unicast';
    this.source = source;
    var self = this;
    this.source.on(self.name+'-receive', function(socket, message){
        self.emit('receive', socket, message.payload);
    });
};

/*!
 * \brief send the message to one random participant
 * \param message the message to send
 * \param socket optional known socket
 */
Unicast.prototype.send = function(message, socket){
    // #1 get the neighborhood and create the message
    var links = (socket && [socket]) || this.source.getPeers(1);
    var mUnicast = new MUnicast(this.name, message);
    // #2 send the message
    if (links.length>0 && links[0].connected){
        links[0].send(mUnicast);
    };
};

module.exports = Unicast;

},{"./messages":6,"events":43,"util":64}],8:[function(require,module,exports){
var BI = require('BigInt');

/*!
 * \class Base
 * \brief provides basic function to bit manipulation
 * \param b the number of bits at level 0 of the dense space
 */
function Base(b){    
    var DEFAULT_BASE = 3;
    this._b = b || DEFAULT_BASE;
};

/*!
 * \brief Process the number of bits usage at a certain level of dense space
 * \param level the level in dense space, i.e., the number of concatenation
 */
Base.prototype.getBitBase = function(level){
    return this._b + level;
};

/*!
 * \brief Process the total number of bits usage to get to a certain level
 * \param level the level in dense space
 */
Base.prototype.getSumBit = function(level){
    var n = this.getBitBase(level),
        m = this._b-1;
    return (n * (n + 1)) / 2 - (m * (m + 1) / 2);
};

/*!
  \brief process the interval between two LSEQNode
  \param p the previous LSEQNode
  \param q the next LSEQNode
  \param level the depth of the tree to process
  \return an integer which is the interval between the two node at the depth
*/
Base.prototype.getInterval = function(p, q, level){
    var sum = 0, i = 0,
        pIsGreater = false, commonRoot = true,
        prevValue = 0, nextValue = 0;
    
    while (i<=level){
        prevValue = 0; if (p !== null){ prevValue = p.t.p; }
        nextValue = 0; if (q !== null){ nextValue = q.t.p; }
        if (commonRoot && prevValue !== nextValue){
            commonRoot = false;
            pIsGreater = prevValue > nextValue;
        }
        if (pIsGreater){ nextValue = Math.pow(2,this.getBitBase(i))-1; }
        if (commonRoot || pIsGreater || i!==level){
            sum += nextValue - prevValue; 
        } else {
            sum += nextValue - prevValue - 1;
        }
        if (i!==level){
            sum *= Math.pow(2,this.getBitBase(i+1));
        };
        if (p!==null && p.children.length!==0){p=p.children[0];} else{p=null;};
        if (q!==null && q.children.length!==0){q=q.children[0];} else{q=null;};
        ++i;
    }
    return sum;
};

Base.instance = null;

module.exports = function(args){
    if (args){
        Base.instance = new Base(args);
    } else {
        if (Base.instance === null){
            Base.instance = new Base();
        };
    };
    return Base.instance;
};

},{"BigInt":15}],9:[function(require,module,exports){
var BI = require('BigInt');
var Base = require('./base.js')();
var Triple = require('./triple.js');
var LSEQNode = require('./lseqnode.js');

/*!
 * \class Identifier
 * \brief Unique and immutable identifier composed of digit, sources, counters
 * \param d the digit (position in dense space)
 * \param s the list of sources
 * \param c the list of counters
 */
function Identifier(d, s, c){
    this._d = d;
    this._s = s;
    this._c = c;
};

/*!
 * \brief set the d,s,c values according to the node in argument
 * \param node the lseqnode containing the path in the tree structure
 */
Identifier.prototype.fromNode = function(node){
    // #1 process the length of the path
    var length = 1, tempNode = node, i = 0;
    
    while (tempNode.children.length !== 0){
	++length;
        tempNode = tempNode.children[0];
    };
    // #1 copy the values contained in the path
    this._d = BI.int2bigInt(0,Base.getSumBit(length - 1));
    
    for (var i = 0; i < length ; ++i){
        // #1a copy the site id
        this._s.push(node.t.s);
        // #1b copy the counter
        this._c.push(node.t.c);
        // #1c copy the digit
        BI.addInt_(this._d, node.t.p);
        if (i!==(length-1)){
            BI.leftShift_(this._d, Base.getBitBase(i+1));
        };
        node = node.children[0];
    };
};

/*!
 * \brief convert the identifier into a node without element
 * \param e the element associated with the node
 */
Identifier.prototype.toNode = function(e){
    var resultPath = [], dBitLength = Base.getSumBit(this._c.length -1), i = 0,
        mine;
    // #1 deconstruct the digit 
    for (var i = 0; i < this._c.length; ++i){
        // #1 truncate mine
        mine = BI.dup(this._d);
        // #1a shift right to erase the tail of the path
        BI.rightShift_(mine, dBitLength - Base.getSumBit(i));
        // #1b copy value in the result
        resultPath.push(new Triple(BI.modInt(mine,
                                             Math.pow(2,Base.getBitBase(i))),
                                   this._s[i],
                                   this._c[i]));
    };
    return new LSEQNode(resultPath, e);
};

/*!
 * \brief compare two identifiers
 * \param o the other identifier
 * \return -1 if this is lower, 0 if they are equal, 1 if this is greater
 */
Identifier.prototype.compare = function(o){
    var dBitLength = Base.getSumBit(this._c.length - 1),
        odBitLength = Base.getSumBit(o._c.length - 1),
        comparing = true,
        comp = 0, i = 0,
        sum, mine, other;
    
    // #1 Compare the list of <d,s,c>
    while (comparing && i < Math.min(this._c.length, o._c.length) ) {
        // can stop before the end of for loop wiz return
        sum = Base.getSumBit(i);
        // #1a truncate mine
        mine = BI.dup(this._d);
        BI.rightShift_(mine, dBitLength - sum);
        // #1b truncate other
        other = BI.dup(o._d);
        BI.rightShift_(other, odBitLength - sum);
        // #2 Compare triples
        if (!BI.equals(mine,other)) {  // #2a digit
            if (BI.greater(mine,other)){comp = 1;}else{comp = -1;};
            comparing = false;
        } else {
            comp = this._s[i] - o._s[i]; // #2b source
            if (comp !== 0) {
                comparing = false;
            } else {
                comp = this._c[i] - o._c[i]; // 2c clock
                if (comp !== 0) {
                    comparing = false;
                };
            };
        };
        ++i;
    };
    
    if (comp===0){
        comp = this._c.length - o._c.length; // #3 compare list size
    };
    return comp;
};


module.exports = Identifier;

},{"./base.js":8,"./lseqnode.js":10,"./triple.js":13,"BigInt":15}],10:[function(require,module,exports){
var Triple = require('./triple.js');
require('./util.js');

/*!
 * \brief a node of the LSEQ tree
 * \param tripleList the list of triple composing the path to the element
 * \param element the element to insert in the structure
 */
function LSEQNode(tripleList, element){
    this.t = tripleList.shift();
    if (tripleList.length === 0){
        this.e = element;
        this.subCounter = 0; // count the number of children and subchildren
        this.children = [];
    } else {
        this.e = null;
        this.subCounter = 1;
        this.children = [];
        this.children.push(new LSEQNode(tripleList, element));
    };
};

/*!
 * \brief add a path element to the current node
 * \param node the node to add as a children of this node
 * \return -1 if the element already exists
 */
LSEQNode.prototype.add = function(node){
    var index = this.children.binaryIndexOf(node);
    
    // #1 if the path do no exist, create it
    if (index < 0 || this.children.length === 0  ||
        (index === 0 && this.children.length > 0 && 
         this.children[0].compare(node)!==0)){
        this.children.splice(-index, 0, node);
        this.subCounter+=1;
    } else {
        // #2 otherwise, continue to explore the subtrees
        if (node.children.length === 0){
            // #2a check if the element already exists
            if (this.children[index].e !== null){
                return -1;
            } else {
                this.children[index].e = node.e;
                this.subCounter+=1;
            };
        } else {
            // #3 if didnot exist, increment the counter
            if (this.children[index].add(node.children[0])!==-1){
                this.subCounter+=1;
            };
        };
    };
};

/*! 
 * \brief remove the node of the tree and all node within path being useless
 * \param node the node containing the path to remove
 * \return -1 if the node does not exist
 */
LSEQNode.prototype.del = function(node){
    var indexes = this.getIndexes(node),
        currentTree = this, i = 0, isSplitted = false;

    if (indexes === -1) { return -1; }; // it does not exists
    this.subCounter -= 1;
    while (i < indexes.length && !(isSplitted)){
        if (!(currentTree.children[indexes[i]].e !== null &&
              i===(indexes.length - 1))){
            currentTree.children[indexes[i]].subCounter -= 1;     
        };
        if (currentTree.children[indexes[i]].subCounter <= 0
            && (currentTree.children[indexes[i]].e === null ||
                (currentTree.children[indexes[i]].e !== null &&
                 i===(indexes.length - 1)))){
            currentTree.children.splice(indexes[i],1);
            isSplitted = true;
        };
        currentTree = currentTree.children[indexes[i]];
        ++i;
    };
    if (!isSplitted){ currentTree.e = null;};
};

/*!
 * \brief comparison function used to order the list of children at each node
 * \param o the other node to compare with
 */
LSEQNode.prototype.compare = function(o){
    return this.t.compare(o.t);
};

/*!
 * \brief the ordered tree can be linearized into a sequence. This function get
 * the index of the path represented by the list of triples
 * \param node the node containing the path
 * \return the index of the path in the node
 */
LSEQNode.prototype.indexOf = function(node){
    var indexes = this.getIndexes(node),
        sum = 0, currentTree = this,
        j = 0;
    if (indexes === -1){return -1;}; // node does not exist
    if (this.e !== null){ sum +=1; };
    
    for (var i = 0; i<indexes.length; ++i){
        if (indexes[i] < (currentTree.children.length/2)){
            // #A start from the beginning
            for (var j = 0; j<indexes[i]; ++j){
                if (currentTree.children[j].e !== null){ sum+=1; };
                sum += currentTree.children[j].subCounter;
            };
        } else {
            // #B start from the end
            sum += currentTree.subCounter;
            for (var j = currentTree.children.length-1; j>=indexes[i];--j){
                if (currentTree.children[j].e !== null){ sum-=1; };
                sum -= currentTree.children[j].subCounter;  
            };
            j += 1;
        };
        if (currentTree.children[j].e !== null){ sum+=1; };
        currentTree = currentTree.children[j];
    };
    return sum-1; // -1 because algorithm counted the element itself
};

/*!
 * \brief get the list of indexes of the arrays representing the children in
 * the tree
 * \param node the node containing the path
 * \return a list of integer
 */
LSEQNode.prototype.getIndexes = function(node){
    function _getIndexes(indexes, currentTree, currentNode){
        var index = currentTree.children.binaryIndexOf(currentNode);
        if (index < 0 ||
            (index===0 && currentTree.children.length===0)){ return -1; }
        indexes.push(index);
        if (currentNode.children.length===0 ||
            currentTree.children.length===0){
            return indexes;
        };
        return _getIndexes(indexes,
                           currentTree.children[index],
                           currentNode.children[0]);
        
    };
    return _getIndexes([], this, node);
};

/*!
 * \brief the ordered tree can be linearized. This function gets the node at
 * the index in the projected sequence.
 * \param index the index in the sequence
 * \returns the node at the index
 */
LSEQNode.prototype.get = function(index){
    function _get(leftSum, buildingNode, queue, currentNode){
        var startBeginning = true, useFunction, i = 0,
            p, temp;
        // #0 the node is found, return the incrementally built node and praise
        // #the sun !
        if (leftSum === index && currentNode.e !== null){
            // 1a copy the value of the element in the path
            queue.e = currentNode.e;
            return buildingNode;
        };
        if (currentNode.e !== null){ leftSum += 1; };

        // #1 search: do I start from the beginning or the end
        startBeginning = ((index-leftSum)<(currentNode.subCounter/2));
        if (startBeginning){
            useFunction = function(a,b){return a+b;};
        } else {
            leftSum += currentNode.subCounter;
            useFunction = function(a,b){return a-b;};
        }

        // #2a counting the element from left to right
        if (!startBeginning) { i = currentNode.children.length-1; };
        while ((startBeginning && leftSum <= index) ||
               (!startBeginning && leftSum > index)){
            if (currentNode.children[i].e!==null){
                leftSum = useFunction(leftSum, 1);
            };
            leftSum = useFunction(leftSum,currentNode.children[i].subCounter);
            i = useFunction(i, 1);
        };

        // #2b decreasing the incrementation
        i = useFunction(i,-1);
        if (startBeginning){
            if (currentNode.children[i].e!==null){
                leftSum = useFunction(leftSum, -1);
            };
            leftSum = useFunction(leftSum,-currentNode.children[i].subCounter);
        };
        
        // #3 build path
        p = []; p.push(currentNode.children[i].t);
        if (buildingNode === null){
            buildingNode = new LSEQNode(p,null);
            queue = buildingNode;
        } else {
            temp = new LSEQNode(p,null);
            queue.add(temp);
            queue = temp;
        };
        return _get(leftSum, buildingNode, queue,
                    currentNode.children[i]);
    };
    return _get(0, null, null, this);
};

/*!
 * \brief cast the JSON object to a LSEQNode
 * \param object the JSON object
 * \return a self reference
 */
LSEQNode.prototype.fromJSON = function(object){
    this.t = new Triple(object.t.p, object.t.s, object.t.c);
    if (object.children.length === 0){
        this.e = object.e;
        this.subCounter = 0;
        this.children = [];
    } else {
        this.e = null;
        this.subCounter = 1;
        this.children = [];
        this.children.push(
            (new LSEQNode([], null).fromJSON(object.children[0])));
    };
    return this;
};

module.exports = LSEQNode;

},{"./triple.js":13,"./util.js":14}],11:[function(require,module,exports){
var BI = require('BigInt');
var Base = require('./base.js')(15);
var S = require('./strategy.js')(10);
var ID = require('./identifier.js');
var Triple = require('./triple.js');
var LSEQNode = require('./lseqnode.js');

/*!
 * \class LSEQTree
 *
 * \brief Distributed array using LSEQ allocation strategy with an underlying
 * exponential tree model
 */
function LSEQTree(s){
    var listTriple;
    
    this._s = s;
    this._c = 0;
    this._hash = function(depth) { return depth%2; };
    this.length = 0;

    this.root = new LSEQNode([],null);
    listTriple = []; listTriple.push(new Triple(0,0,0));  // min bound
    this.root.add(new LSEQNode(listTriple, ""));
    listTriple = [];
    listTriple.push(new Triple(Math.pow(2,Base.getBitBase(0))-1,
                               Number.MAX_VALUE,
                               Number.MAX_VALUE)); // max bound
    this.root.add(new LSEQNode(listTriple, ""));
};

/*!
 * \brief return the LSEQNode of the element at  targeted index
 * \param index the index of the element in the flattened array
 * \return the LSEQNode targeting the element at index
 */
LSEQTree.prototype.get = function(index){
    // #1 search in the tree to get the value
    return this.root.get(index);
};

/*!
 * \brief insert a value at the targeted index
 * \param element the element to insert
 * \param index the position in the array
 * \return a pair {_e: element , _i: identifier}
 */
LSEQTree.prototype.insert = function(element, index){
    var pei = this.get(index), // #1a previous bound
        qei = this.get(index+1), // #1b next bound
        id, couple;
    this._c += 1; // #2a incrementing the local counter
    id = this.alloc(pei, qei); // #2b generating the id inbetween the bounds
    // #3 add it to the structure and return value
    couple = {_e: element, _i: id}
    this.applyInsert(element, id, true);
    return couple;
};

/*!
 * \brief delete the element at the index
 * \param index the index of the element to delete in the array
 * \return the identifier of the element at the index
 */
LSEQTree.prototype.remove = function(index){
    var ei = this.get(index+1),
        i = new ID(null, [], []);
    i.fromNode(ei); // from node -> id
    this.applyRemove(ei); 
    return i;
};

/*!
 * \brief generate the digit part of the identifiers  between p and q
 * \param p the digit part of the previous identifier
 * \param q the digit part of the next identifier
 * \return the digit part located between p and q
 */
LSEQTree.prototype.alloc = function (p,q){
    var interval = 0, level = 0;
    // #1 process the level of the new identifier
    while (interval<=0){ // no room for insertion
        interval = Base.getInterval(p, q, level); // (TODO) optimize
        ++level;
    };
    level -= 1;
    if (this._hash(level) === 0){
        return S.bPlus(p, q, level, interval, this._s, this._c);
    } else {
        return S.bMinus(p, q, level, interval, this._s, this._c);
    };
};

/*!
 * \brief insert an element created from a remote site into the array
 * \param e the element to insert
 * \param i the identifier of the element
 * \param noIndex whether or not it should return the index of the insert
 * \return the index of the newly inserted element in the array
 */
LSEQTree.prototype.applyInsert = function(e, i, noIndex){
    var node, result;
    // #0 cast from the proper type
    // #0A the identifier is an ID
    if (i && i._d && i._s && i._c){
        node = (new ID(i._d, i._s, i._c).toNode(e));
    };
    // #0B the identifier is a LSEQNode
    if (i && i.t && i.children){
        node = (new LSEQNode([],null)).fromJSON(i);
    };
    // #2 integrates the new element to the data structure
    result = this.root.add(node);
    if (result !== -1){
        // #3 if the element as been added
        this.length += 1;
    };
    return result || (!noIndex && this.root.indexOf(node));
};

/*!
 * \brief delete the element with the targeted identifier
 * \param i the identifier of the element
 * \return the index of the element feshly deleted, -1 if no removal
 */
LSEQTree.prototype.applyRemove = function(i){
    var node, position;
    // #0 cast from the proper type
    if (i && i._d && i._s && i._c){
        node = (new ID(i._d, i._s, i._c)).toNode(null);
    };
    // #0B the identifier is a LSEQNode
    if (i && i.t && i.children){
        node = (new LSEQNode([],null)).fromJSON(i);
    };
    // #1 get the index of the element to remove
    position = this.root.indexOf(node);
    if (position !== -1){
        // #2 if it exists remove it
        this.root.del(node);
        this.length -= 1;
    };
    return position;
};


/*!
 * \brief cast the JSON object into a proper LSEQTree.
 * \param object the JSON object to cast
 * \return a self reference
 */
LSEQTree.prototype.fromJSON = function(object){
    // #1 copy the source, counter, and length of the object
    this._s = object._s;
    this._c = object._c;
    this.length = object.length;
    // #2 depth first adding
    var self = this;
    function depthFirst(currentNode, currentPath){
        var triple = new Triple(currentNode.t.p,
                                currentNode.t.s,
                                currentNode.t.c);
        currentPath.push(triple); // stack
        if (currentNode.e!==null){
            var copy = currentPath.slice();
            self.root.add(new LSEQNode(copy, currentNode.e));
        };
        for (var i = 0; i<currentNode.children.length; ++i){
            depthFirst(currentNode.children[i], currentPath);
        };
        currentPath.pop(); // unstack
    };
    for (var i = 0; i<object.root.children.length; ++i){
        depthFirst(object.root.children[i], []);
    };
    return this;
};

module.exports = LSEQTree;

},{"./base.js":8,"./identifier.js":9,"./lseqnode.js":10,"./strategy.js":12,"./triple.js":13,"BigInt":15}],12:[function(require,module,exports){
var BI = require('BigInt');
var Base = require('./base.js')();
var ID = require('./identifier.js');

/*!
 * \class Strategy
 * \brief Enumerate the available sub-allocation strategies. The signature of
 * these functions is f(Id, Id, N+, N+, N, N): Id.
 * \param boundary the value used as the default maximum spacing between ids
 */
function Strategy(boundary){
    var DEFAULT_BOUNDARY = 10;
    this._boundary = boundary || DEFAULT_BOUNDARY;
};

/*!
 * \brief Choose an id starting from previous bound and adding random number
 * \param p the previous identifier
 * \param q the next identifier
 * \param level the number of concatenation composing the new identifier
 * \param interval the interval between p and q
 * \param s the source that creates the new identifier
 * \param c the counter of that source
 */
Strategy.prototype.bPlus = function (p, q, level, interval, s, c){
    var copyP = p, copyQ = q,
        step = Math.min(this._boundary, interval), //#0 the min interval
        digit = BI.int2bigInt(0,Base.getSumBit(level)),
        value;
    
    // #1 copy the previous identifier
    for (var i = 0; i<=level;++i){
	      value = 0;
        if (p!==null){ value = p.t.p; };
        BI.addInt_(digit,value);
        if (i!==level){ BI.leftShift_(digit,Base.getBitBase(i+1)); };
        if (p!==null && p.children.length!==0){
            p = p.children[0];
        } else {
            p = null;
        };
    };
    // #2 create a digit for an identifier by adding a random value
    // #2a Digit
    BI.addInt_(digit, Math.floor(Math.random()*step+1));
    // #2b Source & counter
    return getSC(digit, copyP, copyQ, level, s, c);
};


/*!
 * \brief Choose an id starting from next bound and substract a random number
 * \param p the previous identifier
 * \param q the next identifier
 * \param level the number of concatenation composing the new identifier
 * \param interval the interval between p and q
 * \param s the source that creates the new identifier
 * \param c the counter of that source
 */
Strategy.prototype.bMinus = function (p, q, level, interval, s, c){
    var copyP = p, copyQ = q,
        step = Math.min(this._boundary, interval), // #0 process min interval
        digit = BI.int2bigInt(0,Base.getSumBit(level)),
        pIsGreater = false, commonRoot = true,
        prevValue, nextValue;
    
    // #1 copy next, if previous is greater, copy maxValue @ depth
    for (var i = 0; i<=level;++i){
        prevValue = 0; if (p !== null){ prevValue = p.t.p; }
        nextValue = 0; if (q !== null){ nextValue = q.t.p; }
        if (commonRoot && prevValue !== nextValue){
            commonRoot = false;
            pIsGreater = prevValue > nextValue;
        }
        if (pIsGreater){ nextValue = Math.pow(2,Base.getBitBase(i))-1; }
        BI.addInt_(digit, nextValue);
        if (i!==level){ BI.leftShift_(digit,Base.getBitBase(i+1)); }
        if (q!==null && q.children.length!==0){
            q = q.children[0];
        } else {
            q = null;
        };
        if (p!==null && p.children.length!==0){
            p = p.children[0];
        } else {
            p = null;
        };
    };
    // #3 create a digit for an identifier by subing a random value
    // #3a Digit
    if (pIsGreater){
        BI.addInt_(digit, -Math.floor(Math.random()*step) );
    } else {
        BI.addInt_(digit, -Math.floor(Math.random()*step)-1 );
    };
    
    // #3b Source & counter
    return getSC(digit, copyP, copyQ, level, s, c);
};

/*!
 * \brief copies the appropriates source and counter from the adjacent 
 * identifiers at the insertion position.
 * \param d the digit part of the new identifier
 * \param p the previous identifier
 * \param q the next identifier
 * \param level the size of the new identifier
 * \param s the local site identifier 
 * \param c the local monotonic counter
 */
function getSC(d, p, q, level, s, c){
    var sources = [], counters = [],
        i = 0,
        sumBit = Base.getSumBit(level),
        tempDigit, value;
    
    while (i<=level){
        tempDigit = BI.dup(d);
        BI.rightShift_(tempDigit, sumBit - Base.getSumBit(i));
        value = BI.modInt(tempDigit,Math.pow(2,Base.getBitBase(i)));
        sources[i]=s;
        counters[i]=c
        if (q!==null && q.t.p===value){ sources[i]=q.t.s; counters[i]=q.t.c};
        if (p!==null && p.t.p===value){ sources[i]=p.t.s; counters[i]=p.t.c};
        if (q!==null && q.children.length!==0){
            q = q.children[0];
        } else {
            q = null;
        };
        if (p!==null && p.children.length!==0){
            p = p.children[0];
        } else {
            p = null;
        };
        ++i;
    };
    
    return new ID(d, sources, counters);
};

Strategy.instance = null;

module.exports = function(args){
    if (args){
        Strategy.instance = new Strategy(args);
    } else {
        if (Strategy.instance === null){
            Strategy.instance = new Strategy();
        };
    };
    return Strategy.instance;
};

},{"./base.js":8,"./identifier.js":9,"BigInt":15}],13:[function(require,module,exports){

/*!
 * \brief triple that contains a <path site counter>
 * \param path the part of the path in the tree
 * \param site the unique site identifier that created the triple
 * \param counter the counter of the site when it created the triple
 */
function Triple(path, site, counter){
    this.p = path;
    this.s = site;
    this.c = counter;
};

/*!
 * \brief compare two triples prioritizing the path, then site, then counter
 * \param o the other triple to compare
 * \return -1 if this is lower than o, 1 if this is greater than o, 0 otherwise
 */
Triple.prototype.compare = function(o){
    if (this.s === Number.MAX_VALUE && this.c === Number.MAX_VALUE){
        return 1;
    };
    if (o.s === Number.MAX_VALUE && o.s === Number.MAX_VALUE){
        return -1;
    };
    
    if (this.p < o.p) { return -1;};
    if (this.p > o.p) { return 1 ;};
    if (this.s < o.s) { return -1;};
    if (this.s > o.s) { return 1 ;};
    if (this.c < o.c) { return -1;};
    if (this.c > o.c) { return 1 ;};
    return 0;
};

module.exports = Triple;

},{}],14:[function(require,module,exports){

function binaryIndexOf(){

/**
 * \from: [https://gist.github.com/Wolfy87/5734530]
 * Performs a binary search on the host array. This method can either be
 * injected into Array.prototype or called with a specified scope like this:
 * binaryIndexOf.call(someArray, searchElement);
 *
 *
 * @param {*} searchElement The item to search for within the array.
 * @return {Number} The index of the element which defaults to -1 when not
 * found.
 */
Array.prototype.binaryIndexOf = function(searchElement) {
    var minIndex = 0;
    var maxIndex = this.length - 1;
    var currentIndex;
    var currentElement;

    while (minIndex <= maxIndex) {
        currentIndex = Math.floor((minIndex + maxIndex) / 2);
        currentElement = this[currentIndex];
        if (currentElement.compare(searchElement) < 0) {
            minIndex = currentIndex + 1;
        }
        else if (currentElement.compare(searchElement) > 0) {
            maxIndex = currentIndex - 1;
        }
        else {
            return currentIndex;
        }
    };
    return ~maxIndex;
};

}

module.exports = binaryIndexOf();
},{}],15:[function(require,module,exports){
// Vjeux: Customized bigInt2str and str2bigInt in order to accept custom base.

////////////////////////////////////////////////////////////////////////////////////////
// Big Integer Library v. 5.4
// Created 2000, last modified 2009
// Leemon Baird
// www.leemon.com
//
// Version history:
// v 5.4  3 Oct 2009
//   - added "var i" to greaterShift() so i is not global. (Thanks to P�ter Szab� for finding that bug)
//
// v 5.3  21 Sep 2009
//   - added randProbPrime(k) for probable primes
//   - unrolled loop in mont_ (slightly faster)
//   - millerRabin now takes a bigInt parameter rather than an int
//
// v 5.2  15 Sep 2009
//   - fixed capitalization in call to int2bigInt in randBigInt
//     (thanks to Emili Evripidou, Reinhold Behringer, and Samuel Macaleese for finding that bug)
//
// v 5.1  8 Oct 2007
//   - renamed inverseModInt_ to inverseModInt since it doesn't change its parameters
//   - added functions GCD and randBigInt, which call GCD_ and randBigInt_
//   - fixed a bug found by Rob Visser (see comment with his name below)
//   - improved comments
//
// This file is public domain.   You can use it for any purpose without restriction.
// I do not guarantee that it is correct, so use it at your own risk.  If you use
// it for something interesting, I'd appreciate hearing about it.  If you find
// any bugs or make any improvements, I'd appreciate hearing about those too.
// It would also be nice if my name and URL were left in the comments.  But none
// of that is required.
//
// This code defines a bigInt library for arbitrary-precision integers.
// A bigInt is an array of integers storing the value in chunks of bpe bits,
// little endian (buff[0] is the least significant word).
// Negative bigInts are stored two's complement.  Almost all the functions treat
// bigInts as nonnegative.  The few that view them as two's complement say so
// in their comments.  Some functions assume their parameters have at least one
// leading zero element. Functions with an underscore at the end of the name put
// their answer into one of the arrays passed in, and have unpredictable behavior
// in case of overflow, so the caller must make sure the arrays are big enough to
// hold the answer.  But the average user should never have to call any of the
// underscored functions.  Each important underscored function has a wrapper function
// of the same name without the underscore that takes care of the details for you.
// For each underscored function where a parameter is modified, that same variable
// must not be used as another argument too.  So, you cannot square x by doing
// multMod_(x,x,n).  You must use squareMod_(x,n) instead, or do y=dup(x); multMod_(x,y,n).
// Or simply use the multMod(x,x,n) function without the underscore, where
// such issues never arise, because non-underscored functions never change
// their parameters; they always allocate new memory for the answer that is returned.
//
// These functions are designed to avoid frequent dynamic memory allocation in the inner loop.
// For most functions, if it needs a BigInt as a local variable it will actually use
// a global, and will only allocate to it only when it's not the right size.  This ensures
// that when a function is called repeatedly with same-sized parameters, it only allocates
// memory on the first call.
//
// Note that for cryptographic purposes, the calls to Math.random() must
// be replaced with calls to a better pseudorandom number generator.
//
// In the following, "bigInt" means a bigInt with at least one leading zero element,
// and "integer" means a nonnegative integer less than radix.  In some cases, integer
// can be negative.  Negative bigInts are 2s complement.
//
// The following functions do not modify their inputs.
// Those returning a bigInt, string, or Array will dynamically allocate memory for that value.
// Those returning a boolean will return the integer 0 (false) or 1 (true).
// Those returning boolean or int will not allocate memory except possibly on the first
// time they're called with a given parameter size.
//
// bigInt  add(x,y)               //return (x+y) for bigInts x and y.
// bigInt  addInt(x,n)            //return (x+n) where x is a bigInt and n is an integer.
// string  bigInt2str(x,base)     //return a string form of bigInt x in a given base, with 2 <= base <= 95
// int     bitSize(x)             //return how many bits long the bigInt x is, not counting leading zeros
// bigInt  dup(x)                 //return a copy of bigInt x
// boolean equals(x,y)            //is the bigInt x equal to the bigint y?
// boolean equalsInt(x,y)         //is bigint x equal to integer y?
// bigInt  expand(x,n)            //return a copy of x with at least n elements, adding leading zeros if needed
// Array   findPrimes(n)          //return array of all primes less than integer n
// bigInt  GCD(x,y)               //return greatest common divisor of bigInts x and y (each with same number of elements).
// boolean greater(x,y)           //is x>y?  (x and y are nonnegative bigInts)
// boolean greaterShift(x,y,shift)//is (x <<(shift*bpe)) > y?
// bigInt  int2bigInt(t,n,m)      //return a bigInt equal to integer t, with at least n bits and m array elements
// bigInt  inverseMod(x,n)        //return (x**(-1) mod n) for bigInts x and n.  If no inverse exists, it returns null
// int     inverseModInt(x,n)     //return x**(-1) mod n, for integers x and n.  Return 0 if there is no inverse
// boolean isZero(x)              //is the bigInt x equal to zero?
// boolean millerRabin(x,b)       //does one round of Miller-Rabin base integer b say that bigInt x is possibly prime? (b is bigInt, 1<b<x)
// boolean millerRabinInt(x,b)    //does one round of Miller-Rabin base integer b say that bigInt x is possibly prime? (b is int,    1<b<x)
// bigInt  mod(x,n)               //return a new bigInt equal to (x mod n) for bigInts x and n.
// int     modInt(x,n)            //return x mod n for bigInt x and integer n.
// bigInt  mult(x,y)              //return x*y for bigInts x and y. This is faster when y<x.
// bigInt  multMod(x,y,n)         //return (x*y mod n) for bigInts x,y,n.  For greater speed, let y<x.
// boolean negative(x)            //is bigInt x negative?
// bigInt  powMod(x,y,n)          //return (x**y mod n) where x,y,n are bigInts and ** is exponentiation.  0**0=1. Faster for odd n.
// bigInt  randBigInt(n,s)        //return an n-bit random BigInt (n>=1).  If s=1, then the most significant of those n bits is set to 1.
// bigInt  randTruePrime(k)       //return a new, random, k-bit, true prime bigInt using Maurer's algorithm.
// bigInt  randProbPrime(k)       //return a new, random, k-bit, probable prime bigInt (probability it's composite less than 2^-80).
// bigInt  str2bigInt(s,b,n,m)    //return a bigInt for number represented in string s in base b with at least n bits and m array elements
// bigInt  sub(x,y)               //return (x-y) for bigInts x and y.  Negative answers will be 2s complement
// bigInt  trim(x,k)              //return a copy of x with exactly k leading zero elements
//
//
// The following functions each have a non-underscored version, which most users should call instead.
// These functions each write to a single parameter, and the caller is responsible for ensuring the array
// passed in is large enough to hold the result.
//
// void    addInt_(x,n)          //do x=x+n where x is a bigInt and n is an integer
// void    add_(x,y)             //do x=x+y for bigInts x and y
// void    copy_(x,y)            //do x=y on bigInts x and y
// void    copyInt_(x,n)         //do x=n on bigInt x and integer n
// void    GCD_(x,y)             //set x to the greatest common divisor of bigInts x and y, (y is destroyed).  (This never overflows its array).
// boolean inverseMod_(x,n)      //do x=x**(-1) mod n, for bigInts x and n. Returns 1 (0) if inverse does (doesn't) exist
// void    mod_(x,n)             //do x=x mod n for bigInts x and n. (This never overflows its array).
// void    mult_(x,y)            //do x=x*y for bigInts x and y.
// void    multMod_(x,y,n)       //do x=x*y  mod n for bigInts x,y,n.
// void    powMod_(x,y,n)        //do x=x**y mod n, where x,y,n are bigInts (n is odd) and ** is exponentiation.  0**0=1.
// void    randBigInt_(b,n,s)    //do b = an n-bit random BigInt. if s=1, then nth bit (most significant bit) is set to 1. n>=1.
// void    randTruePrime_(ans,k) //do ans = a random k-bit true random prime (not just probable prime) with 1 in the msb.
// void    sub_(x,y)             //do x=x-y for bigInts x and y. Negative answers will be 2s complement.
//
// The following functions do NOT have a non-underscored version.
// They each write a bigInt result to one or more parameters.  The caller is responsible for
// ensuring the arrays passed in are large enough to hold the results.
//
// void addShift_(x,y,ys)       //do x=x+(y<<(ys*bpe))
// void carry_(x)               //do carries and borrows so each element of the bigInt x fits in bpe bits.
// void divide_(x,y,q,r)        //divide x by y giving quotient q and remainder r
// int  divInt_(x,n)            //do x=floor(x/n) for bigInt x and integer n, and return the remainder. (This never overflows its array).
// int  eGCD_(x,y,d,a,b)        //sets a,b,d to positive bigInts such that d = GCD_(x,y) = a*x-b*y
// void halve_(x)               //do x=floor(|x|/2)*sgn(x) for bigInt x in 2's complement.  (This never overflows its array).
// void leftShift_(x,n)         //left shift bigInt x by n bits.  n<bpe.
// void linComb_(x,y,a,b)       //do x=a*x+b*y for bigInts x and y and integers a and b
// void linCombShift_(x,y,b,ys) //do x=x+b*(y<<(ys*bpe)) for bigInts x and y, and integers b and ys
// void mont_(x,y,n,np)         //Montgomery multiplication (see comments where the function is defined)
// void multInt_(x,n)           //do x=x*n where x is a bigInt and n is an integer.
// void rightShift_(x,n)        //right shift bigInt x by n bits.  0 <= n < bpe. (This never overflows its array).
// void squareMod_(x,n)         //do x=x*x  mod n for bigInts x,n
// void subShift_(x,y,ys)       //do x=x-(y<<(ys*bpe)). Negative answers will be 2s complement.
//
// The following functions are based on algorithms from the _Handbook of Applied Cryptography_
//    powMod_()           = algorithm 14.94, Montgomery exponentiation
//    eGCD_,inverseMod_() = algorithm 14.61, Binary extended GCD_
//    GCD_()              = algorothm 14.57, Lehmer's algorithm
//    mont_()             = algorithm 14.36, Montgomery multiplication
//    divide_()           = algorithm 14.20  Multiple-precision division
//    squareMod_()        = algorithm 14.16  Multiple-precision squaring
//    randTruePrime_()    = algorithm  4.62, Maurer's algorithm
//    millerRabin()       = algorithm  4.24, Miller-Rabin algorithm
//
// Profiling shows:
//     randTruePrime_() spends:
//         10% of its time in calls to powMod_()
//         85% of its time in calls to millerRabin()
//     millerRabin() spends:
//         99% of its time in calls to powMod_()   (always with a base of 2)
//     powMod_() spends:
//         94% of its time in calls to mont_()  (almost always with x==y)
//
// This suggests there are several ways to speed up this library slightly:
//     - convert powMod_ to use a Montgomery form of k-ary window (or maybe a Montgomery form of sliding window)
//         -- this should especially focus on being fast when raising 2 to a power mod n
//     - convert randTruePrime_() to use a minimum r of 1/3 instead of 1/2 with the appropriate change to the test
//     - tune the parameters in randTruePrime_(), including c, m, and recLimit
//     - speed up the single loop in mont_() that takes 95% of the runtime, perhaps by reducing checking
//       within the loop when all the parameters are the same length.
//
// There are several ideas that look like they wouldn't help much at all:
//     - replacing trial division in randTruePrime_() with a sieve (that speeds up something taking almost no time anyway)
//     - increase bpe from 15 to 30 (that would help if we had a 32*32->64 multiplier, but not with JavaScript's 32*32->32)
//     - speeding up mont_(x,y,n,np) when x==y by doing a non-modular, non-Montgomery square
//       followed by a Montgomery reduction.  The intermediate answer will be twice as long as x, so that
//       method would be slower.  This is unfortunate because the code currently spends almost all of its time
//       doing mont_(x,x,...), both for randTruePrime_() and powMod_().  A faster method for Montgomery squaring
//       would have a large impact on the speed of randTruePrime_() and powMod_().  HAC has a couple of poorly-worded
//       sentences that seem to imply it's faster to do a non-modular square followed by a single
//       Montgomery reduction, but that's obviously wrong.
////////////////////////////////////////////////////////////////////////////////////////

(function () {
//globals
bpe=0;         //bits stored per array element
mask=0;        //AND this with an array element to chop it down to bpe bits
radix=mask+1;  //equals 2^bpe.  A single 1 bit to the left of the last bit of mask.

//the digits for converting to different bases
digitsStr='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_=!@#$%^&*()[]{}|;:,.<>/?`~ \\\'\"+-';

//initialize the global variables
for (bpe=0; (1<<(bpe+1)) > (1<<bpe); bpe++);  //bpe=number of bits in the mantissa on this platform
bpe>>=1;                   //bpe=number of bits in one element of the array representing the bigInt
mask=(1<<bpe)-1;           //AND the mask with an integer to get its bpe least significant bits
radix=mask+1;              //2^bpe.  a single 1 bit to the left of the first bit of mask
one=int2bigInt(1,1,1);     //constant used in powMod_()

//the following global variables are scratchpad memory to
//reduce dynamic memory allocation in the inner loop
t=new Array(0);
ss=t;       //used in mult_()
s0=t;       //used in multMod_(), squareMod_()
s1=t;       //used in powMod_(), multMod_(), squareMod_()
s2=t;       //used in powMod_(), multMod_()
s3=t;       //used in powMod_()
s4=t; s5=t; //used in mod_()
s6=t;       //used in bigInt2str()
s7=t;       //used in powMod_()
T=t;        //used in GCD_()
sa=t;       //used in mont_()
mr_x1=t; mr_r=t; mr_a=t;                                      //used in millerRabin()
eg_v=t; eg_u=t; eg_A=t; eg_B=t; eg_C=t; eg_D=t;               //used in eGCD_(), inverseMod_()
md_q1=t; md_q2=t; md_q3=t; md_r=t; md_r1=t; md_r2=t; md_tt=t; //used in mod_()

primes=t; pows=t; s_i=t; s_i2=t; s_R=t; s_rm=t; s_q=t; s_n1=t;
  s_a=t; s_r2=t; s_n=t; s_b=t; s_d=t; s_x1=t; s_x2=t, s_aa=t; //used in randTruePrime_()

rpprb=t; //used in randProbPrimeRounds() (which also uses "primes")

////////////////////////////////////////////////////////////////////////////////////////


//return array of all primes less than integer n
function findPrimes(n) {
  var i,s,p,ans;
  s=new Array(n);
  for (i=0;i<n;i++)
    s[i]=0;
  s[0]=2;
  p=0;    //first p elements of s are primes, the rest are a sieve
  for(;s[p]<n;) {                  //s[p] is the pth prime
    for(i=s[p]*s[p]; i<n; i+=s[p]) //mark multiples of s[p]
      s[i]=1;
    p++;
    s[p]=s[p-1]+1;
    for(; s[p]<n && s[s[p]]; s[p]++); //find next prime (where s[p]==0)
  }
  ans=new Array(p);
  for(i=0;i<p;i++)
    ans[i]=s[i];
  return ans;
}


//does a single round of Miller-Rabin base b consider x to be a possible prime?
//x is a bigInt, and b is an integer, with b<x
function millerRabinInt(x,b) {
  if (mr_x1.length!=x.length) {
    mr_x1=dup(x);
    mr_r=dup(x);
    mr_a=dup(x);
  }

  copyInt_(mr_a,b);
  return millerRabin(x,mr_a);
}

//does a single round of Miller-Rabin base b consider x to be a possible prime?
//x and b are bigInts with b<x
function millerRabin(x,b) {
  var i,j,k,s;

  if (mr_x1.length!=x.length) {
    mr_x1=dup(x);
    mr_r=dup(x);
    mr_a=dup(x);
  }

  copy_(mr_a,b);
  copy_(mr_r,x);
  copy_(mr_x1,x);

  addInt_(mr_r,-1);
  addInt_(mr_x1,-1);

  //s=the highest power of two that divides mr_r
  k=0;
  for (i=0;i<mr_r.length;i++)
    for (j=1;j<mask;j<<=1)
      if (x[i] & j) {
        s=(k<mr_r.length+bpe ? k : 0);
         i=mr_r.length;
         j=mask;
      } else
        k++;

  if (s)
    rightShift_(mr_r,s);

  powMod_(mr_a,mr_r,x);

  if (!equalsInt(mr_a,1) && !equals(mr_a,mr_x1)) {
    j=1;
    while (j<=s-1 && !equals(mr_a,mr_x1)) {
      squareMod_(mr_a,x);
      if (equalsInt(mr_a,1)) {
        return 0;
      }
      j++;
    }
    if (!equals(mr_a,mr_x1)) {
      return 0;
    }
  }
  return 1;
}

//returns how many bits long the bigInt is, not counting leading zeros.
function bitSize(x) {
  var j,z,w;
  for (j=x.length-1; (x[j]==0) && (j>0); j--);
  for (z=0,w=x[j]; w; (w>>=1),z++);
  z+=bpe*j;
  return z;
}

//return a copy of x with at least n elements, adding leading zeros if needed
function expand(x,n) {
  var ans=int2bigInt(0,(x.length>n ? x.length : n)*bpe,0);
  copy_(ans,x);
  return ans;
}

//return a k-bit true random prime using Maurer's algorithm.
function randTruePrime(k) {
  var ans=int2bigInt(0,k,0);
  randTruePrime_(ans,k);
  return trim(ans,1);
}

//return a k-bit random probable prime with probability of error < 2^-80
function randProbPrime(k) {
  if (k>=600) return randProbPrimeRounds(k,2); //numbers from HAC table 4.3
  if (k>=550) return randProbPrimeRounds(k,4);
  if (k>=500) return randProbPrimeRounds(k,5);
  if (k>=400) return randProbPrimeRounds(k,6);
  if (k>=350) return randProbPrimeRounds(k,7);
  if (k>=300) return randProbPrimeRounds(k,9);
  if (k>=250) return randProbPrimeRounds(k,12); //numbers from HAC table 4.4
  if (k>=200) return randProbPrimeRounds(k,15);
  if (k>=150) return randProbPrimeRounds(k,18);
  if (k>=100) return randProbPrimeRounds(k,27);
              return randProbPrimeRounds(k,40); //number from HAC remark 4.26 (only an estimate)
}

//return a k-bit probable random prime using n rounds of Miller Rabin (after trial division with small primes)
function randProbPrimeRounds(k,n) {
  var ans, i, divisible, B;
  B=30000;  //B is largest prime to use in trial division
  ans=int2bigInt(0,k,0);

  //optimization: try larger and smaller B to find the best limit.

  if (primes.length==0)
    primes=findPrimes(30000);  //check for divisibility by primes <=30000

  if (rpprb.length!=ans.length)
    rpprb=dup(ans);

  for (;;) { //keep trying random values for ans until one appears to be prime
    //optimization: pick a random number times L=2*3*5*...*p, plus a
    //   random element of the list of all numbers in [0,L) not divisible by any prime up to p.
    //   This can reduce the amount of random number generation.

    randBigInt_(ans,k,0); //ans = a random odd number to check
    ans[0] |= 1;
    divisible=0;

    //check ans for divisibility by small primes up to B
    for (i=0; (i<primes.length) && (primes[i]<=B); i++)
      if (modInt(ans,primes[i])==0 && !equalsInt(ans,primes[i])) {
        divisible=1;
        break;
      }

    //optimization: change millerRabin so the base can be bigger than the number being checked, then eliminate the while here.

    //do n rounds of Miller Rabin, with random bases less than ans
    for (i=0; i<n && !divisible; i++) {
      randBigInt_(rpprb,k,0);
      while(!greater(ans,rpprb)) //pick a random rpprb that's < ans
        randBigInt_(rpprb,k,0);
      if (!millerRabin(ans,rpprb))
        divisible=1;
    }

    if(!divisible)
      return ans;
  }
}

//return a new bigInt equal to (x mod n) for bigInts x and n.
function mod(x,n) {
  var ans=dup(x);
  mod_(ans,n);
  return trim(ans,1);
}

//return (x+n) where x is a bigInt and n is an integer.
function addInt(x,n) {
  var ans=expand(x,x.length+1);
  addInt_(ans,n);
  return trim(ans,1);
}

//return x*y for bigInts x and y. This is faster when y<x.
function mult(x,y) {
  var ans=expand(x,x.length+y.length);
  mult_(ans,y);
  return trim(ans,1);
}

//return (x**y mod n) where x,y,n are bigInts and ** is exponentiation.  0**0=1. Faster for odd n.
function powMod(x,y,n) {
  var ans=expand(x,n.length);
  powMod_(ans,trim(y,2),trim(n,2),0);  //this should work without the trim, but doesn't
  return trim(ans,1);
}

//return (x-y) for bigInts x and y.  Negative answers will be 2s complement
function sub(x,y) {
  var ans=expand(x,(x.length>y.length ? x.length+1 : y.length+1));
  sub_(ans,y);
  return trim(ans,1);
}

//return (x+y) for bigInts x and y.
function add(x,y) {
  var ans=expand(x,(x.length>y.length ? x.length+1 : y.length+1));
  add_(ans,y);
  return trim(ans,1);
}

//return (x**(-1) mod n) for bigInts x and n.  If no inverse exists, it returns null
function inverseMod(x,n) {
  var ans=expand(x,n.length);
  var s;
  s=inverseMod_(ans,n);
  return s ? trim(ans,1) : null;
}

//return (x*y mod n) for bigInts x,y,n.  For greater speed, let y<x.
function multMod(x,y,n) {
  var ans=expand(x,n.length);
  multMod_(ans,y,n);
  return trim(ans,1);
}

//generate a k-bit true random prime using Maurer's algorithm,
//and put it into ans.  The bigInt ans must be large enough to hold it.
function randTruePrime_(ans,k) {
  var c,m,pm,dd,j,r,B,divisible,z,zz,recSize;

  if (primes.length==0)
    primes=findPrimes(30000);  //check for divisibility by primes <=30000

  if (pows.length==0) {
    pows=new Array(512);
    for (j=0;j<512;j++) {
      pows[j]=Math.pow(2,j/511.-1.);
    }
  }

  //c and m should be tuned for a particular machine and value of k, to maximize speed
  c=0.1;  //c=0.1 in HAC
  m=20;   //generate this k-bit number by first recursively generating a number that has between k/2 and k-m bits
  recLimit=20; //stop recursion when k <=recLimit.  Must have recLimit >= 2

  if (s_i2.length!=ans.length) {
    s_i2=dup(ans);
    s_R =dup(ans);
    s_n1=dup(ans);
    s_r2=dup(ans);
    s_d =dup(ans);
    s_x1=dup(ans);
    s_x2=dup(ans);
    s_b =dup(ans);
    s_n =dup(ans);
    s_i =dup(ans);
    s_rm=dup(ans);
    s_q =dup(ans);
    s_a =dup(ans);
    s_aa=dup(ans);
  }

  if (k <= recLimit) {  //generate small random primes by trial division up to its square root
    pm=(1<<((k+2)>>1))-1; //pm is binary number with all ones, just over sqrt(2^k)
    copyInt_(ans,0);
    for (dd=1;dd;) {
      dd=0;
      ans[0]= 1 | (1<<(k-1)) | Math.floor(Math.random()*(1<<k));  //random, k-bit, odd integer, with msb 1
      for (j=1;(j<primes.length) && ((primes[j]&pm)==primes[j]);j++) { //trial division by all primes 3...sqrt(2^k)
        if (0==(ans[0]%primes[j])) {
          dd=1;
          break;
        }
      }
    }
    carry_(ans);
    return;
  }

  B=c*k*k;    //try small primes up to B (or all the primes[] array if the largest is less than B).
  if (k>2*m)  //generate this k-bit number by first recursively generating a number that has between k/2 and k-m bits
    for (r=1; k-k*r<=m; )
      r=pows[Math.floor(Math.random()*512)];   //r=Math.pow(2,Math.random()-1);
  else
    r=.5;

  //simulation suggests the more complex algorithm using r=.333 is only slightly faster.

  recSize=Math.floor(r*k)+1;

  randTruePrime_(s_q,recSize);
  copyInt_(s_i2,0);
  s_i2[Math.floor((k-2)/bpe)] |= (1<<((k-2)%bpe));   //s_i2=2^(k-2)
  divide_(s_i2,s_q,s_i,s_rm);                        //s_i=floor((2^(k-1))/(2q))

  z=bitSize(s_i);

  for (;;) {
    for (;;) {  //generate z-bit numbers until one falls in the range [0,s_i-1]
      randBigInt_(s_R,z,0);
      if (greater(s_i,s_R))
        break;
    }                //now s_R is in the range [0,s_i-1]
    addInt_(s_R,1);  //now s_R is in the range [1,s_i]
    add_(s_R,s_i);   //now s_R is in the range [s_i+1,2*s_i]

    copy_(s_n,s_q);
    mult_(s_n,s_R);
    multInt_(s_n,2);
    addInt_(s_n,1);    //s_n=2*s_R*s_q+1

    copy_(s_r2,s_R);
    multInt_(s_r2,2);  //s_r2=2*s_R

    //check s_n for divisibility by small primes up to B
    for (divisible=0,j=0; (j<primes.length) && (primes[j]<B); j++)
      if (modInt(s_n,primes[j])==0 && !equalsInt(s_n,primes[j])) {
        divisible=1;
        break;
      }

    if (!divisible)    //if it passes small primes check, then try a single Miller-Rabin base 2
      if (!millerRabinInt(s_n,2)) //this line represents 75% of the total runtime for randTruePrime_
        divisible=1;

    if (!divisible) {  //if it passes that test, continue checking s_n
      addInt_(s_n,-3);
      for (j=s_n.length-1;(s_n[j]==0) && (j>0); j--);  //strip leading zeros
      for (zz=0,w=s_n[j]; w; (w>>=1),zz++);
      zz+=bpe*j;                             //zz=number of bits in s_n, ignoring leading zeros
      for (;;) {  //generate z-bit numbers until one falls in the range [0,s_n-1]
        randBigInt_(s_a,zz,0);
        if (greater(s_n,s_a))
          break;
      }                //now s_a is in the range [0,s_n-1]
      addInt_(s_n,3);  //now s_a is in the range [0,s_n-4]
      addInt_(s_a,2);  //now s_a is in the range [2,s_n-2]
      copy_(s_b,s_a);
      copy_(s_n1,s_n);
      addInt_(s_n1,-1);
      powMod_(s_b,s_n1,s_n);   //s_b=s_a^(s_n-1) modulo s_n
      addInt_(s_b,-1);
      if (isZero(s_b)) {
        copy_(s_b,s_a);
        powMod_(s_b,s_r2,s_n);
        addInt_(s_b,-1);
        copy_(s_aa,s_n);
        copy_(s_d,s_b);
        GCD_(s_d,s_n);  //if s_b and s_n are relatively prime, then s_n is a prime
        if (equalsInt(s_d,1)) {
          copy_(ans,s_aa);
          return;     //if we've made it this far, then s_n is absolutely guaranteed to be prime
        }
      }
    }
  }
}

//Return an n-bit random BigInt (n>=1).  If s=1, then the most significant of those n bits is set to 1.
function randBigInt(n,s) {
  var a,b;
  a=Math.floor((n-1)/bpe)+2; //# array elements to hold the BigInt with a leading 0 element
  b=int2bigInt(0,0,a);
  randBigInt_(b,n,s);
  return b;
}

//Set b to an n-bit random BigInt.  If s=1, then the most significant of those n bits is set to 1.
//Array b must be big enough to hold the result. Must have n>=1
function randBigInt_(b,n,s) {
  var i,a;
  for (i=0;i<b.length;i++)
    b[i]=0;
  a=Math.floor((n-1)/bpe)+1; //# array elements to hold the BigInt
  for (i=0;i<a;i++) {
    b[i]=Math.floor(Math.random()*(1<<(bpe-1)));
  }
  b[a-1] &= (2<<((n-1)%bpe))-1;
  if (s==1)
    b[a-1] |= (1<<((n-1)%bpe));
}

//Return the greatest common divisor of bigInts x and y (each with same number of elements).
function GCD(x,y) {
  var xc,yc;
  xc=dup(x);
  yc=dup(y);
  GCD_(xc,yc);
  return xc;
}

//set x to the greatest common divisor of bigInts x and y (each with same number of elements).
//y is destroyed.
function GCD_(x,y) {
  var i,xp,yp,A,B,C,D,q,sing;
  if (T.length!=x.length)
    T=dup(x);

  sing=1;
  while (sing) { //while y has nonzero elements other than y[0]
    sing=0;
    for (i=1;i<y.length;i++) //check if y has nonzero elements other than 0
      if (y[i]) {
        sing=1;
        break;
      }
    if (!sing) break; //quit when y all zero elements except possibly y[0]

    for (i=x.length;!x[i] && i>=0;i--);  //find most significant element of x
    xp=x[i];
    yp=y[i];
    A=1; B=0; C=0; D=1;
    while ((yp+C) && (yp+D)) {
      q =Math.floor((xp+A)/(yp+C));
      qp=Math.floor((xp+B)/(yp+D));
      if (q!=qp)
        break;
      t= A-q*C;   A=C;   C=t;    //  do (A,B,xp, C,D,yp) = (C,D,yp, A,B,xp) - q*(0,0,0, C,D,yp)
      t= B-q*D;   B=D;   D=t;
      t=xp-q*yp; xp=yp; yp=t;
    }
    if (B) {
      copy_(T,x);
      linComb_(x,y,A,B); //x=A*x+B*y
      linComb_(y,T,D,C); //y=D*y+C*T
    } else {
      mod_(x,y);
      copy_(T,x);
      copy_(x,y);
      copy_(y,T);
    }
  }
  if (y[0]==0)
    return;
  t=modInt(x,y[0]);
  copyInt_(x,y[0]);
  y[0]=t;
  while (y[0]) {
    x[0]%=y[0];
    t=x[0]; x[0]=y[0]; y[0]=t;
  }
}

//do x=x**(-1) mod n, for bigInts x and n.
//If no inverse exists, it sets x to zero and returns 0, else it returns 1.
//The x array must be at least as large as the n array.
function inverseMod_(x,n) {
  var k=1+2*Math.max(x.length,n.length);

  if(!(x[0]&1)  && !(n[0]&1)) {  //if both inputs are even, then inverse doesn't exist
    copyInt_(x,0);
    return 0;
  }

  if (eg_u.length!=k) {
    eg_u=new Array(k);
    eg_v=new Array(k);
    eg_A=new Array(k);
    eg_B=new Array(k);
    eg_C=new Array(k);
    eg_D=new Array(k);
  }

  copy_(eg_u,x);
  copy_(eg_v,n);
  copyInt_(eg_A,1);
  copyInt_(eg_B,0);
  copyInt_(eg_C,0);
  copyInt_(eg_D,1);
  for (;;) {
    while(!(eg_u[0]&1)) {  //while eg_u is even
      halve_(eg_u);
      if (!(eg_A[0]&1) && !(eg_B[0]&1)) { //if eg_A==eg_B==0 mod 2
        halve_(eg_A);
        halve_(eg_B);
      } else {
        add_(eg_A,n);  halve_(eg_A);
        sub_(eg_B,x);  halve_(eg_B);
      }
    }

    while (!(eg_v[0]&1)) {  //while eg_v is even
      halve_(eg_v);
      if (!(eg_C[0]&1) && !(eg_D[0]&1)) { //if eg_C==eg_D==0 mod 2
        halve_(eg_C);
        halve_(eg_D);
      } else {
        add_(eg_C,n);  halve_(eg_C);
        sub_(eg_D,x);  halve_(eg_D);
      }
    }

    if (!greater(eg_v,eg_u)) { //eg_v <= eg_u
      sub_(eg_u,eg_v);
      sub_(eg_A,eg_C);
      sub_(eg_B,eg_D);
    } else {                   //eg_v > eg_u
      sub_(eg_v,eg_u);
      sub_(eg_C,eg_A);
      sub_(eg_D,eg_B);
    }

    if (equalsInt(eg_u,0)) {
      if (negative(eg_C)) //make sure answer is nonnegative
        add_(eg_C,n);
      copy_(x,eg_C);

      if (!equalsInt(eg_v,1)) { //if GCD_(x,n)!=1, then there is no inverse
        copyInt_(x,0);
        return 0;
      }
      return 1;
    }
  }
}

//return x**(-1) mod n, for integers x and n.  Return 0 if there is no inverse
function inverseModInt(x,n) {
  var a=1,b=0,t;
  for (;;) {
    if (x==1) return a;
    if (x==0) return 0;
    b-=a*Math.floor(n/x);
    n%=x;

    if (n==1) return b; //to avoid negatives, change this b to n-b, and each -= to +=
    if (n==0) return 0;
    a-=b*Math.floor(x/n);
    x%=n;
  }
}

//this deprecated function is for backward compatibility only.
function inverseModInt_(x,n) {
   return inverseModInt(x,n);
}


//Given positive bigInts x and y, change the bigints v, a, and b to positive bigInts such that:
//     v = GCD_(x,y) = a*x-b*y
//The bigInts v, a, b, must have exactly as many elements as the larger of x and y.
function eGCD_(x,y,v,a,b) {
  var g=0;
  var k=Math.max(x.length,y.length);
  if (eg_u.length!=k) {
    eg_u=new Array(k);
    eg_A=new Array(k);
    eg_B=new Array(k);
    eg_C=new Array(k);
    eg_D=new Array(k);
  }
  while(!(x[0]&1)  && !(y[0]&1)) {  //while x and y both even
    halve_(x);
    halve_(y);
    g++;
  }
  copy_(eg_u,x);
  copy_(v,y);
  copyInt_(eg_A,1);
  copyInt_(eg_B,0);
  copyInt_(eg_C,0);
  copyInt_(eg_D,1);
  for (;;) {
    while(!(eg_u[0]&1)) {  //while u is even
      halve_(eg_u);
      if (!(eg_A[0]&1) && !(eg_B[0]&1)) { //if A==B==0 mod 2
        halve_(eg_A);
        halve_(eg_B);
      } else {
        add_(eg_A,y);  halve_(eg_A);
        sub_(eg_B,x);  halve_(eg_B);
      }
    }

    while (!(v[0]&1)) {  //while v is even
      halve_(v);
      if (!(eg_C[0]&1) && !(eg_D[0]&1)) { //if C==D==0 mod 2
        halve_(eg_C);
        halve_(eg_D);
      } else {
        add_(eg_C,y);  halve_(eg_C);
        sub_(eg_D,x);  halve_(eg_D);
      }
    }

    if (!greater(v,eg_u)) { //v<=u
      sub_(eg_u,v);
      sub_(eg_A,eg_C);
      sub_(eg_B,eg_D);
    } else {                //v>u
      sub_(v,eg_u);
      sub_(eg_C,eg_A);
      sub_(eg_D,eg_B);
    }
    if (equalsInt(eg_u,0)) {
      if (negative(eg_C)) {   //make sure a (C)is nonnegative
        add_(eg_C,y);
        sub_(eg_D,x);
      }
      multInt_(eg_D,-1);  ///make sure b (D) is nonnegative
      copy_(a,eg_C);
      copy_(b,eg_D);
      leftShift_(v,g);
      return;
    }
  }
}


//is bigInt x negative?
function negative(x) {
  return ((x[x.length-1]>>(bpe-1))&1);
}


//is (x << (shift*bpe)) > y?
//x and y are nonnegative bigInts
//shift is a nonnegative integer
function greaterShift(x,y,shift) {
  var i, kx=x.length, ky=y.length;
  k=((kx+shift)<ky) ? (kx+shift) : ky;
  for (i=ky-1-shift; i<kx && i>=0; i++)
    if (x[i]>0)
      return 1; //if there are nonzeros in x to the left of the first column of y, then x is bigger
  for (i=kx-1+shift; i<ky; i++)
    if (y[i]>0)
      return 0; //if there are nonzeros in y to the left of the first column of x, then x is not bigger
  for (i=k-1; i>=shift; i--)
    if      (x[i-shift]>y[i]) return 1;
    else if (x[i-shift]<y[i]) return 0;
  return 0;
}

//is x > y? (x and y both nonnegative)
function greater(x,y) {
  var i;
  var k=(x.length<y.length) ? x.length : y.length;

  for (i=x.length;i<y.length;i++)
    if (y[i])
      return 0;  //y has more digits

  for (i=y.length;i<x.length;i++)
    if (x[i])
      return 1;  //x has more digits

  for (i=k-1;i>=0;i--)
    if (x[i]>y[i])
      return 1;
    else if (x[i]<y[i])
      return 0;
  return 0;
}

//divide x by y giving quotient q and remainder r.  (q=floor(x/y),  r=x mod y).  All 4 are bigints.
//x must have at least one leading zero element.
//y must be nonzero.
//q and r must be arrays that are exactly the same length as x. (Or q can have more).
//Must have x.length >= y.length >= 2.
function divide_(x,y,q,r) {
  var kx, ky;
  var i,j,y1,y2,c,a,b;
  copy_(r,x);
  for (ky=y.length;y[ky-1]==0;ky--); //ky is number of elements in y, not including leading zeros

  //normalize: ensure the most significant element of y has its highest bit set
  b=y[ky-1];
  for (a=0; b; a++)
    b>>=1;
  a=bpe-a;  //a is how many bits to shift so that the high order bit of y is leftmost in its array element
  leftShift_(y,a);  //multiply both by 1<<a now, then divide both by that at the end
  leftShift_(r,a);

  //Rob Visser discovered a bug: the following line was originally just before the normalization.
  for (kx=r.length;r[kx-1]==0 && kx>ky;kx--); //kx is number of elements in normalized x, not including leading zeros

  copyInt_(q,0);                      // q=0
  while (!greaterShift(y,r,kx-ky)) {  // while (leftShift_(y,kx-ky) <= r) {
    subShift_(r,y,kx-ky);             //   r=r-leftShift_(y,kx-ky)
    q[kx-ky]++;                       //   q[kx-ky]++;
  }                                   // }

  for (i=kx-1; i>=ky; i--) {
    if (r[i]==y[ky-1])
      q[i-ky]=mask;
    else
      q[i-ky]=Math.floor((r[i]*radix+r[i-1])/y[ky-1]);

    //The following for(;;) loop is equivalent to the commented while loop,
    //except that the uncommented version avoids overflow.
    //The commented loop comes from HAC, which assumes r[-1]==y[-1]==0
    //  while (q[i-ky]*(y[ky-1]*radix+y[ky-2]) > r[i]*radix*radix+r[i-1]*radix+r[i-2])
    //    q[i-ky]--;
    for (;;) {
      y2=(ky>1 ? y[ky-2] : 0)*q[i-ky];
      c=y2>>bpe;
      y2=y2 & mask;
      y1=c+q[i-ky]*y[ky-1];
      c=y1>>bpe;
      y1=y1 & mask;

      if (c==r[i] ? y1==r[i-1] ? y2>(i>1 ? r[i-2] : 0) : y1>r[i-1] : c>r[i])
        q[i-ky]--;
      else
        break;
    }

    linCombShift_(r,y,-q[i-ky],i-ky);    //r=r-q[i-ky]*leftShift_(y,i-ky)
    if (negative(r)) {
      addShift_(r,y,i-ky);         //r=r+leftShift_(y,i-ky)
      q[i-ky]--;
    }
  }

  rightShift_(y,a);  //undo the normalization step
  rightShift_(r,a);  //undo the normalization step
}

//do carries and borrows so each element of the bigInt x fits in bpe bits.
function carry_(x) {
  var i,k,c,b;
  k=x.length;
  c=0;
  for (i=0;i<k;i++) {
    c+=x[i];
    b=0;
    if (c<0) {
      b=-(c>>bpe);
      c+=b*radix;
    }
    x[i]=c & mask;
    c=(c>>bpe)-b;
  }
}

//return x mod n for bigInt x and integer n.
function modInt(x,n) {
  var i,c=0;
  for (i=x.length-1; i>=0; i--)
    c=(c*radix+x[i])%n;
  return c;
}

//convert the integer t into a bigInt with at least the given number of bits.
//the returned array stores the bigInt in bpe-bit chunks, little endian (buff[0] is least significant word)
//Pad the array with leading zeros so that it has at least minSize elements.
//There will always be at least one leading 0 element.
function int2bigInt(t,bits,minSize) {
  var i,k;
  k=Math.ceil(bits/bpe)+1;
  k=minSize>k ? minSize : k;
  buff=new Array(k);
  copyInt_(buff,t);
  return buff;
}

//return the bigInt given a string representation in a given base.
//Pad the array with leading zeros so that it has at least minSize elements.
//If base=-1, then it reads in a space-separated list of array elements in decimal.
//The array will always have at least one leading zero, unless base=-1.
function str2bigInt(s,b,minSize) {
  var d, i, j, base, str, x, y, kk;
  if (typeof b === 'string') {
	  base = b.length;
	  str = b;
  } else {
	  base = b;
	  str = digitsStr;
  }
  var k=s.length;
  if (base==-1) { //comma-separated list of array elements in decimal
    x=new Array(0);
    for (;;) {
      y=new Array(x.length+1);
      for (i=0;i<x.length;i++)
        y[i+1]=x[i];
      y[0]=parseInt(s,10);
      x=y;
      d=s.indexOf(',',0);
      if (d<1)
        break;
      s=s.substring(d+1);
      if (s.length==0)
        break;
    }
    if (x.length<minSize) {
      y=new Array(minSize);
      copy_(y,x);
      return y;
    }
    return x;
  }

  x=int2bigInt(0,base*k,0);
  for (i=0;i<k;i++) {
    d=str.indexOf(s.substring(i,i+1),0);
//    if (base<=36 && d>=36)  //convert lowercase to uppercase if base<=36
//      d-=26;
    if (d>=base || d<0) {   //ignore illegal characters
      continue;
    }
    multInt_(x,base);
    addInt_(x,d);
  }

  for (k=x.length;k>0 && !x[k-1];k--); //strip off leading zeros
  k=minSize>k+1 ? minSize : k+1;
  y=new Array(k);
  kk=k<x.length ? k : x.length;
  for (i=0;i<kk;i++)
    y[i]=x[i];
  for (;i<k;i++)
    y[i]=0;
  return y;
}

//is bigint x equal to integer y?
//y must have less than bpe bits
function equalsInt(x,y) {
  var i;
  if (x[0]!=y)
    return 0;
  for (i=1;i<x.length;i++)
    if (x[i])
      return 0;
  return 1;
}

//are bigints x and y equal?
//this works even if x and y are different lengths and have arbitrarily many leading zeros
function equals(x,y) {
  var i;
  var k=x.length<y.length ? x.length : y.length;
  for (i=0;i<k;i++)
    if (x[i]!=y[i])
      return 0;
  if (x.length>y.length) {
    for (;i<x.length;i++)
      if (x[i])
        return 0;
  } else {
    for (;i<y.length;i++)
      if (y[i])
        return 0;
  }
  return 1;
}

//is the bigInt x equal to zero?
function isZero(x) {
  var i;
  for (i=0;i<x.length;i++)
    if (x[i])
      return 0;
  return 1;
}

//convert a bigInt into a string in a given base, from base 2 up to base 95.
//Base -1 prints the contents of the array representing the number.
function bigInt2str(x,b) {
  var i,t,base,str,s="";
  if (typeof b === 'string') {
	  base = b.length;
	  str = b;
  } else {
	  base = b;
	  str = digitsStr;
  }

  if (s6.length!=x.length)
    s6=dup(x);
  else
    copy_(s6,x);

  if (base==-1) { //return the list of array contents
    for (i=x.length-1;i>0;i--)
      s+=x[i]+',';
    s+=x[0];
  }
  else { //return it in the given base
    while (!isZero(s6)) {
      t=divInt_(s6,base);  //t=s6 % base; s6=floor(s6/base);
      s=str.substring(t,t+1)+s;
    }
  }
  if (s.length==0)
    s=str[0];
  return s;
}

//returns a duplicate of bigInt x
function dup(x) {
  var i;
  buff=new Array(x.length);
  copy_(buff,x);
  return buff;
}

//do x=y on bigInts x and y.  x must be an array at least as big as y (not counting the leading zeros in y).
function copy_(x,y) {
  var i;
  var k=x.length<y.length ? x.length : y.length;
  for (i=0;i<k;i++)
    x[i]=y[i];
  for (i=k;i<x.length;i++)
    x[i]=0;
}

//do x=y on bigInt x and integer y.
function copyInt_(x,n) {
  var i,c;
  for (c=n,i=0;i<x.length;i++) {
    x[i]=c & mask;
    c>>=bpe;
  }
}

//do x=x+n where x is a bigInt and n is an integer.
//x must be large enough to hold the result.
function addInt_(x,n) {
  var i,k,c,b;
  x[0]+=n;
  k=x.length;
  c=0;
  for (i=0;i<k;i++) {
    c+=x[i];
    b=0;
    if (c<0) {
      b=-(c>>bpe);
      c+=b*radix;
    }
    x[i]=c & mask;
    c=(c>>bpe)-b;
    if (!c) return; //stop carrying as soon as the carry is zero
  }
}

//right shift bigInt x by n bits.  0 <= n < bpe.
function rightShift_(x,n) {
  var i;
  var k=Math.floor(n/bpe);
  if (k) {
    for (i=0;i<x.length-k;i++) //right shift x by k elements
      x[i]=x[i+k];
    for (;i<x.length;i++)
      x[i]=0;
    n%=bpe;
  }
  for (i=0;i<x.length-1;i++) {
    x[i]=mask & ((x[i+1]<<(bpe-n)) | (x[i]>>n));
  }
  x[i]>>=n;
}

//do x=floor(|x|/2)*sgn(x) for bigInt x in 2's complement
function halve_(x) {
  var i;
  for (i=0;i<x.length-1;i++) {
    x[i]=mask & ((x[i+1]<<(bpe-1)) | (x[i]>>1));
  }
  x[i]=(x[i]>>1) | (x[i] & (radix>>1));  //most significant bit stays the same
}

//left shift bigInt x by n bits.
function leftShift_(x,n) {
  var i;
  var k=Math.floor(n/bpe);
  if (k) {
    for (i=x.length; i>=k; i--) //left shift x by k elements
      x[i]=x[i-k];
    for (;i>=0;i--)
      x[i]=0;
    n%=bpe;
  }
  if (!n)
    return;
  for (i=x.length-1;i>0;i--) {
    x[i]=mask & ((x[i]<<n) | (x[i-1]>>(bpe-n)));
  }
  x[i]=mask & (x[i]<<n);
}

//do x=x*n where x is a bigInt and n is an integer.
//x must be large enough to hold the result.
function multInt_(x,n) {
  var i,k,c,b;
  if (!n)
    return;
  k=x.length;
  c=0;
  for (i=0;i<k;i++) {
    c+=x[i]*n;
    b=0;
    if (c<0) {
      b=-(c>>bpe);
      c+=b*radix;
    }
    x[i]=c & mask;
    c=(c>>bpe)-b;
  }
}

//do x=floor(x/n) for bigInt x and integer n, and return the remainder
function divInt_(x,n) {
  var i,r=0,s;
  for (i=x.length-1;i>=0;i--) {
    s=r*radix+x[i];
    x[i]=Math.floor(s/n);
    r=s%n;
  }
  return r;
}

//do the linear combination x=a*x+b*y for bigInts x and y, and integers a and b.
//x must be large enough to hold the answer.
function linComb_(x,y,a,b) {
  var i,c,k,kk;
  k=x.length<y.length ? x.length : y.length;
  kk=x.length;
  for (c=0,i=0;i<k;i++) {
    c+=a*x[i]+b*y[i];
    x[i]=c & mask;
    c>>=bpe;
  }
  for (i=k;i<kk;i++) {
    c+=a*x[i];
    x[i]=c & mask;
    c>>=bpe;
  }
}

//do the linear combination x=a*x+b*(y<<(ys*bpe)) for bigInts x and y, and integers a, b and ys.
//x must be large enough to hold the answer.
function linCombShift_(x,y,b,ys) {
  var i,c,k,kk;
  k=x.length<ys+y.length ? x.length : ys+y.length;
  kk=x.length;
  for (c=0,i=ys;i<k;i++) {
    c+=x[i]+b*y[i-ys];
    x[i]=c & mask;
    c>>=bpe;
  }
  for (i=k;c && i<kk;i++) {
    c+=x[i];
    x[i]=c & mask;
    c>>=bpe;
  }
}

//do x=x+(y<<(ys*bpe)) for bigInts x and y, and integers a,b and ys.
//x must be large enough to hold the answer.
function addShift_(x,y,ys) {
  var i,c,k,kk;
  k=x.length<ys+y.length ? x.length : ys+y.length;
  kk=x.length;
  for (c=0,i=ys;i<k;i++) {
    c+=x[i]+y[i-ys];
    x[i]=c & mask;
    c>>=bpe;
  }
  for (i=k;c && i<kk;i++) {
    c+=x[i];
    x[i]=c & mask;
    c>>=bpe;
  }
}

//do x=x-(y<<(ys*bpe)) for bigInts x and y, and integers a,b and ys.
//x must be large enough to hold the answer.
function subShift_(x,y,ys) {
  var i,c,k,kk;
  k=x.length<ys+y.length ? x.length : ys+y.length;
  kk=x.length;
  for (c=0,i=ys;i<k;i++) {
    c+=x[i]-y[i-ys];
    x[i]=c & mask;
    c>>=bpe;
  }
  for (i=k;c && i<kk;i++) {
    c+=x[i];
    x[i]=c & mask;
    c>>=bpe;
  }
}

//do x=x-y for bigInts x and y.
//x must be large enough to hold the answer.
//negative answers will be 2s complement
function sub_(x,y) {
  var i,c,k,kk;
  k=x.length<y.length ? x.length : y.length;
  for (c=0,i=0;i<k;i++) {
    c+=x[i]-y[i];
    x[i]=c & mask;
    c>>=bpe;
  }
  for (i=k;c && i<x.length;i++) {
    c+=x[i];
    x[i]=c & mask;
    c>>=bpe;
  }
}

//do x=x+y for bigInts x and y.
//x must be large enough to hold the answer.
function add_(x,y) {
  var i,c,k,kk;
  k=x.length<y.length ? x.length : y.length;
  for (c=0,i=0;i<k;i++) {
    c+=x[i]+y[i];
    x[i]=c & mask;
    c>>=bpe;
  }
  for (i=k;c && i<x.length;i++) {
    c+=x[i];
    x[i]=c & mask;
    c>>=bpe;
  }
}

//do x=x*y for bigInts x and y.  This is faster when y<x.
function mult_(x,y) {
  var i;
  if (ss.length!=2*x.length)
    ss=new Array(2*x.length);
  copyInt_(ss,0);
  for (i=0;i<y.length;i++)
    if (y[i])
      linCombShift_(ss,x,y[i],i);   //ss=1*ss+y[i]*(x<<(i*bpe))
  copy_(x,ss);
}

//do x=x mod n for bigInts x and n.
function mod_(x,n) {
  if (s4.length!=x.length)
    s4=dup(x);
  else
    copy_(s4,x);
  if (s5.length!=x.length)
    s5=dup(x);
  divide_(s4,n,s5,x);  //x = remainder of s4 / n
}

//do x=x*y mod n for bigInts x,y,n.
//for greater speed, let y<x.
function multMod_(x,y,n) {
  var i;
  if (s0.length!=2*x.length)
    s0=new Array(2*x.length);
  copyInt_(s0,0);
  for (i=0;i<y.length;i++)
    if (y[i])
      linCombShift_(s0,x,y[i],i);   //s0=1*s0+y[i]*(x<<(i*bpe))
  mod_(s0,n);
  copy_(x,s0);
}

//do x=x*x mod n for bigInts x,n.
function squareMod_(x,n) {
  var i,j,d,c,kx,kn,k;
  for (kx=x.length; kx>0 && !x[kx-1]; kx--);  //ignore leading zeros in x
  k=kx>n.length ? 2*kx : 2*n.length; //k=# elements in the product, which is twice the elements in the larger of x and n
  if (s0.length!=k)
    s0=new Array(k);
  copyInt_(s0,0);
  for (i=0;i<kx;i++) {
    c=s0[2*i]+x[i]*x[i];
    s0[2*i]=c & mask;
    c>>=bpe;
    for (j=i+1;j<kx;j++) {
      c=s0[i+j]+2*x[i]*x[j]+c;
      s0[i+j]=(c & mask);
      c>>=bpe;
    }
    s0[i+kx]=c;
  }
  mod_(s0,n);
  copy_(x,s0);
}

//return x with exactly k leading zero elements
function trim(x,k) {
  var i,y;
  for (i=x.length; i>0 && !x[i-1]; i--);
  y=new Array(i+k);
  copy_(y,x);
  return y;
}

//do x=x**y mod n, where x,y,n are bigInts and ** is exponentiation.  0**0=1.
//this is faster when n is odd.  x usually needs to have as many elements as n.
function powMod_(x,y,n) {
  var k1,k2,kn,np;
  if(s7.length!=n.length)
    s7=dup(n);

  //for even modulus, use a simple square-and-multiply algorithm,
  //rather than using the more complex Montgomery algorithm.
  if ((n[0]&1)==0) {
    copy_(s7,x);
    copyInt_(x,1);
    while(!equalsInt(y,0)) {
      if (y[0]&1)
        multMod_(x,s7,n);
      divInt_(y,2);
      squareMod_(s7,n);
    }
    return;
  }

  //calculate np from n for the Montgomery multiplications
  copyInt_(s7,0);
  for (kn=n.length;kn>0 && !n[kn-1];kn--);
  np=radix-inverseModInt(modInt(n,radix),radix);
  s7[kn]=1;
  multMod_(x ,s7,n);   // x = x * 2**(kn*bp) mod n

  if (s3.length!=x.length)
    s3=dup(x);
  else
    copy_(s3,x);

  for (k1=y.length-1;k1>0 & !y[k1]; k1--);  //k1=first nonzero element of y
  if (y[k1]==0) {  //anything to the 0th power is 1
    copyInt_(x,1);
    return;
  }
  for (k2=1<<(bpe-1);k2 && !(y[k1] & k2); k2>>=1);  //k2=position of first 1 bit in y[k1]
  for (;;) {
    if (!(k2>>=1)) {  //look at next bit of y
      k1--;
      if (k1<0) {
        mont_(x,one,n,np);
        return;
      }
      k2=1<<(bpe-1);
    }
    mont_(x,x,n,np);

    if (k2 & y[k1]) //if next bit is a 1
      mont_(x,s3,n,np);
  }
}


//do x=x*y*Ri mod n for bigInts x,y,n,
//  where Ri = 2**(-kn*bpe) mod n, and kn is the
//  number of elements in the n array, not
//  counting leading zeros.
//x array must have at least as many elemnts as the n array
//It's OK if x and y are the same variable.
//must have:
//  x,y < n
//  n is odd
//  np = -(n^(-1)) mod radix
function mont_(x,y,n,np) {
  var i,j,c,ui,t,ks;
  var kn=n.length;
  var ky=y.length;

  if (sa.length!=kn)
    sa=new Array(kn);

  copyInt_(sa,0);

  for (;kn>0 && n[kn-1]==0;kn--); //ignore leading zeros of n
  for (;ky>0 && y[ky-1]==0;ky--); //ignore leading zeros of y
  ks=sa.length-1; //sa will never have more than this many nonzero elements.

  //the following loop consumes 95% of the runtime for randTruePrime_() and powMod_() for large numbers
  for (i=0; i<kn; i++) {
    t=sa[0]+x[i]*y[0];
    ui=((t & mask) * np) & mask;  //the inner "& mask" was needed on Safari (but not MSIE) at one time
    c=(t+ui*n[0]) >> bpe;
    t=x[i];

    //do sa=(sa+x[i]*y+ui*n)/b   where b=2**bpe.  Loop is unrolled 5-fold for speed
    j=1;
    for (;j<ky-4;) { c+=sa[j]+ui*n[j]+t*y[j];   sa[j-1]=c & mask;   c>>=bpe;   j++;
                     c+=sa[j]+ui*n[j]+t*y[j];   sa[j-1]=c & mask;   c>>=bpe;   j++;
                     c+=sa[j]+ui*n[j]+t*y[j];   sa[j-1]=c & mask;   c>>=bpe;   j++;
                     c+=sa[j]+ui*n[j]+t*y[j];   sa[j-1]=c & mask;   c>>=bpe;   j++;
                     c+=sa[j]+ui*n[j]+t*y[j];   sa[j-1]=c & mask;   c>>=bpe;   j++; }
    for (;j<ky;)   { c+=sa[j]+ui*n[j]+t*y[j];   sa[j-1]=c & mask;   c>>=bpe;   j++; }
    for (;j<kn-4;) { c+=sa[j]+ui*n[j];          sa[j-1]=c & mask;   c>>=bpe;   j++;
                     c+=sa[j]+ui*n[j];          sa[j-1]=c & mask;   c>>=bpe;   j++;
                     c+=sa[j]+ui*n[j];          sa[j-1]=c & mask;   c>>=bpe;   j++;
                     c+=sa[j]+ui*n[j];          sa[j-1]=c & mask;   c>>=bpe;   j++;
                     c+=sa[j]+ui*n[j];          sa[j-1]=c & mask;   c>>=bpe;   j++; }
    for (;j<kn;)   { c+=sa[j]+ui*n[j];          sa[j-1]=c & mask;   c>>=bpe;   j++; }
    for (;j<ks;)   { c+=sa[j];                  sa[j-1]=c & mask;   c>>=bpe;   j++; }
    sa[j-1]=c & mask;
  }

  if (!greater(n,sa))
    sub_(sa,n);
  copy_(x,sa);
}

if (typeof module === 'undefined') {
	module = {};
}
BigInt = module.exports = {
	'add': add, 'addInt': addInt, 'bigInt2str': bigInt2str, 'bitSize': bitSize,
	'dup': dup, 'equals': equals, 'equalsInt': equalsInt, 'expand': expand,
	'findPrimes': findPrimes, 'GCD': GCD, 'greater': greater,
	'greaterShift': greaterShift, 'int2bigInt': int2bigInt,
	'inverseMod': inverseMod, 'inverseModInt': inverseModInt, 'isZero': isZero,
	'millerRabin': millerRabin, 'millerRabinInt': millerRabinInt, 'mod': mod,
	'modInt': modInt, 'mult': mult, 'multMod': multMod, 'negative': negative,
	'powMod': powMod, 'randBigInt': randBigInt, 'randTruePrime': randTruePrime,
	'randProbPrime': randProbPrime, 'str2bigInt': str2bigInt, 'sub': sub,
	'trim': trim, 'addInt_': addInt_, 'add_': add_, 'copy_': copy_,
	'copyInt_': copyInt_, 'GCD_': GCD_, 'inverseMod_': inverseMod_, 'mod_': mod_,
	'mult_': mult_, 'multMod_': multMod_, 'powMod_': powMod_,
	'randBigInt_': randBigInt_, 'randTruePrime_': randTruePrime_, 'sub_': sub_,
	'addShift_': addShift_, 'carry_': carry_, 'divide_': divide_,
	'divInt_': divInt_, 'eGCD_': eGCD_, 'halve_': halve_, 'leftShift_': leftShift_,
	'linComb_': linComb_, 'linCombShift_': linCombShift_, 'mont_': mont_,
	'multInt_': multInt_, 'rightShift_': rightShift_, 'squareMod_': squareMod_,
	'subShift_': subShift_, 'powMod_': powMod_, 'eGCD_': eGCD_,
	'inverseMod_': inverseMod_, 'GCD_': GCD_, 'mont_': mont_, 'divide_': divide_,
	'squareMod_': squareMod_, 'randTruePrime_': randTruePrime_,
	'millerRabin': millerRabin
};

})();

},{}],16:[function(require,module,exports){
arguments[4][1][0].apply(exports,arguments)
},{"dup":1}],17:[function(require,module,exports){
var SortedArray = require('sorted-cmp-array');

/*!
 * \brief array containing the list of sockets targeting this peer
 */
function InView(){
    this.sockets = new SortedArray(function(a,b){
        var first = a.id || a;
        var second = b.id || b;
        if (first < second) { return -1};
        if (first > second) { return  1};
        return 0;
    });
};

/*!
 * \brief add an element to the inview
 * \param socket the socket to add in the inview
 * \param id a unique identifier of the socket
 */
InView.prototype.add = function(socket, id){
    this.sockets.insert({id:id, socket:socket});
};

/*!
 * \brief remove the targeted socket from the inview
 * \param id the identifier of the inview
 * \return the socket removed from the inview, null if not found
 */
InView.prototype.remove = function(id){
    var index = this.sockets.indexOf(id),
        socket = null;
    if (index >= 0){
        socket = this.sockets.arr[index];
        this.sockets.arr.splice(index, 1);
    };
    return socket;
};

/*!
 * \brief get the length of the array
 */
InView.prototype.length = function(){
    return this.sockets.arr.length;
};

/*!
 * \brief clear the whole inview and close the sockets
 */
InView.prototype.clear = function(){
    for (var i = 0; i < this.sockets.arr.length; ++i){
        this.sockets.arr[i].socket.destroy();
    };
    this.sockets.arr.splice(0, this.sockets.arr.length);
};

module.exports = InView;

},{"sorted-cmp-array":32}],18:[function(require,module,exports){
/*!
 * MJoin(id)
 * MRequestTicket(id)
 * MOfferTicket(id, ticket, peer)
 * MStampedTicket(id, ticket, peer)
 * MExchange(id, peer)
 */

/*!
 * \brief message requesting to join the network
 * \param id the identifier of the join message
 */
function MJoin(id){
    this.protocol = 'spray';
    this.type = 'MJoin';
    this.id = id;
};
module.exports.MJoin = MJoin;

/*!
 * \brief message requesting an offer ticket
 * \param id the identifier of the request message
 */
function MRequestTicket(id){
    this.protocol = 'spray';
    this.type = 'MRequestTicket';
    this.id = id;
};
module.exports.MRequestTicket = MRequestTicket;

/*!
 * \brief an offer ticket containing the first part of the webrtc connection
 * establishment
 * \param id the unique identifier of the request message
 * \param ticket the first step of the connection establishement data
 * \param peer the peer that emit the offer ticket
 */
function MOfferTicket(id, ticket, peer){
    this.protocol = 'spray';
    this.type = 'MOfferTicket';
    this.id = id;
    this.ticket = ticket;
    this.peer = peer;
};
module.exports.MOfferTicket = MOfferTicket;

/*!
 * \brief an stamped ticket containing the second part of the webrtc connection
 * establishement
 * \param id the unique identifier of the request ticket
 * \param ticket the second step of the connection establishement data
 * \param peer the peer that emit the stamped ticket
 */
function MStampedTicket(id, ticket, peer){
    this.protocol = 'spray';
    this.type = 'MStampedTicket';
    this.id = id;
    this.ticket = ticket;
    this.peer = peer;
};
module.exports.MStampedTicket = MStampedTicket;

/*!
 * \brief message requesting an exchange of neighborhood
 * \param id the identifier of the request message
 * \param peer the identity of the initiator of the exchange
 */
function MExchange(id, peer){
    this.protocol = 'spray';
    this.type = 'MExchange';
    this.id = id;
    this.peer = peer;
};
module.exports.MExchange = MExchange;

},{}],19:[function(require,module,exports){
var SortedArray = require("sorted-cmp-array");

/*!
 * \brief comparator
 * \param a the first object including an 'age' property
 * \param b the second object including an 'age' property
 * \return 1 if a.age > b.age, -1 if a.age < b.age, 0 otherwise
 */
function comp(a, b){
    if (a.age < b.age){ return -1;};
    if (a.age > b.age){ return  1;};
    return 0;
};

/*!
 * \brief structure containing the neighborhood of a peer.
 */
function PartialView(){
    // #1 initialize the partial view as an array sorted by age
    this.array = new SortedArray(comp);
};

/*!
 * \return the oldest peer in the array
 */
PartialView.prototype.getOldest = function(){
    return this.array.arr[0];
};

/*!
 * \brief increment the age of the whole partial view
 */
PartialView.prototype.incrementAge = function(){
    for (var i=0; i<this.array.arr.length; ++i){
        this.array.arr[i].age += 1;
    };
};

/*!
 * \brief get a sample of the partial to send to the neighbor
 * \param neighbor the neighbor which performs the exchange with us
 * \param isInitiator whether or not the caller is the initiator of the
 * exchange
 * \return an array containing neighbors from this partial view
 */
PartialView.prototype.getSample = function(neighbor, isInitiator){
    var sample = [];
    // #1 copy the partial view
    var clone = new SortedArray(comp);
    for (var i = 0; i < this.array.arr.length; ++i){
        clone.arr.push(this.array.arr[i]);
    };

    // #2 process the size of the sample
    var sampleSize = Math.ceil(this.array.arr.length/2);
    
    if (isInitiator){
        // #A remove an occurrence of the chosen neighbor
        var index = clone.indexOf(neighbor);
        sample.push(clone.arr[index]); 
        clone.arr.splice(index, 1);
    };
    
    // #3 randomly add neighbors to the sample
    while (sample.length < sampleSize){
        var rn = Math.floor(Math.random()*clone.arr.length);
        sample.push(clone.arr[rn]);
        clone.arr.splice(rn, 1);
    };
    
    return sample;
};



/*!
 * \brief replace the occurrences of the old peer by the fresh one
 * \param sample the sample to modify
 * \param old the old reference to replace
 * \param fresh the new reference to insert
 * \return an array with the replaced occurences
 */
PartialView.prototype.replace = function(sample, old, fresh){
    var result = [];
    for (var i = 0; i < sample.length; ++i){
        if (sample[i].id === old.id){
            result.push(fresh);
        } else {
            result.push(sample[i]);
        };
    };
    return result;
};

/*!
 * \brief add the neigbhor to the partial view with an age of 0
 * \param peer the peer to add to the partial view
 */
PartialView.prototype.addNeighbor = function(peer){
    peer.age = 0;
    this.array.arr.push(peer);
};


/*!
 * \brief get the index of the peer in the partialview
 * \return the index of the peer in the array, -1 if not found
 */
PartialView.prototype.getIndex = function(peer){
    var i = 0,
        index = -1;
        found = false;
    while (!found && i < this.array.arr.length){
        if (peer.id === this.array.arr[i].id){
            found = true;
            index = i;
        };
        ++i;
    };
    return index;
};

/*!
 * \brief remove the peer from the partial view
 * \param peer the peer to remove
 * \return the removed entry if it exists, null otherwise
 */
PartialView.prototype.removePeer = function(peer){
    var index = this.getIndex(peer),
        removedEntry = null;
    if (index > -1){
        removedEntry = this.array.arr[index];
        this.array.arr.splice(index, 1);
    };
    return removedEntry;
};

/*!
 * \brief remove the peer with the associated age from the partial view
 * \param peer the peer to remove
 * \param age the age of the peer to remove
 * \return the removed entry if it exists, null otherwise
 */
PartialView.prototype.removePeerAge = function(peer, age){
    var found = false,
        i = 0,
        removedEntry = null;
    while(!found && i < this.array.arr.length){
        if (peer.id === this.array.arr[i].id && age === this.array.arr[i].age){
            found = true;
            removedEntry = this.array.arr[i];
            this.array.arr.splice(i, 1);
        };
        ++i;
    };
    return removedEntry;
};

/*!
 * \brief remove all occurrences of the peer and return the number of removals
 * \param peer the peer to remove
 * \return the number of occurrences of the removed peer
 */
PartialView.prototype.removeAll = function(peer){
    var occ = 0,
        i = 0;
    while (i < this.array.arr.length){
        if (this.array.arr[i].id === peer.id){
            this.array.arr.splice(i, 1);
            occ += 1;
        } else {
            ++i;
        };
    };
    return occ;
};

/*!
 * \brief remove all the elements contained in the sample in argument
 * \param sample the elements to remove
 */
PartialView.prototype.removeSample = function(sample){
    for (var i = 0; i < sample.length; ++i){
        this.removePeerAge(sample[i], sample[i].age);
    };
};

/*!
 * \brief get the size of the partial view
 * \return the size of the partial view
 */
PartialView.prototype.length = function(){
    return this.array.arr.length;
};

/*!
 * \brief check if the partial view contains the reference
 * \param peer the peer to check
 * \return true if the peer is in the partial view, false otherwise
 */
PartialView.prototype.contains = function(peer){
    return this.getIndex(peer)>=0;
};

/*!
 * \brief remove all elements from the partial view
 */
PartialView.prototype.clear = function(){
    this.array.arr.splice(0, this.array.arr.length);
};

module.exports = PartialView;

},{"sorted-cmp-array":32}],20:[function(require,module,exports){
var SortedArray = require("sorted-cmp-array");

/*!
 * \brief represent the array containing the sockets associated with
 * a unique identifier id
 */
function Sockets(){
    this.array = new SortedArray(
        function(a, b){
            if (a.id < b.id){ return -1; };
            if (a.id > b.id){ return  1; };
            return 0;
        }
    );
    this.lastChance = null; // last chance socket.
};

/*!
 * \brief add the socket with an object containing an identifier 
 * \param socket the socket to communicate with peer
 * \param object the object containing the identifier
 * \return true if the socket as been added, false otherwise
 */ 
Sockets.prototype.addSocket = function(socket, object){
    var contains = this.contains(object);
    if (!contains){
        this.array.insert({id:object.id, socket:socket});
    };
    return !contains;
};

/*!
 * \brief remove the object and its associated socket from the array
 * \param object the object containing the identifier to remove
 * \return the socket targeted by the removal, null if it does not exist
 */
Sockets.prototype.removeSocket = function(object){
    var socket = this.getSocket(object);
    if (socket !== null){
        this.array.remove(object);
        this.lastChance = socket;
    };
    return socket;
};

/*!
 * \brief get the socket attached to the object identity
 * \param object the object containing the identifier to search
 * \return the socket if the object exists, null otherwise
 */
Sockets.prototype.getSocket = function(object){
    var index = this.array.indexOf(object),
        socket = null;
    if (index !== -1){
        socket = this.array.arr[index].socket;
    };
    return socket;
};

/*!
 * \brief check if there is a socket associated to the object
 * \param object the object containing the identifier to check
 * \return true if a socket associated to the object exists, false otherwise
 */
Sockets.prototype.contains = function(object){
    return (this.array.indexOf(object) !== -1);
};

/*!
 * \brief get the length of the underlying array
 * \return the length of the array
 */
Sockets.prototype.length = function(){
    return this.array.arr.length;
};

/*!
 * \brief remove all the sockets from this register, and close them
 */
Sockets.prototype.clear = function(){
    for (var i=0; i<this.array.arr.length; ++i){
        this.array.arr[i].socket.destroy();        
    };
    this.array.arr.splice(0, this.array.arr.length);
};

module.exports = Sockets;

},{"sorted-cmp-array":32}],21:[function(require,module,exports){
var EventEmitter = require('events').EventEmitter;
var Socket = require('simple-peer');
var util = require('util');

var PartialView = require('./partialview.js');
var InView = require('./inview.js');
var Sockets = require('./sockets.js');
var GUID = require('./guid.js');

var Messages = require('./messages.js');
var MJoin = Messages.MJoin;
var MRequestTicket = Messages.MRequestTicket;
var MOfferTicket = Messages.MOfferTicket;
var MStampedTicket = Messages.MStampedTicket;
var MExchange = Messages.MExchange;

util.inherits(Spray, EventEmitter);

/*!
 * \brief Implementation of the random peer sampling called Spray on top of
 * socket.io
 * \param id the unique identifier of our peer
 * \param options the WebRTC options, for more informations: 
 * \url https://github.com/feross/simple-peer
 */
function Spray(id, options){
    EventEmitter.call(this);
    // #A constants
    this.DELTATIME = (options && options.deltatime) || 1000 * 60 * 2; // 2min
    this.TIMEOUT = (options && options.timeout) || 1000 * 60 * 1; // 1min
    this.ID = (id && ''+id+'') || GUID();
    this.OPTIONS = options || {};
    
    // #B protocol variables
    this.partialView = new PartialView();
    this.inView = new InView();
    
    this.sockets = new Sockets();
    this.pending = new Sockets();
    this.forwards = new Sockets();
    this.state = 'disconnect';
    
    // #C webrtc specifics
    var self = this;
    setInterval(function(){
        if (self.partialView.length()>0){
            self.exchange();
        };
    }, this.DELTATIME);

    // #D events
    this.on('spray-receive', function(socket, message){
        self.onSprayReceive(socket, message);
    });
};

/*!
 * \brief check if the network is ready and callback, nothing otherwise
 * \param callback the function to call if the network is ready
 */
Spray.prototype.ready = function(callback){
    if (this.partialView.length() > 0){ callback(); };
};

/*!
 * \brief get a set of neighbors. (TODO) include the sockets from the inView
 * \param k the number of neighbors requested
 * \return a list of sockets
 */
Spray.prototype.getPeers = function(k){
    var result = [];
    // #A copy the sockets of the partial view
    var cloneSockets = [];
    for (var i = 0; i < this.sockets.length(); ++i){
        cloneSockets[i] = this.sockets.array.arr[i];
    };
    // #B get as much neighbors as possible
    while (0 < cloneSockets.length && result.length < k){
        var rn = Math.floor(Math.random()*cloneSockets.length);
        result.push(cloneSockets[rn].socket);
        cloneSockets.splice(rn, 1);
    };
    // #C last chance socket
    if (k>0 && result.length===0 && this.sockets.lastChance!==null){
        result.push(this.sockets.lastChance);
    };
    return result;
};

/*!
 * \brief update the local connection state of the peer and emit an event
 * if the state is different than at the previous call of this function.
 * The emitted event is 'statechange' with the 
 * arguments 'connect' | 'partial' | 'disconnect'
 */
Spray.prototype.updateState = function(){
    if (this.partialView.length() > 0 && this.state !== 'connect'){
        this.state = 'connect';
        this.emit('statechange', 'connect');
    } else if ((this.partialView.length() === 0 && this.inView.length() > 0 ||
                this.partialView.length() > 0 && this.inView.length() === 0 ) &&
               this.state !== 'partial'){
        this.state = 'partial';
        this.emit('statechange', 'partial');
    } else if (this.partialView.length() === 0 && this.pending.length() === 0 &&
               this.state !== 'disconnect'){
        this.state = 'disconnect';
        this.emit('statechange', 'disconnect');
    };
};

/*!
 * \brief leave the network by closing the inview and partialview
 */
Spray.prototype.leave = function(){
    this.partialView.clear();
    this.inView.clear();
    
    this.sockets.clear();
    this.pending.clear();
    this.forwards.clear();
};

/*******************************************************************************
 * Bootstrap the first WebRTC connection
 ******************************************************************************/

/*!
 * \brief the very first part of a connection establishment to join the network.
 * This part corresponds to the first part of the 'onStampedTicketRequest' of
 * the spray protocol.
 * \param callback a callback function taking a 'message' in argument and
 * called when we receive the data from the stun server
 */
Spray.prototype.launch = function(callback){
    var options=this.OPTIONS; options.initiator=true; options.trickle=false;
    var socket = new Socket(options),
        id = GUID(),
        self = this;
    socket.on('signal', function(data){
        var message = new MOfferTicket(id, data, {id: self.ID});
        self.pending.addSocket(socket, message);
        callback(message);
    });
    setTimeout(function(){
        if (self.pending.contains({id:id})){
            self.pending.removeSocket({id:id});
            socket.destroy();
        };
    }, this.TIMEOUT);
};

/*!
 * \brief the second part of the connection establishment. This function is
 * called at the peer already inside the network. It corresponds to the function
 * 'onTicketRequest' of the Spray protocol
 * \param message the message generated by the launch function at the joining
 * peer
 * \param callback the function called when we receive the stamped ticket from
 * the stun server. It has a 'message' argument.
 */
Spray.prototype.answer = function(message, callback){
    var options=this.OPTIONS; options.initiator=false; options.trickle=false;
    var socket = new Socket(options),
        id = message.id,
        ticket = message.ticket,
        peer = message.peer,
        self = this;
    socket.on('signal', function(data){
        var stampedTicket = new MStampedTicket(id, data, {id:self.ID});
        self.pending.addSocket(socket, stampedTicket);
        callback(stampedTicket);
    });
    socket.on('connect', function(){
        console.log('wrtc: successful connection establishment');
        self.pending.removeSocket(message);
        self.inView.add(socket, id);
        self.updateState();
    });
    socket.on('data', function(receivedMessage){
        self.receive(socket, receivedMessage);
    });
    socket.on('stream', function(stream){
        self.emit('stream', socket, stream);
    });
    socket.on('close', function(){
        console.log('wrtc: a connection has been closed');
        self.inView.remove(id);
        self.updateState();
    });
    socket.signal(ticket);
    setTimeout(function(){
        if (self.pending.contains({id:id})){
            var socket = self.pending.removeSocket({id:id});
            socket.destroy();
        };
    }, this.TIMEOUT);
};

/*!
 * \brief the third part of the very first connection establishment to join the
 * network. It corresponds to the last part of the function of
 * 'onStampedTicketRequest' of the Spray protocol.
 * \param message the message containing the stamped ticket from the contact
 * peer
 */
Spray.prototype.handshake = function(message){
    var socket = this.pending.removeSocket(message),
        id = message.id,
        ticket = message.ticket,
        peer = message.peer,
        self = this;
    socket.on('connect', function(){
        console.log('wrtc: successful connection establishment');
        self.partialView.addNeighbor(peer);
        self.sockets.addSocket(socket, peer);
        self.join(peer);
        self.updateState();
    });
    socket.on('data', function(receivedMessage){
        self.receive(socket, receivedMessage);
    });
    socket.on('stream', function(stream){
        self.emit('stream', socket, stream);
    });
    socket.on('close', function(){
        console.log('wrtc: a connection has been closed');
        self.updateState();
    });
    socket.signal(ticket);
};


/*******************************************************************************
 * Spray's protocol implementation
 ******************************************************************************/

/*!
 * \brief join the network using the kwnon contact peer 
 * \param contact the known peer that will introduce us to the network
 */
Spray.prototype.join = function(contact){
    // #A ask to the contact peer to advertise your presence in the network
    var message = new MJoin(GUID());
    this.send(message, contact);
};

/*!
 * \brief event executer when "this" receives a join message
 * \param id the identifier of the request
 */
Spray.prototype.onJoin = function(id){
    // #A if it is the very first connection, establish a connection from
    // us to the newcomer
    if (this.partialView.length()===0){
        var mRequestTicket = new MRequestTicket(GUID());
        this.send(mRequestTicket, {id:id});
    } else {
        // #B if there is an already established network, we request that
        // the newcomer sends us an offer ticket for each of our neighbors
        for (var i = 0; i < this.partialView.length(); ++i){
            // #1 create the ticket with an original identifier
            var mRequestTicket = new MRequestTicket(GUID());
            // #2 register the forwarding route for the answers
            this.forwards.addSocket(
                this.sockets.getSocket(this.partialView.array.arr[i]),
                mRequestTicket);
            // #3 send the request to the new comer
            this.send(mRequestTicket, {id:id});
        };
    };
};

/*!
 * \brief periodically called function that aims to balance the partial view
 * and to mix the neighbors inside them
 */
Spray.prototype.exchange = function(){
    var self = this;
    var socketOldest = null;
    // #1 get the oldest neighbor reachable
    while ((socketOldest===null) ||
           (socketOldest!==null && !socketOldest.connected) &&
           this.partialView.length()>0){
        var oldest = this.partialView.getOldest();
        socketOldest = this.sockets.getSocket(oldest);
        if (socketOldest===null ||
            (socketOldest!==null && !socketOldest.connected)) {
            this.onPeerDown(oldest);
        };
    };
    if (this.partialView.length()===0){return;}; // ugly return
    // #2 notify the oldest neighbor that it is the chosen one
    var mExchange = new MExchange(GUID(), {id:this.ID});
    this.send(mExchange, oldest);
    // #3 get a sample from our partial view
    var sample = this.partialView.getSample(oldest, true);
    // #4 ask to the neighbors in the sample to create the offer tickets in
    // order to forward them to the oldest neighbor
    for (var i = 0; i < sample.length; ++i){
        if (sample[i].id !== oldest.id){
            // #5 if the neighbor is not the oldest neighbor
            // #5A register the forwarding destination
            var message = new MRequestTicket(GUID());
            this.forwards.addSocket(this.sockets.getSocket(oldest),message);
            // #5B send a ticket request to the neighbor in the sample
            this.send(message, sample[i]);
        } else {
            // #6 otherwise, create an offer ticket ourself and send it to the
            // oldest neigbhor
            var idTicket = GUID();
            this.forwards.addSocket(this.sockets.getSocket(oldest),
                                    {id:idTicket});
            this.onTicketRequest(idTicket);
        };
    };
    // #7 remove the sent sample from our partial view
    this.partialView.removeSample(sample);
    // #8 remove from the sockets dictionnary
    for (var i = 0; i < sample.length; ++i){
        // #8A check if the partial view still contains references to the socket
        if (!this.partialView.contains(sample[i])){
            // #8B otherwise remove the socket from the dictionnary
            var socket = this.sockets.removeSocket(sample[i]);
            // #8C close the socket after a while
            if (socket!==null){
                setTimeout(function(s){
                    s.destroy();
                }, this.TIMEOUT, socket);
            };
        };
    };    
};

/*!
 * \brief event executed when we receive an exchange request
 * \param id the identifier of the request message
 * \param initiator the peer that requested the exchange
 */
Spray.prototype.onExchange = function(id, initiator){
    // #1 get a sample of neighbors from our partial view
    var sample = this.partialView.getSample(initiator, false);
    // #2 ask to each neighbor in the sample to create an offer ticket to
    // give to the initiator peer
    for (var i = 0; i < sample.length; ++i){
        if (sample[i].id !== initiator.id){
            // #2A if the neigbhor is not the initiator, request an offer ticket
            // from it
            var message = new MRequestTicket(GUID());
            // #2B register the forwarding route
            this.forwards.addSocket(this.forwards.getSocket({id:id}), message);
            // #2C send the ticket request to the neigbhor
            this.send(message, sample[i]);
        } else {
            // #3A if the neigbhor is the initiator, create an offer ticket
            // ourself            
            var idTicket = GUID();
            // #3B register the forwarding route for our own offer ticket
            this.forwards.addSocket(this.forwards.getSocket({id:id}),
                                    {id:idTicket});
            // #3C create the offer ticket and send it
            this.onTicketRequest(idTicket);
        };
    };
    // #4 remove the sample from our partial view
    this.partialView.removeSample(sample);
    // #5 remove the sample from the sockets dictionnary
    for (var i = 0; i < sample.length; ++i){
        // #5A check if the partial view still contains references to the socket
        if (!this.partialView.contains(sample[i])){
            // #5B otherwise remove the socket from the dictionnary
            var socket = this.sockets.removeSocket(sample[i])
            // #5C close the socket after a while
            if (socket!==null){
                setTimeout(function(s){
                    s.destroy();
                }, this.TIMEOUT, socket);
            };
        };
    };
};

/*!
 * \brief the function called when a neighbor is unreachable and supposedly
 * crashed/departed. It probabilistically keeps an arc up
 * \param peer the peer that cannot be reached
 */
Spray.prototype.onPeerDown = function(peer){
    console.log('wrtc: a neighbor crashed/left');
    // #A remove all occurrences of the peer in the partial view
    var occ = this.partialView.removeAll(peer);
    this.sockets.removeSocket(peer);
    // #B probabilistically recreate an arc to a known peer
    if (this.partialView.length() > 0){
        for (var i = 0; i < occ; ++i){
            if (Math.random() > (1/(this.partialView.length()+occ))){
                var rn = Math.floor(Math.random()*this.partialView.length());
                this.partialView.addNeighbor(this.partialView.array.arr[rn]);
                console.log('wrtc: create a duplicate');
            };
        };
    };
    this.updateState();
};

/*!
 * \brief a connection failed to establish properly, systematically duplicates
 * an element of the partial view.
 */
Spray.prototype.onArcDown = function(){
    console.log('wrtc: an arc did not properly established');
    if (this.partialView.length()>0){
        var rn = Math.floor(Math.random()*this.partialView.length());
        this.partialView.addNeighbor(this.partialView.array.arr[rn]);
    };
    this.updateState();
};

/*!
 * \brief WebRTC specific event. A neighbor wants us to connect to another peer.
 * To do so, the former requests an offer ticket it can exchange with one of
 * its neighbor.
 * \param peer the identifier of the request message
 */
Spray.prototype.onTicketRequest = function(id){
    var options=this.OPTIONS; options.initiator=true; options.trickle=false;
    var socket = new Socket(options),
        self = this;
    // #1 get the offer ticket from the stun service    
    socket.on('signal', function(data){
        // #A register this socket in pending sockets dictionnary
        var message = new MOfferTicket(id, data, {id: self.ID});
        self.pending.addSocket(socket, message);
        // #B send the offer ticket to the requester along with our identifier
        self.send(message, message);
        // #C remove the forwarding route 
        self.forwards.removeSocket(message);
    });
    // #2 successful connection establishment
    socket.on('connect', function(){
        console.log('wrtc: successful connection establishment');
        // #A remove from the pending sockets dictionnary
        self.pending.removeSocket({id:id});
        self.inView.add(socket, id);
        self.updateState();
    });
    // #3 closed connection
    socket.on('close', function(){
        console.log('wrtc: a connection has been closed');
        self.inView.remove(id);
        self.updateState();
    });
    // #4 receive a message
    socket.on('data', function(message){
        self.receive(socket, message);
    });
    socket.on('stream', function(stream){
        self.emit('stream', socket, stream);
    });
    
    // #5 timeout on connection establishment
    setTimeout(function(){
        // #A check if it the connection established, otherwise, clean socket
        if (self.pending.contains({id:id})){
            self.pending.removeSocket({id:id});
            socket.destroy();
        };
    }, this.TIMEOUT);
};

/*!
 * \brief WebRTC specific event. A neighbor sent a ticket to stamp. We must
 * stamp it back to establish a connection.
 * \param id the identifier of the message carrying the offer ticket
 * \param ticket the offer ticket to stamp
 * \param peer the emitting peer containing its identifier
 */
Spray.prototype.onStampedTicketRequest = function(id, ticket, peer){
    var self = this;
    // #1 if the partial view already contains this neigbhor, duplicate the
    // entry and stop the processus
    if (this.partialView.contains(peer)){
        console.log("wrtc: create a duplicate");
        this.partialView.addNeighbor(peer);
        // #2 send an empty stamped ticket to close the pending and forwardings
        var message = new MStampedTicket(id, null, {id:self.ID});
        self.send(message, message);
        self.forwards.removeSocket({id:id});
        return; // do nothing else. Ugly return
    };
    // #2 otherwise creates an answer
    var options=this.OPTIONS; options.initiator=false; options.trickle=false;
    var socket = new Socket(options);
    // #3 get the stamped ticket from the stun service
    socket.on('signal', function(data){
        // #A create the message containing the stamped ticket
        var message = new MStampedTicket(id, data, {id:self.ID});
        // #B send it back from where it arrives
        self.send(message, message);
        // #C remove the forwarding route
        self.forwards.removeSocket(message);
    });
    // #4 successful connection establishment
    socket.on('connect', function(){
        console.log('wrtc: successful connection establishment');
        // #A remove from pending
        self.pending.removeSocket({id:id});        
        // #B add the neigbhor to our partial view
        self.partialView.addNeighbor(peer);
        // #C add the neigbhor to the socket dictionnary, if it does not exist
        if (!self.sockets.addSocket(socket, peer)){
            socket.destroy();
        };
        self.updateState();
    });
    // #5 closed connection
    socket.on('close', function(){
        console.log('wrtc: a connection has been closed');
        self.updateState();
    });
    // #6 receive a message
    socket.on('data', function(message){
        self.receive(socket, message);
    });
    socket.on('stream', function(stream){
        self.emit('stream', socket, stream);
    });
    // #7 signal the offer ticket to the fresh socket
    socket.signal(ticket);
    this.pending.addSocket(socket, {id:id});
    // #8 a timeout on connection establishment
    setTimeout(function(){
        if (self.pending.contains({id:id})){
            // #A if the connection is not successful, remove the socket and
            // create a duplicate
            self.pending.removeSocket({id:id});
            socket.destroy();
            self.onArcDown();
        };
    }, this.TIMEOUT);
};

/*!
 * \brief send a message to a particular peer. If no peer are passed in
 * arguments, it will try to forwards it the appropriate peer.
 * \param message the message to send
 * \param object the object containing the id to send the message
 * \param return true if the message as been sent, false otherwise
 */
Spray.prototype.send = function(message, object){
    var sent = false;
    var id = (object && object.id) || message.id;
    var socket = this.sockets.getSocket({id:id});
    if (socket !== null){
        if (socket.connected &&
            socket._channel && socket._channel.readyState === 'open'){
            socket.send(message);
            sent = true;
        } else {
            this.onPeerDown({id:id});            
        };
    } else {
        socket = this.forwards.getSocket({id:id});
        if (socket !== null && socket.connected &&
            socket._channel && socket._channel.readyState === 'open'){
            socket.send(message);
            sent = true;
        };
    };
    return sent;
};

/*!
 * \brief receive a membership message and process it accordingly
 * \param socket the socket from which we receive the message
 * \param message the received message
 */
Spray.prototype.receive = function(socket, message){
    if (message && message.protocol){
        this.emit(message.protocol+'-receive', socket, message);
    };
};

Spray.prototype.onSprayReceive = function(socket, message){
    switch (message.type){
    case 'MJoin':
        console.log('wrtc: a new member joins the network');
        var self = this;
        setTimeout(function(){
            self.forwards.addSocket(socket, message);
            self.onJoin(message.id);
            self.forwards.removeSocket(message);
        }, 1000); // make sure that the socket is undoubtedly opened
        break;
    case 'MRequestTicket':
        console.log('wrtc: a member request an offer ticket');
        this.forwards.addSocket(socket, message);
        this.onTicketRequest(message.id);
        break;
    case 'MOfferTicket':
        console.log('wrtc: you received an offer ticket');
        if (!this.forwards.contains(message)){
            // #1 if there is no forwarding route, the offer ticket is for us to
            // stamp
            this.forwards.addSocket(socket, message);
            this.onStampedTicketRequest(message.id,message.ticket,message.peer);
        } else {
            // #2A otherwise, we forward the offer ticket accordingly
            if (this.send(message, message)){
                // #2B invert the direction of forwarding route in order to
                // consistently redirect the stamped ticket
                this.forwards.removeSocket(message);
                this.forwards.addSocket(socket, message);
            } else {
                // #2C if the message has not been sent, simply remove the route
                this.forwards.removeSocket(message);
            };
        };
        break;
    case 'MStampedTicket':
        console.log('wrtc: you received a stamped ticket');
        if (!this.forwards.contains(message)){
            // #1 if there is no forwarding route, the message is for us to
            // finalize
            if (message.ticket === null){
                // #1A empty ticket meaning the remote peer already knows us,
                // therefore, simply close the pending offer
                var socket = this.pending.removeSocket(message);
                socket.destroy();
            } else {
                // #1B otherwise, finalize the connection
                this.pending.getSocket(message).signal(message.ticket);
            };
        } else {
            // #2A otherwise, we forward the stamped ticket accordingly
            this.send(message, message);
            // #2B remove the direction from the known forwarding routes
            this.forwards.removeSocket(message);
        };
        break;
    case 'MExchange':
        console.log('wrtc: a peer starts to exchange with you');
        this.forwards.addSocket(socket, message);
        this.onExchange(message.id, message.peer);
        this.forwards.removeSocket(message);
        break;
    };
};

module.exports = Spray;

},{"./guid.js":16,"./inview.js":17,"./messages.js":18,"./partialview.js":19,"./sockets.js":20,"events":43,"simple-peer":22,"util":64}],22:[function(require,module,exports){
(function (Buffer){
/* global Blob */

module.exports = Peer

var debug = require('debug')('simple-peer')
var hat = require('hat')
var inherits = require('inherits')
var isTypedArray = require('is-typedarray')
var once = require('once')
var stream = require('stream')
var toBuffer = require('typedarray-to-buffer')

inherits(Peer, stream.Duplex)

/**
 * WebRTC peer connection. Same API as node core `net.Socket`, plus a few extra methods.
 * Duplex stream.
 * @param {Object} opts
 */
function Peer (opts) {
  var self = this
  if (!(self instanceof Peer)) return new Peer(opts)
  self._debug('new peer %o', opts)

  if (!opts) opts = {}
  opts.allowHalfOpen = false
  if (opts.highWaterMark == null) opts.highWaterMark = 1024 * 1024

  stream.Duplex.call(self, opts)

  self.initiator = opts.initiator || false
  self.channelConfig = opts.channelConfig || Peer.channelConfig
  self.channelName = opts.channelName || hat(160)
  if (!opts.initiator) self.channelName = null
  self.config = opts.config || Peer.config
  self.constraints = opts.constraints || Peer.constraints
  self.reconnectTimer = opts.reconnectTimer || 0
  self.sdpTransform = opts.sdpTransform || function (sdp) { return sdp }
  self.stream = opts.stream || false
  self.trickle = opts.trickle !== undefined ? opts.trickle : true

  self.destroyed = false
  self.connected = false

  // so Peer object always has same shape (V8 optimization)
  self.remoteAddress = undefined
  self.remoteFamily = undefined
  self.remotePort = undefined
  self.localAddress = undefined
  self.localPort = undefined

  self._wrtc = opts.wrtc || getBrowserRTC()
  if (!self._wrtc) {
    if (typeof window === 'undefined') {
      throw new Error('No WebRTC support: Specify `opts.wrtc` option in this environment')
    } else {
      throw new Error('No WebRTC support: Not a supported browser')
    }
  }

  self._maxBufferedAmount = opts.highWaterMark
  self._pcReady = false
  self._channelReady = false
  self._iceComplete = false // ice candidate trickle done (got null candidate)
  self._channel = null

  self._chunk = null
  self._cb = null
  self._interval = null
  self._reconnectTimeout = null

  self._pc = new (self._wrtc.RTCPeerConnection)(self.config, self.constraints)
  self._pc.oniceconnectionstatechange = self._onIceConnectionStateChange.bind(self)
  self._pc.onsignalingstatechange = self._onSignalingStateChange.bind(self)
  self._pc.onicecandidate = self._onIceCandidate.bind(self)

  if (self.stream) self._pc.addStream(self.stream)
  self._pc.onaddstream = self._onAddStream.bind(self)

  if (self.initiator) {
    self._setupData({ channel: self._pc.createDataChannel(self.channelName, self.channelConfig) })
    self._pc.onnegotiationneeded = once(self._createOffer.bind(self))
    // Only Chrome triggers "negotiationneeded"; this is a workaround for other
    // implementations
    if (typeof window === 'undefined' || !window.webkitRTCPeerConnection) {
      self._pc.onnegotiationneeded()
    }
  } else {
    self._pc.ondatachannel = self._setupData.bind(self)
  }

  self.on('finish', function () {
    if (self.connected) {
      // When local peer is finished writing, close connection to remote peer.
      // Half open connections are currently not supported.
      // Wait a bit before destroying so the datachannel flushes.
      // TODO: is there a more reliable way to accomplish this?
      setTimeout(function () {
        self._destroy()
      }, 100)
    } else {
      // If data channel is not connected when local peer is finished writing, wait until
      // data is flushed to network at "connect" event.
      // TODO: is there a more reliable way to accomplish this?
      self.once('connect', function () {
        setTimeout(function () {
          self._destroy()
        }, 100)
      })
    }
  })
}

Peer.WEBRTC_SUPPORT = !!getBrowserRTC()

/**
 * Expose config, constraints, and data channel config for overriding all Peer
 * instances. Otherwise, just set opts.config, opts.constraints, or opts.channelConfig
 * when constructing a Peer.
 */
Peer.config = {
  iceServers: [
    {
      url: 'stun:23.21.150.121', // deprecated, replaced by `urls`
      urls: 'stun:23.21.150.121'
    }
  ]
}
Peer.constraints = {}
Peer.channelConfig = {}

Object.defineProperty(Peer.prototype, 'bufferSize', {
  get: function () {
    var self = this
    return (self._channel && self._channel.bufferedAmount) || 0
  }
})

Peer.prototype.address = function () {
  var self = this
  return { port: self.localPort, family: 'IPv4', address: self.localAddress }
}

Peer.prototype.signal = function (data) {
  var self = this
  if (self.destroyed) throw new Error('cannot signal after peer is destroyed')
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch (err) {
      data = {}
    }
  }
  self._debug('signal()')
  if (data.sdp) {
    self._pc.setRemoteDescription(new (self._wrtc.RTCSessionDescription)(data), function () {
      if (self.destroyed) return
      if (self._pc.remoteDescription.type === 'offer') self._createAnswer()
    }, self._onError.bind(self))
  }
  if (data.candidate) {
    try {
      self._pc.addIceCandidate(
        new (self._wrtc.RTCIceCandidate)(data.candidate), noop, self._onError.bind(self)
      )
    } catch (err) {
      self._destroy(new Error('error adding candidate: ' + err.message))
    }
  }
  if (!data.sdp && !data.candidate) {
    self._destroy(new Error('signal() called with invalid signal data'))
  }
}

/**
 * Send text/binary data to the remote peer.
 * @param {TypedArrayView|ArrayBuffer|Buffer|string|Blob|Object} chunk
 */
Peer.prototype.send = function (chunk) {
  var self = this

  if (!isTypedArray.strict(chunk) && !(chunk instanceof ArrayBuffer) &&
    !Buffer.isBuffer(chunk) && typeof chunk !== 'string' &&
    (typeof Blob === 'undefined' || !(chunk instanceof Blob))) {
    chunk = JSON.stringify(chunk)
  }

  // `wrtc` module doesn't accept node.js buffer
  if (Buffer.isBuffer(chunk) && !isTypedArray.strict(chunk)) {
    chunk = new Uint8Array(chunk)
  }

  var len = chunk.length || chunk.byteLength || chunk.size
  self._channel.send(chunk)
  self._debug('write: %d bytes', len)
}

Peer.prototype.destroy = function (onclose) {
  var self = this
  self._destroy(null, onclose)
}

Peer.prototype._destroy = function (err, onclose) {
  var self = this
  if (self.destroyed) return
  if (onclose) self.once('close', onclose)

  self._debug('destroy (error: %s)', err && err.message)

  self.readable = self.writable = false

  if (!self._readableState.ended) self.push(null)
  if (!self._writableState.finished) self.end()

  self.destroyed = true
  self.connected = false
  self._pcReady = false
  self._channelReady = false

  self._chunk = null
  self._cb = null
  clearInterval(self._interval)
  clearTimeout(self._reconnectTimeout)

  if (self._pc) {
    try {
      self._pc.close()
    } catch (err) {}

    self._pc.oniceconnectionstatechange = null
    self._pc.onsignalingstatechange = null
    self._pc.onicecandidate = null
  }

  if (self._channel) {
    try {
      self._channel.close()
    } catch (err) {}

    self._channel.onmessage = null
    self._channel.onopen = null
    self._channel.onclose = null
  }
  self._pc = null
  self._channel = null

  if (err) self.emit('error', err)
  self.emit('close')
}

Peer.prototype._setupData = function (event) {
  var self = this
  self._channel = event.channel
  self.channelName = self._channel.label

  self._channel.binaryType = 'arraybuffer'
  self._channel.onmessage = self._onChannelMessage.bind(self)
  self._channel.onopen = self._onChannelOpen.bind(self)
  self._channel.onclose = self._onChannelClose.bind(self)
}

Peer.prototype._read = function () {}

Peer.prototype._write = function (chunk, encoding, cb) {
  var self = this
  if (self.destroyed) return cb(new Error('cannot write after peer is destroyed'))

  if (self.connected) {
    self.send(chunk)
    if (self._channel.bufferedAmount > self._maxBufferedAmount) {
      self._debug('start backpressure: bufferedAmount %d', self._channel.bufferedAmount)
      self._cb = cb
    } else {
      cb(null)
    }
  } else {
    self._debug('write before connect')
    self._chunk = chunk
    self._cb = cb
  }
}

Peer.prototype._createOffer = function () {
  var self = this
  if (self.destroyed) return

  self._pc.createOffer(function (offer) {
    if (self.destroyed) return
    speedHack(offer)
    offer.sdp = self.sdpTransform(offer.sdp)
    self._pc.setLocalDescription(offer, noop, self._onError.bind(self))
    var sendOffer = function () {
      self._debug('signal')
      self.emit('signal', self._pc.localDescription || offer)
    }
    if (self.trickle || self._iceComplete) sendOffer()
    else self.once('_iceComplete', sendOffer) // wait for candidates
  }, self._onError.bind(self), self.offerConstraints)
}

Peer.prototype._createAnswer = function () {
  var self = this
  if (self.destroyed) return

  self._pc.createAnswer(function (answer) {
    if (self.destroyed) return
    speedHack(answer)
    answer.sdp = self.sdpTransform(answer.sdp)
    self._pc.setLocalDescription(answer, noop, self._onError.bind(self))
    var sendAnswer = function () {
      self._debug('signal')
      self.emit('signal', self._pc.localDescription || answer)
    }
    if (self.trickle || self._iceComplete) sendAnswer()
    else self.once('_iceComplete', sendAnswer)
  }, self._onError.bind(self), self.answerConstraints)
}

Peer.prototype._onIceConnectionStateChange = function () {
  var self = this
  if (self.destroyed) return
  var iceGatheringState = self._pc.iceGatheringState
  var iceConnectionState = self._pc.iceConnectionState
  self._debug('iceConnectionStateChange %s %s', iceGatheringState, iceConnectionState)
  self.emit('iceConnectionStateChange', iceGatheringState, iceConnectionState)
  if (iceConnectionState === 'connected' || iceConnectionState === 'completed') {
    clearTimeout(self._reconnectTimeout)
    self._pcReady = true
    self._maybeReady()
  }
  if (iceConnectionState === 'disconnected') {
    if (self.reconnectTimer) {
      // If user has set `opt.reconnectTimer`, allow time for ICE to attempt a reconnect
      clearTimeout(self._reconnectTimeout)
      self._reconnectTimeout = setTimeout(function () {
        self._destroy()
      }, self.reconnectTimer)
    } else {
      self._destroy()
    }
  }
  if (iceConnectionState === 'closed') {
    self._destroy()
  }
}

Peer.prototype._maybeReady = function () {
  var self = this
  self._debug('maybeReady pc %s channel %s', self._pcReady, self._channelReady)
  if (self.connected || self._connecting || !self._pcReady || !self._channelReady) return
  self._connecting = true

  if (typeof window !== 'undefined' && !!window.mozRTCPeerConnection) {
    self._pc.getStats(null, function (res) {
      var items = []
      res.forEach(function (item) {
        items.push(item)
      })
      onStats(items)
    }, self._onError.bind(self))
  } else {
    self._pc.getStats(function (res) {
      var items = []
      res.result().forEach(function (result) {
        var item = {}
        result.names().forEach(function (name) {
          item[name] = result.stat(name)
        })
        item.id = result.id
        item.type = result.type
        item.timestamp = result.timestamp
        items.push(item)
      })
      onStats(items)
    })
  }

  function onStats (items) {
    items.forEach(function (item) {
      if (item.type === 'remotecandidate') {
        self.remoteAddress = item.ipAddress
        self.remoteFamily = 'IPv4'
        self.remotePort = Number(item.portNumber)
        self._debug(
          'connect remote: %s:%s (%s)',
          self.remoteAddress, self.remotePort, self.remoteFamily
        )
      } else if (item.type === 'localcandidate' && item.candidateType === 'host') {
        self.localAddress = item.ipAddress
        self.localPort = Number(item.portNumber)
        self._debug('connect local: %s:%s', self.localAddress, self.localPort)
      }
    })

    self._connecting = false
    self.connected = true

    if (self._chunk) {
      self.send(self._chunk)
      self._chunk = null
      self._debug('sent chunk from "write before connect"')

      var cb = self._cb
      self._cb = null
      cb(null)
    }

    self._interval = setInterval(function () {
      if (!self._cb || !self._channel || self._channel.bufferedAmount > self._maxBufferedAmount) return
      self._debug('ending backpressure: bufferedAmount %d', self._channel.bufferedAmount)
      var cb = self._cb
      self._cb = null
      cb(null)
    }, 150)
    if (self._interval.unref) self._interval.unref()

    self._debug('connect')
    self.emit('connect')
  }
}

Peer.prototype._onSignalingStateChange = function () {
  var self = this
  if (self.destroyed) return
  self._debug('signalingStateChange %s', self._pc.signalingState)
  self.emit('signalingStateChange', self._pc.signalingState)
}

Peer.prototype._onIceCandidate = function (event) {
  var self = this
  if (self.destroyed) return
  if (event.candidate && self.trickle) {
    self.emit('signal', { candidate: event.candidate })
  } else if (!event.candidate) {
    self._iceComplete = true
    self.emit('_iceComplete')
  }
}

Peer.prototype._onChannelMessage = function (event) {
  var self = this
  if (self.destroyed) return
  var data = event.data
  self._debug('read: %d bytes', data.byteLength || data.length)

  if (data instanceof ArrayBuffer) {
    data = toBuffer(new Uint8Array(data))
    self.push(data)
  } else {
    try {
      data = JSON.parse(data)
    } catch (err) {}
    self.emit('data', data)
  }
}

Peer.prototype._onChannelOpen = function () {
  var self = this
  if (self.connected || self.destroyed) return
  self._debug('on channel open')
  self._channelReady = true
  self._maybeReady()
}

Peer.prototype._onChannelClose = function () {
  var self = this
  if (self.destroyed) return
  self._debug('on channel close')
  self._destroy()
}

Peer.prototype._onAddStream = function (event) {
  var self = this
  if (self.destroyed) return
  self._debug('on add stream')
  self.emit('stream', event.stream)
}

Peer.prototype._onError = function (err) {
  var self = this
  if (self.destroyed) return
  self._debug('error %s', err.message || err)
  self._destroy(err)
}

Peer.prototype._debug = function () {
  var self = this
  var args = [].slice.call(arguments)
  var id = self.channelName && self.channelName.substring(0, 7)
  args[0] = '[' + id + '] ' + args[0]
  debug.apply(null, args)
}

function getBrowserRTC () {
  if (typeof window === 'undefined') return null
  var wrtc = {
    RTCPeerConnection: window.mozRTCPeerConnection || window.RTCPeerConnection ||
      window.webkitRTCPeerConnection,
    RTCSessionDescription: window.mozRTCSessionDescription ||
      window.RTCSessionDescription || window.webkitRTCSessionDescription,
    RTCIceCandidate: window.mozRTCIceCandidate || window.RTCIceCandidate ||
      window.webkitRTCIceCandidate
  }
  if (!wrtc.RTCPeerConnection) return null
  return wrtc
}

function speedHack (obj) {
  var s = obj.sdp.split('b=AS:30')
  if (s.length > 1) obj.sdp = s[0] + 'b=AS:1638400' + s[1]
}

function noop () {}

}).call(this,{"isBuffer":require("/usr/local/lib/node_modules/browserify/node_modules/insert-module-globals/node_modules/is-buffer/index.js")})

},{"/usr/local/lib/node_modules/browserify/node_modules/insert-module-globals/node_modules/is-buffer/index.js":45,"debug":23,"hat":26,"inherits":27,"is-typedarray":28,"once":30,"stream":61,"typedarray-to-buffer":31}],23:[function(require,module,exports){

/**
 * This is the web browser implementation of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = require('./debug');
exports.log = log;
exports.formatArgs = formatArgs;
exports.save = save;
exports.load = load;
exports.useColors = useColors;
exports.storage = 'undefined' != typeof chrome
               && 'undefined' != typeof chrome.storage
                  ? chrome.storage.local
                  : localstorage();

/**
 * Colors.
 */

exports.colors = [
  'lightseagreen',
  'forestgreen',
  'goldenrod',
  'dodgerblue',
  'darkorchid',
  'crimson'
];

/**
 * Currently only WebKit-based Web Inspectors, Firefox >= v31,
 * and the Firebug extension (any Firefox version) are known
 * to support "%c" CSS customizations.
 *
 * TODO: add a `localStorage` variable to explicitly enable/disable colors
 */

function useColors() {
  // is webkit? http://stackoverflow.com/a/16459606/376773
  return ('WebkitAppearance' in document.documentElement.style) ||
    // is firebug? http://stackoverflow.com/a/398120/376773
    (window.console && (console.firebug || (console.exception && console.table))) ||
    // is firefox >= v31?
    // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    (navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31);
}

/**
 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
 */

exports.formatters.j = function(v) {
  return JSON.stringify(v);
};


/**
 * Colorize log arguments if enabled.
 *
 * @api public
 */

function formatArgs() {
  var args = arguments;
  var useColors = this.useColors;

  args[0] = (useColors ? '%c' : '')
    + this.namespace
    + (useColors ? ' %c' : ' ')
    + args[0]
    + (useColors ? '%c ' : ' ')
    + '+' + exports.humanize(this.diff);

  if (!useColors) return args;

  var c = 'color: ' + this.color;
  args = [args[0], c, 'color: inherit'].concat(Array.prototype.slice.call(args, 1));

  // the final "%c" is somewhat tricky, because there could be other
  // arguments passed either before or after the %c, so we need to
  // figure out the correct index to insert the CSS into
  var index = 0;
  var lastC = 0;
  args[0].replace(/%[a-z%]/g, function(match) {
    if ('%%' === match) return;
    index++;
    if ('%c' === match) {
      // we only are interested in the *last* %c
      // (the user may have provided their own)
      lastC = index;
    }
  });

  args.splice(lastC, 0, c);
  return args;
}

/**
 * Invokes `console.log()` when available.
 * No-op when `console.log` is not a "function".
 *
 * @api public
 */

function log() {
  // this hackery is required for IE8/9, where
  // the `console.log` function doesn't have 'apply'
  return 'object' === typeof console
    && console.log
    && Function.prototype.apply.call(console.log, console, arguments);
}

/**
 * Save `namespaces`.
 *
 * @param {String} namespaces
 * @api private
 */

function save(namespaces) {
  try {
    if (null == namespaces) {
      exports.storage.removeItem('debug');
    } else {
      exports.storage.debug = namespaces;
    }
  } catch(e) {}
}

/**
 * Load `namespaces`.
 *
 * @return {String} returns the previously persisted debug modes
 * @api private
 */

function load() {
  var r;
  try {
    r = exports.storage.debug;
  } catch(e) {}
  return r;
}

/**
 * Enable namespaces listed in `localStorage.debug` initially.
 */

exports.enable(load());

/**
 * Localstorage attempts to return the localstorage.
 *
 * This is necessary because safari throws
 * when a user disables cookies/localstorage
 * and you attempt to access it.
 *
 * @return {LocalStorage}
 * @api private
 */

function localstorage(){
  try {
    return window.localStorage;
  } catch (e) {}
}

},{"./debug":24}],24:[function(require,module,exports){

/**
 * This is the common logic for both the Node.js and web browser
 * implementations of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = debug;
exports.coerce = coerce;
exports.disable = disable;
exports.enable = enable;
exports.enabled = enabled;
exports.humanize = require('ms');

/**
 * The currently active debug mode names, and names to skip.
 */

exports.names = [];
exports.skips = [];

/**
 * Map of special "%n" handling functions, for the debug "format" argument.
 *
 * Valid key names are a single, lowercased letter, i.e. "n".
 */

exports.formatters = {};

/**
 * Previously assigned color.
 */

var prevColor = 0;

/**
 * Previous log timestamp.
 */

var prevTime;

/**
 * Select a color.
 *
 * @return {Number}
 * @api private
 */

function selectColor() {
  return exports.colors[prevColor++ % exports.colors.length];
}

/**
 * Create a debugger with the given `namespace`.
 *
 * @param {String} namespace
 * @return {Function}
 * @api public
 */

function debug(namespace) {

  // define the `disabled` version
  function disabled() {
  }
  disabled.enabled = false;

  // define the `enabled` version
  function enabled() {

    var self = enabled;

    // set `diff` timestamp
    var curr = +new Date();
    var ms = curr - (prevTime || curr);
    self.diff = ms;
    self.prev = prevTime;
    self.curr = curr;
    prevTime = curr;

    // add the `color` if not set
    if (null == self.useColors) self.useColors = exports.useColors();
    if (null == self.color && self.useColors) self.color = selectColor();

    var args = Array.prototype.slice.call(arguments);

    args[0] = exports.coerce(args[0]);

    if ('string' !== typeof args[0]) {
      // anything else let's inspect with %o
      args = ['%o'].concat(args);
    }

    // apply any `formatters` transformations
    var index = 0;
    args[0] = args[0].replace(/%([a-z%])/g, function(match, format) {
      // if we encounter an escaped % then don't increase the array index
      if (match === '%%') return match;
      index++;
      var formatter = exports.formatters[format];
      if ('function' === typeof formatter) {
        var val = args[index];
        match = formatter.call(self, val);

        // now we need to remove `args[index]` since it's inlined in the `format`
        args.splice(index, 1);
        index--;
      }
      return match;
    });

    if ('function' === typeof exports.formatArgs) {
      args = exports.formatArgs.apply(self, args);
    }
    var logFn = enabled.log || exports.log || console.log.bind(console);
    logFn.apply(self, args);
  }
  enabled.enabled = true;

  var fn = exports.enabled(namespace) ? enabled : disabled;

  fn.namespace = namespace;

  return fn;
}

/**
 * Enables a debug mode by namespaces. This can include modes
 * separated by a colon and wildcards.
 *
 * @param {String} namespaces
 * @api public
 */

function enable(namespaces) {
  exports.save(namespaces);

  var split = (namespaces || '').split(/[\s,]+/);
  var len = split.length;

  for (var i = 0; i < len; i++) {
    if (!split[i]) continue; // ignore empty strings
    namespaces = split[i].replace(/\*/g, '.*?');
    if (namespaces[0] === '-') {
      exports.skips.push(new RegExp('^' + namespaces.substr(1) + '$'));
    } else {
      exports.names.push(new RegExp('^' + namespaces + '$'));
    }
  }
}

/**
 * Disable debug output.
 *
 * @api public
 */

function disable() {
  exports.enable('');
}

/**
 * Returns true if the given mode name is enabled, false otherwise.
 *
 * @param {String} name
 * @return {Boolean}
 * @api public
 */

function enabled(name) {
  var i, len;
  for (i = 0, len = exports.skips.length; i < len; i++) {
    if (exports.skips[i].test(name)) {
      return false;
    }
  }
  for (i = 0, len = exports.names.length; i < len; i++) {
    if (exports.names[i].test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Coerce `val`.
 *
 * @param {Mixed} val
 * @return {Mixed}
 * @api private
 */

function coerce(val) {
  if (val instanceof Error) return val.stack || val.message;
  return val;
}

},{"ms":25}],25:[function(require,module,exports){
/**
 * Helpers.
 */

var s = 1000;
var m = s * 60;
var h = m * 60;
var d = h * 24;
var y = d * 365.25;

/**
 * Parse or format the given `val`.
 *
 * Options:
 *
 *  - `long` verbose formatting [false]
 *
 * @param {String|Number} val
 * @param {Object} options
 * @return {String|Number}
 * @api public
 */

module.exports = function(val, options){
  options = options || {};
  if ('string' == typeof val) return parse(val);
  return options.long
    ? long(val)
    : short(val);
};

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = '' + str;
  if (str.length > 10000) return;
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(str);
  if (!match) return;
  var n = parseFloat(match[1]);
  var type = (match[2] || 'ms').toLowerCase();
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y;
    case 'days':
    case 'day':
    case 'd':
      return n * d;
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h;
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m;
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s;
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n;
  }
}

/**
 * Short format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function short(ms) {
  if (ms >= d) return Math.round(ms / d) + 'd';
  if (ms >= h) return Math.round(ms / h) + 'h';
  if (ms >= m) return Math.round(ms / m) + 'm';
  if (ms >= s) return Math.round(ms / s) + 's';
  return ms + 'ms';
}

/**
 * Long format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function long(ms) {
  return plural(ms, d, 'day')
    || plural(ms, h, 'hour')
    || plural(ms, m, 'minute')
    || plural(ms, s, 'second')
    || ms + ' ms';
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) return;
  if (ms < n * 1.5) return Math.floor(ms / n) + ' ' + name;
  return Math.ceil(ms / n) + ' ' + name + 's';
}

},{}],26:[function(require,module,exports){
var hat = module.exports = function (bits, base) {
    if (!base) base = 16;
    if (bits === undefined) bits = 128;
    if (bits <= 0) return '0';
    
    var digits = Math.log(Math.pow(2, bits)) / Math.log(base);
    for (var i = 2; digits === Infinity; i *= 2) {
        digits = Math.log(Math.pow(2, bits / i)) / Math.log(base) * i;
    }
    
    var rem = digits - Math.floor(digits);
    
    var res = '';
    
    for (var i = 0; i < Math.floor(digits); i++) {
        var x = Math.floor(Math.random() * base).toString(base);
        res = x + res;
    }
    
    if (rem) {
        var b = Math.pow(base, rem);
        var x = Math.floor(Math.random() * b).toString(base);
        res = x + res;
    }
    
    var parsed = parseInt(res, base);
    if (parsed !== Infinity && parsed >= Math.pow(2, bits)) {
        return hat(bits, base)
    }
    else return res;
};

hat.rack = function (bits, base, expandBy) {
    var fn = function (data) {
        var iters = 0;
        do {
            if (iters ++ > 10) {
                if (expandBy) bits += expandBy;
                else throw new Error('too many ID collisions, use more bits')
            }
            
            var id = hat(bits, base);
        } while (Object.hasOwnProperty.call(hats, id));
        
        hats[id] = data;
        return id;
    };
    var hats = fn.hats = {};
    
    fn.get = function (id) {
        return fn.hats[id];
    };
    
    fn.set = function (id, value) {
        fn.hats[id] = value;
        return fn;
    };
    
    fn.bits = bits || 128;
    fn.base = base || 16;
    return fn;
};

},{}],27:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],28:[function(require,module,exports){
module.exports      = isTypedArray
isTypedArray.strict = isStrictTypedArray
isTypedArray.loose  = isLooseTypedArray

var toString = Object.prototype.toString
var names = {
    '[object Int8Array]': true
  , '[object Int16Array]': true
  , '[object Int32Array]': true
  , '[object Uint8Array]': true
  , '[object Uint8ClampedArray]': true
  , '[object Uint16Array]': true
  , '[object Uint32Array]': true
  , '[object Float32Array]': true
  , '[object Float64Array]': true
}

function isTypedArray(arr) {
  return (
       isStrictTypedArray(arr)
    || isLooseTypedArray(arr)
  )
}

function isStrictTypedArray(arr) {
  return (
       arr instanceof Int8Array
    || arr instanceof Int16Array
    || arr instanceof Int32Array
    || arr instanceof Uint8Array
    || arr instanceof Uint8ClampedArray
    || arr instanceof Uint16Array
    || arr instanceof Uint32Array
    || arr instanceof Float32Array
    || arr instanceof Float64Array
  )
}

function isLooseTypedArray(arr) {
  return names[toString.call(arr)]
}

},{}],29:[function(require,module,exports){
// Returns a wrapper function that returns a wrapped callback
// The wrapper function should do some stuff, and return a
// presumably different callback function.
// This makes sure that own properties are retained, so that
// decorations and such are not lost along the way.
module.exports = wrappy
function wrappy (fn, cb) {
  if (fn && cb) return wrappy(fn)(cb)

  if (typeof fn !== 'function')
    throw new TypeError('need wrapper function')

  Object.keys(fn).forEach(function (k) {
    wrapper[k] = fn[k]
  })

  return wrapper

  function wrapper() {
    var args = new Array(arguments.length)
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i]
    }
    var ret = fn.apply(this, args)
    var cb = args[args.length-1]
    if (typeof ret === 'function' && ret !== cb) {
      Object.keys(cb).forEach(function (k) {
        ret[k] = cb[k]
      })
    }
    return ret
  }
}

},{}],30:[function(require,module,exports){
var wrappy = require('wrappy')
module.exports = wrappy(once)

once.proto = once(function () {
  Object.defineProperty(Function.prototype, 'once', {
    value: function () {
      return once(this)
    },
    configurable: true
  })
})

function once (fn) {
  var f = function () {
    if (f.called) return f.value
    f.called = true
    return f.value = fn.apply(this, arguments)
  }
  f.called = false
  return f
}

},{"wrappy":29}],31:[function(require,module,exports){
(function (Buffer){
/**
 * Convert a typed array to a Buffer without a copy
 *
 * Author:   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * License:  MIT
 *
 * `npm install typedarray-to-buffer`
 */

var isTypedArray = require('is-typedarray').strict

module.exports = function (arr) {
  // If `Buffer` is the browser `buffer` module, and the browser supports typed arrays,
  // then avoid a copy. Otherwise, create a `Buffer` with a copy.
  var constructor = Buffer.TYPED_ARRAY_SUPPORT
    ? Buffer._augment
    : function (arr) { return new Buffer(arr) }

  if (arr instanceof Uint8Array) {
    return constructor(arr)
  } else if (arr instanceof ArrayBuffer) {
    return constructor(new Uint8Array(arr))
  } else if (isTypedArray(arr)) {
    // Use the typed array's underlying ArrayBuffer to back new Buffer. This respects
    // the "view" on the ArrayBuffer, i.e. byteOffset and byteLength. No copy.
    return constructor(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength))
  } else {
    // Unsupported type, just pass it through to the `Buffer` constructor.
    return new Buffer(arr)
  }
}

}).call(this,require("buffer").Buffer)

},{"buffer":39,"is-typedarray":28}],32:[function(require,module,exports){
'use strict';
module.exports = SortedArray
var search = require('binary-search')

function SortedArray(cmp, arr) {
  if (typeof cmp != 'function')
    throw new TypeError('comparator must be a function')

  this.arr = arr || []
  this.cmp = cmp
}

SortedArray.prototype.insert = function(element) {
  var index = search(this.arr, element, this.cmp)
  if (index < 0)
    index = ~index

  this.arr.splice(index, 0, element)
}

SortedArray.prototype.indexOf = function(element) {
  var index = search(this.arr, element, this.cmp)
  return index >= 0
    ? index
    : -1
}

SortedArray.prototype.remove = function(element) {
  var index = search(this.arr, element, this.cmp)
  if (index < 0)
    return false

  this.arr.splice(index, 1)
  return true
}

},{"binary-search":33}],33:[function(require,module,exports){
module.exports = function(haystack, needle, comparator, low, high) {
  var mid, cmp;

  if(low === undefined)
    low = 0;

  else {
    low = low|0;
    if(low < 0 || low >= haystack.length)
      throw new RangeError("invalid lower bound");
  }

  if(high === undefined)
    high = haystack.length - 1;

  else {
    high = high|0;
    if(high < low || high >= haystack.length)
      throw new RangeError("invalid upper bound");
  }

  while(low <= high) {
    /* Note that "(low + high) >>> 1" may overflow, and results in a typecast
     * to double (which gives the wrong results). */
    mid = low + (high - low >> 1);
    cmp = +comparator(haystack[mid], needle);

    /* Too low. */
    if(cmp < 0.0) 
      low  = mid + 1;

    /* Too high. */
    else if(cmp > 0.0)
      high = mid - 1;
    
    /* Key found. */
    else
      return mid;
  }

  /* Key not found. */
  return ~low;
}

},{}],34:[function(require,module,exports){
var SortedArray = require('sorted-cmp-array');
var Comparator = require('./vvweentry.js').Comparator;
var VVwEEntry = require('./vvweentry.js');

/**
 * \class VVwE
 * \brief class version vector with exception keeps track of events in a 
 * concise way
 * \param e the entry chosen by the local site (1 entry <-> 1 site)
 */
function VVwE(e){
    this.local = new VVwEEntry(e);
    this.vector = new SortedArray(Comparator);
    this.vector.insert(this.local);
};

/*!
 * \brief clone of this vvwe
 */
VVwE.prototype.clone = function(){
    var cloneVVwE = new VVwE(this.local.e);
    for (var i=0; i<this.vector.arr.length; ++i){
        cloneVVwE.vector.arr[i] = new VVwEEntry(this.vector.arr[i].e);
        cloneVVwE.vector.arr[i].v = this.vector.arr[i].v;
        for (var j=0; j<this.vector.arr[i].x.length; ++j){
            cloneVVwE.vector.arr[i].x.push(this.vector.arr[i].x[j]);
        };
        if (cloneVVwE.vector.arr[i].e === this.local.e){
            cloneVVwE.local = cloneVVwE.vector.arr[i];
        };
    };
    return cloneVVwE;
};

VVwE.prototype.fromJSON = function(object){
    for (var i=0; i<object.vector.arr.length; ++i){
        this.vector.arr[i] = new VVwEEntry(object.vector.arr[i].e);
        this.vector.arr[i].v = object.vector.arr[i].v;
        for (var j=0; j<object.vector.arr[i].x.length; ++j){
            this.vector.arr[i].x.push(object.vector.arr[i].x[j]);
        };
        if (object.vector.arr[i].e === object.local.e){
            this.local = this.vector.arr[i];
        };
    };
    return this;
};

/**
 * \brief increment the entry of the vector on local update
 * \return {_e: entry, _c: counter} uniquely identifying the operation
 */
VVwE.prototype.increment = function(){
    this.local.increment();
    return {_e: this.local.e, _c:this.local.v}; 
};


/**
 * \brief increment from a remote operation
 * \param ec the entry and clock of the received event to add supposedly rdy
 * the type is {_e: entry, _c: counter}
 */
VVwE.prototype.incrementFrom = function (ec){
    if (!ec || (ec && !ec._e) || (ec && !ec._c)) {return;}
    // #0 find the entry within the array of VVwEntries
    var index = this.vector.indexOf(ec._e);
    if (index < 0){
        // #1 if the entry does not exist, initialize and increment
        this.vector.insert(new VVwEEntry(ec._e));
        this.vector.arr[this.vector.indexOf(ec._e)].incrementFrom(ec._c);
    } else {
        // #2 otherwise, only increment
        this.vector.arr[index].incrementFrom(ec._c);
    };
};


/**
 * \brief check if the argument are causally ready regards to this vector
 * \param ec the site clock that happen-before the current event
 */
VVwE.prototype.isReady = function(ec){
    var ready = !ec;
    if (!ready){
        var index = this.vector.indexOf(ec._e);
        ready = index >=0 && ec._c <= this.vector.arr[index].v &&
            this.vector.arr[index].x.indexOf(ec._c)<0;
    };
    return ready;
};

/**
 * \brief check if the message contains information already delivered
 * \param ec the site clock to check
 */
VVwE.prototype.isLower = function(ec){
    return (ec && this.isReady(ec));
};

/**
 * \brief merge the version vector in argument with this
 * \param other the other version vector to merge
 */
VVwE.prototype.merge = function(other){
    for (var i = 0; i < other.vector.arr.length; ++i){
        var entry = other.vector.arr[i];
        var index = this.vector.indexOf(entry);
        if (index < 0){
            // #1 entry does not exist, fully copy it
            var newEntry = new VVwEEntry(entry.e);
            newEntry.v = entry.v;
            for (var j = 0; j < entry.x.length; ++j){
                newEntry.x.push(entry.x[j]);
            };
            this.vector.insert(newEntry);
        }else{
            // #2 otherwise merge the entries
            var currEntry = this.vector.arr[i];
            // #2A remove the exception from our vector
            var j = 0;
            while (j<currEntry.x.length){
                if (currEntry.x[j]<entry.v &&
                    entry.x.indexOf(currEntry.x[j])<0){
                    currEntry.x.splice(j, 1);
                } else {
                    ++j;
                };
            };
            // #2B add the new exceptions
            j = 0;
            while (j<entry.x.length){
                if (entry.x[j] > currEntry.v &&
                    currEntry.x.indexOf(entry.x[j])<0){
                    currEntry.x.push(entry.x[j]);
                };
                ++j;
            };
            currEntry.v = Math.max(currEntry.v, entry.v);
        };
    };
};

module.exports = VVwE;


},{"./vvweentry.js":35,"sorted-cmp-array":36}],35:[function(require,module,exports){

/*!
  \brief create an entry of the version vector with exceptions containing the
  index of the entry, the value v that creates a contiguous interval
  from 0 to v, an array of integers that contain the operations lower to v that
  have not been received yet
  \param e the entry in the interval version vector
*/
function VVwEEntry(e){
    this.e = e;   
    this.v = 0;
    this.x = [];
};

/*!
 * \brief local counter incremented
 */
VVwEEntry.prototype.increment = function(){
    this.v += 1;
};

/**
 * \brief increment from a remote operation
 * \param c the counter of the operation to add to this 
 */
VVwEEntry.prototype.incrementFrom = function(c){
    // #1 check if the counter is included in the exceptions
    if (c < this.v){
        var index = this.x.indexOf(c);
        if (index>=0){ // the exception is found
            this.x.splice(index, 1);
        };
    };
    // #2 if the value is +1 compared to the current value of the vector
    if (c == (this.v + 1)){
        this.v += 1;
    };
    // #3 otherwise exception are made
    if (c > (this.v + 1)){
        for (var i = (this.v + 1); i<c; ++i){
            this.x.push(i);
        };
        this.v = c;
    };
};

/*!
 * \brief comparison function between two VVwE entries
 * \param a the first element
 * \param b the second element
 * \return -1 if a < b, 1 if a > b, 0 otherwise
 */
function Comparator (a, b){
    var aEntry = (a.e) || a;
    var bEntry = (b.e) || b;
    if (aEntry < bEntry){ return -1; };
    if (aEntry > bEntry){ return  1; };
    return 0;
};

module.exports = VVwEEntry;
module.exports.Comparator = Comparator;

},{}],36:[function(require,module,exports){
arguments[4][32][0].apply(exports,arguments)
},{"binary-search":37,"dup":32}],37:[function(require,module,exports){
arguments[4][33][0].apply(exports,arguments)
},{"dup":33}],38:[function(require,module,exports){

},{}],39:[function(require,module,exports){
(function (global){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

var base64 = require('base64-js')
var ieee754 = require('ieee754')
var isArray = require('is-array')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50
Buffer.poolSize = 8192 // not used by this implementation

var rootParent = {}

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Use Object implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * Due to various browser bugs, sometimes the Object implementation will be used even
 * when the browser supports typed arrays.
 *
 * Note:
 *
 *   - Firefox 4-29 lacks support for adding new properties to `Uint8Array` instances,
 *     See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438.
 *
 *   - Safari 5-7 lacks support for changing the `Object.prototype.constructor` property
 *     on objects.
 *
 *   - Chrome 9-10 is missing the `TypedArray.prototype.subarray` function.
 *
 *   - IE10 has a broken `TypedArray.prototype.subarray` function which returns arrays of
 *     incorrect length in some situations.

 * We detect these buggy browsers and set `Buffer.TYPED_ARRAY_SUPPORT` to `false` so they
 * get the Object implementation, which is slower but behaves correctly.
 */
Buffer.TYPED_ARRAY_SUPPORT = global.TYPED_ARRAY_SUPPORT !== undefined
  ? global.TYPED_ARRAY_SUPPORT
  : typedArraySupport()

function typedArraySupport () {
  function Bar () {}
  try {
    var arr = new Uint8Array(1)
    arr.foo = function () { return 42 }
    arr.constructor = Bar
    return arr.foo() === 42 && // typed array instances can be augmented
        arr.constructor === Bar && // constructor can be set
        typeof arr.subarray === 'function' && // chrome 9-10 lack `subarray`
        arr.subarray(1, 1).byteLength === 0 // ie10 has broken `subarray`
  } catch (e) {
    return false
  }
}

function kMaxLength () {
  return Buffer.TYPED_ARRAY_SUPPORT
    ? 0x7fffffff
    : 0x3fffffff
}

/**
 * Class: Buffer
 * =============
 *
 * The Buffer constructor returns instances of `Uint8Array` that are augmented
 * with function properties for all the node `Buffer` API functions. We use
 * `Uint8Array` so that square bracket notation works as expected -- it returns
 * a single octet.
 *
 * By augmenting the instances, we can avoid modifying the `Uint8Array`
 * prototype.
 */
function Buffer (arg) {
  if (!(this instanceof Buffer)) {
    // Avoid going through an ArgumentsAdaptorTrampoline in the common case.
    if (arguments.length > 1) return new Buffer(arg, arguments[1])
    return new Buffer(arg)
  }

  this.length = 0
  this.parent = undefined

  // Common case.
  if (typeof arg === 'number') {
    return fromNumber(this, arg)
  }

  // Slightly less common case.
  if (typeof arg === 'string') {
    return fromString(this, arg, arguments.length > 1 ? arguments[1] : 'utf8')
  }

  // Unusual.
  return fromObject(this, arg)
}

function fromNumber (that, length) {
  that = allocate(that, length < 0 ? 0 : checked(length) | 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) {
    for (var i = 0; i < length; i++) {
      that[i] = 0
    }
  }
  return that
}

function fromString (that, string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') encoding = 'utf8'

  // Assumption: byteLength() return value is always < kMaxLength.
  var length = byteLength(string, encoding) | 0
  that = allocate(that, length)

  that.write(string, encoding)
  return that
}

function fromObject (that, object) {
  if (Buffer.isBuffer(object)) return fromBuffer(that, object)

  if (isArray(object)) return fromArray(that, object)

  if (object == null) {
    throw new TypeError('must start with number, buffer, array or string')
  }

  if (typeof ArrayBuffer !== 'undefined') {
    if (object.buffer instanceof ArrayBuffer) {
      return fromTypedArray(that, object)
    }
    if (object instanceof ArrayBuffer) {
      return fromArrayBuffer(that, object)
    }
  }

  if (object.length) return fromArrayLike(that, object)

  return fromJsonObject(that, object)
}

function fromBuffer (that, buffer) {
  var length = checked(buffer.length) | 0
  that = allocate(that, length)
  buffer.copy(that, 0, 0, length)
  return that
}

function fromArray (that, array) {
  var length = checked(array.length) | 0
  that = allocate(that, length)
  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

// Duplicate of fromArray() to keep fromArray() monomorphic.
function fromTypedArray (that, array) {
  var length = checked(array.length) | 0
  that = allocate(that, length)
  // Truncating the elements is probably not what people expect from typed
  // arrays with BYTES_PER_ELEMENT > 1 but it's compatible with the behavior
  // of the old Buffer constructor.
  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

function fromArrayBuffer (that, array) {
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Return an augmented `Uint8Array` instance, for best performance
    array.byteLength
    that = Buffer._augment(new Uint8Array(array))
  } else {
    // Fallback: Return an object instance of the Buffer class
    that = fromTypedArray(that, new Uint8Array(array))
  }
  return that
}

function fromArrayLike (that, array) {
  var length = checked(array.length) | 0
  that = allocate(that, length)
  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

// Deserialize { type: 'Buffer', data: [1,2,3,...] } into a Buffer object.
// Returns a zero-length buffer for inputs that don't conform to the spec.
function fromJsonObject (that, object) {
  var array
  var length = 0

  if (object.type === 'Buffer' && isArray(object.data)) {
    array = object.data
    length = checked(array.length) | 0
  }
  that = allocate(that, length)

  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

if (Buffer.TYPED_ARRAY_SUPPORT) {
  Buffer.prototype.__proto__ = Uint8Array.prototype
  Buffer.__proto__ = Uint8Array
}

function allocate (that, length) {
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Return an augmented `Uint8Array` instance, for best performance
    that = Buffer._augment(new Uint8Array(length))
    that.__proto__ = Buffer.prototype
  } else {
    // Fallback: Return an object instance of the Buffer class
    that.length = length
    that._isBuffer = true
  }

  var fromPool = length !== 0 && length <= Buffer.poolSize >>> 1
  if (fromPool) that.parent = rootParent

  return that
}

function checked (length) {
  // Note: cannot use `length < kMaxLength` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= kMaxLength()) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + kMaxLength().toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (subject, encoding) {
  if (!(this instanceof SlowBuffer)) return new SlowBuffer(subject, encoding)

  var buf = new Buffer(subject, encoding)
  delete buf.parent
  return buf
}

Buffer.isBuffer = function isBuffer (b) {
  return !!(b != null && b._isBuffer)
}

Buffer.compare = function compare (a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError('Arguments must be Buffers')
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  var i = 0
  var len = Math.min(x, y)
  while (i < len) {
    if (a[i] !== b[i]) break

    ++i
  }

  if (i !== len) {
    x = a[i]
    y = b[i]
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'binary':
    case 'base64':
    case 'raw':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!isArray(list)) throw new TypeError('list argument must be an Array of Buffers.')

  if (list.length === 0) {
    return new Buffer(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; i++) {
      length += list[i].length
    }
  }

  var buf = new Buffer(length)
  var pos = 0
  for (i = 0; i < list.length; i++) {
    var item = list[i]
    item.copy(buf, pos)
    pos += item.length
  }
  return buf
}

function byteLength (string, encoding) {
  if (typeof string !== 'string') string = '' + string

  var len = string.length
  if (len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'binary':
      // Deprecated
      case 'raw':
      case 'raws':
        return len
      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) return utf8ToBytes(string).length // assume utf8
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

// pre-set for values that may exist in the future
Buffer.prototype.length = undefined
Buffer.prototype.parent = undefined

function slowToString (encoding, start, end) {
  var loweredCase = false

  start = start | 0
  end = end === undefined || end === Infinity ? this.length : end | 0

  if (!encoding) encoding = 'utf8'
  if (start < 0) start = 0
  if (end > this.length) end = this.length
  if (end <= start) return ''

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'binary':
        return binarySlice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toString = function toString () {
  var length = this.length | 0
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  if (this.length > 0) {
    str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
    if (this.length > max) str += ' ... '
  }
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return 0
  return Buffer.compare(this, b)
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset) {
  if (byteOffset > 0x7fffffff) byteOffset = 0x7fffffff
  else if (byteOffset < -0x80000000) byteOffset = -0x80000000
  byteOffset >>= 0

  if (this.length === 0) return -1
  if (byteOffset >= this.length) return -1

  // Negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = Math.max(this.length + byteOffset, 0)

  if (typeof val === 'string') {
    if (val.length === 0) return -1 // special case: looking for empty string always fails
    return String.prototype.indexOf.call(this, val, byteOffset)
  }
  if (Buffer.isBuffer(val)) {
    return arrayIndexOf(this, val, byteOffset)
  }
  if (typeof val === 'number') {
    if (Buffer.TYPED_ARRAY_SUPPORT && Uint8Array.prototype.indexOf === 'function') {
      return Uint8Array.prototype.indexOf.call(this, val, byteOffset)
    }
    return arrayIndexOf(this, [ val ], byteOffset)
  }

  function arrayIndexOf (arr, val, byteOffset) {
    var foundIndex = -1
    for (var i = 0; byteOffset + i < arr.length; i++) {
      if (arr[byteOffset + i] === val[foundIndex === -1 ? 0 : i - foundIndex]) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === val.length) return byteOffset + foundIndex
      } else {
        foundIndex = -1
      }
    }
    return -1
  }

  throw new TypeError('val must be string, number or Buffer')
}

// `get` is deprecated
Buffer.prototype.get = function get (offset) {
  console.log('.get() is deprecated. Access using array indexes instead.')
  return this.readUInt8(offset)
}

// `set` is deprecated
Buffer.prototype.set = function set (v, offset) {
  console.log('.set() is deprecated. Access using array indexes instead.')
  return this.writeUInt8(v, offset)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  // must be an even number of digits
  var strLen = string.length
  if (strLen % 2 !== 0) throw new Error('Invalid hex string')

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; i++) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (isNaN(parsed)) throw new Error('Invalid hex string')
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function binaryWrite (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset | 0
    if (isFinite(length)) {
      length = length | 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  // legacy write(string, encoding, offset, length) - remove in v0.13
  } else {
    var swap = encoding
    encoding = offset
    offset = length | 0
    length = swap
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'binary':
        return binaryWrite(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
      : (firstByte > 0xBF) ? 2
      : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function binarySlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; i++) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256)
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    newBuf = Buffer._augment(this.subarray(start, end))
  } else {
    var sliceLen = end - start
    newBuf = new Buffer(sliceLen, undefined)
    for (var i = 0; i < sliceLen; i++) {
      newBuf[i] = this[i + start]
    }
  }

  if (newBuf.length) newBuf.parent = this.parent || this

  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('buffer must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('value is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0)

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0)

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  this[offset] = (value & 0xff)
  return offset + 1
}

function objectWriteUInt16 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 2); i < j; i++) {
    buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>>
      (littleEndian ? i : 1 - i) * 8
  }
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = (value & 0xff)
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

function objectWriteUInt32 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffffffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 4); i < j; i++) {
    buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff
  }
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset + 3] = (value >>> 24)
    this[offset + 2] = (value >>> 16)
    this[offset + 1] = (value >>> 8)
    this[offset] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = value < 0 ? 1 : 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = value < 0 ? 1 : 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = (value & 0xff)
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
    this[offset + 2] = (value >>> 16)
    this[offset + 3] = (value >>> 24)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (value > max || value < min) throw new RangeError('value is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('index out of range')
  if (offset < 0) throw new RangeError('index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('sourceStart out of bounds')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start
  var i

  if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (i = len - 1; i >= 0; i--) {
      target[i + targetStart] = this[i + start]
    }
  } else if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
    // ascending copy from start
    for (i = 0; i < len; i++) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    target._set(this.subarray(start, start + len), targetStart)
  }

  return len
}

// fill(value, start=0, end=buffer.length)
Buffer.prototype.fill = function fill (value, start, end) {
  if (!value) value = 0
  if (!start) start = 0
  if (!end) end = this.length

  if (end < start) throw new RangeError('end < start')

  // Fill 0 bytes; we're done
  if (end === start) return
  if (this.length === 0) return

  if (start < 0 || start >= this.length) throw new RangeError('start out of bounds')
  if (end < 0 || end > this.length) throw new RangeError('end out of bounds')

  var i
  if (typeof value === 'number') {
    for (i = start; i < end; i++) {
      this[i] = value
    }
  } else {
    var bytes = utf8ToBytes(value.toString())
    var len = bytes.length
    for (i = start; i < end; i++) {
      this[i] = bytes[i % len]
    }
  }

  return this
}

/**
 * Creates a new `ArrayBuffer` with the *copied* memory of the buffer instance.
 * Added in Node 0.12. Only available in browsers that support ArrayBuffer.
 */
Buffer.prototype.toArrayBuffer = function toArrayBuffer () {
  if (typeof Uint8Array !== 'undefined') {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      return (new Buffer(this)).buffer
    } else {
      var buf = new Uint8Array(this.length)
      for (var i = 0, len = buf.length; i < len; i += 1) {
        buf[i] = this[i]
      }
      return buf.buffer
    }
  } else {
    throw new TypeError('Buffer.toArrayBuffer not supported in this browser')
  }
}

// HELPER FUNCTIONS
// ================

var BP = Buffer.prototype

/**
 * Augment a Uint8Array *instance* (not the Uint8Array class!) with Buffer methods
 */
Buffer._augment = function _augment (arr) {
  arr.constructor = Buffer
  arr._isBuffer = true

  // save reference to original Uint8Array set method before overwriting
  arr._set = arr.set

  // deprecated
  arr.get = BP.get
  arr.set = BP.set

  arr.write = BP.write
  arr.toString = BP.toString
  arr.toLocaleString = BP.toString
  arr.toJSON = BP.toJSON
  arr.equals = BP.equals
  arr.compare = BP.compare
  arr.indexOf = BP.indexOf
  arr.copy = BP.copy
  arr.slice = BP.slice
  arr.readUIntLE = BP.readUIntLE
  arr.readUIntBE = BP.readUIntBE
  arr.readUInt8 = BP.readUInt8
  arr.readUInt16LE = BP.readUInt16LE
  arr.readUInt16BE = BP.readUInt16BE
  arr.readUInt32LE = BP.readUInt32LE
  arr.readUInt32BE = BP.readUInt32BE
  arr.readIntLE = BP.readIntLE
  arr.readIntBE = BP.readIntBE
  arr.readInt8 = BP.readInt8
  arr.readInt16LE = BP.readInt16LE
  arr.readInt16BE = BP.readInt16BE
  arr.readInt32LE = BP.readInt32LE
  arr.readInt32BE = BP.readInt32BE
  arr.readFloatLE = BP.readFloatLE
  arr.readFloatBE = BP.readFloatBE
  arr.readDoubleLE = BP.readDoubleLE
  arr.readDoubleBE = BP.readDoubleBE
  arr.writeUInt8 = BP.writeUInt8
  arr.writeUIntLE = BP.writeUIntLE
  arr.writeUIntBE = BP.writeUIntBE
  arr.writeUInt16LE = BP.writeUInt16LE
  arr.writeUInt16BE = BP.writeUInt16BE
  arr.writeUInt32LE = BP.writeUInt32LE
  arr.writeUInt32BE = BP.writeUInt32BE
  arr.writeIntLE = BP.writeIntLE
  arr.writeIntBE = BP.writeIntBE
  arr.writeInt8 = BP.writeInt8
  arr.writeInt16LE = BP.writeInt16LE
  arr.writeInt16BE = BP.writeInt16BE
  arr.writeInt32LE = BP.writeInt32LE
  arr.writeInt32BE = BP.writeInt32BE
  arr.writeFloatLE = BP.writeFloatLE
  arr.writeFloatBE = BP.writeFloatBE
  arr.writeDoubleLE = BP.writeDoubleLE
  arr.writeDoubleBE = BP.writeDoubleBE
  arr.fill = BP.fill
  arr.inspect = BP.inspect
  arr.toArrayBuffer = BP.toArrayBuffer

  return arr
}

var INVALID_BASE64_RE = /[^+\/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = stringtrim(str).replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function stringtrim (str) {
  if (str.trim) return str.trim()
  return str.replace(/^\s+|\s+$/g, '')
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; i++) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00 | 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; i++) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"base64-js":40,"ieee754":41,"is-array":42}],40:[function(require,module,exports){
var lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

;(function (exports) {
	'use strict';

  var Arr = (typeof Uint8Array !== 'undefined')
    ? Uint8Array
    : Array

	var PLUS   = '+'.charCodeAt(0)
	var SLASH  = '/'.charCodeAt(0)
	var NUMBER = '0'.charCodeAt(0)
	var LOWER  = 'a'.charCodeAt(0)
	var UPPER  = 'A'.charCodeAt(0)
	var PLUS_URL_SAFE = '-'.charCodeAt(0)
	var SLASH_URL_SAFE = '_'.charCodeAt(0)

	function decode (elt) {
		var code = elt.charCodeAt(0)
		if (code === PLUS ||
		    code === PLUS_URL_SAFE)
			return 62 // '+'
		if (code === SLASH ||
		    code === SLASH_URL_SAFE)
			return 63 // '/'
		if (code < NUMBER)
			return -1 //no match
		if (code < NUMBER + 10)
			return code - NUMBER + 26 + 26
		if (code < UPPER + 26)
			return code - UPPER
		if (code < LOWER + 26)
			return code - LOWER + 26
	}

	function b64ToByteArray (b64) {
		var i, j, l, tmp, placeHolders, arr

		if (b64.length % 4 > 0) {
			throw new Error('Invalid string. Length must be a multiple of 4')
		}

		// the number of equal signs (place holders)
		// if there are two placeholders, than the two characters before it
		// represent one byte
		// if there is only one, then the three characters before it represent 2 bytes
		// this is just a cheap hack to not do indexOf twice
		var len = b64.length
		placeHolders = '=' === b64.charAt(len - 2) ? 2 : '=' === b64.charAt(len - 1) ? 1 : 0

		// base64 is 4/3 + up to two characters of the original data
		arr = new Arr(b64.length * 3 / 4 - placeHolders)

		// if there are placeholders, only get up to the last complete 4 chars
		l = placeHolders > 0 ? b64.length - 4 : b64.length

		var L = 0

		function push (v) {
			arr[L++] = v
		}

		for (i = 0, j = 0; i < l; i += 4, j += 3) {
			tmp = (decode(b64.charAt(i)) << 18) | (decode(b64.charAt(i + 1)) << 12) | (decode(b64.charAt(i + 2)) << 6) | decode(b64.charAt(i + 3))
			push((tmp & 0xFF0000) >> 16)
			push((tmp & 0xFF00) >> 8)
			push(tmp & 0xFF)
		}

		if (placeHolders === 2) {
			tmp = (decode(b64.charAt(i)) << 2) | (decode(b64.charAt(i + 1)) >> 4)
			push(tmp & 0xFF)
		} else if (placeHolders === 1) {
			tmp = (decode(b64.charAt(i)) << 10) | (decode(b64.charAt(i + 1)) << 4) | (decode(b64.charAt(i + 2)) >> 2)
			push((tmp >> 8) & 0xFF)
			push(tmp & 0xFF)
		}

		return arr
	}

	function uint8ToBase64 (uint8) {
		var i,
			extraBytes = uint8.length % 3, // if we have 1 byte left, pad 2 bytes
			output = "",
			temp, length

		function encode (num) {
			return lookup.charAt(num)
		}

		function tripletToBase64 (num) {
			return encode(num >> 18 & 0x3F) + encode(num >> 12 & 0x3F) + encode(num >> 6 & 0x3F) + encode(num & 0x3F)
		}

		// go through the array every three bytes, we'll deal with trailing stuff later
		for (i = 0, length = uint8.length - extraBytes; i < length; i += 3) {
			temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
			output += tripletToBase64(temp)
		}

		// pad the end with zeros, but make sure to not forget the extra bytes
		switch (extraBytes) {
			case 1:
				temp = uint8[uint8.length - 1]
				output += encode(temp >> 2)
				output += encode((temp << 4) & 0x3F)
				output += '=='
				break
			case 2:
				temp = (uint8[uint8.length - 2] << 8) + (uint8[uint8.length - 1])
				output += encode(temp >> 10)
				output += encode((temp >> 4) & 0x3F)
				output += encode((temp << 2) & 0x3F)
				output += '='
				break
		}

		return output
	}

	exports.toByteArray = b64ToByteArray
	exports.fromByteArray = uint8ToBase64
}(typeof exports === 'undefined' ? (this.base64js = {}) : exports))

},{}],41:[function(require,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],42:[function(require,module,exports){

/**
 * isArray
 */

var isArray = Array.isArray;

/**
 * toString
 */

var str = Object.prototype.toString;

/**
 * Whether or not the given `val`
 * is an array.
 *
 * example:
 *
 *        isArray([]);
 *        // > true
 *        isArray(arguments);
 *        // > false
 *        isArray('');
 *        // > false
 *
 * @param {mixed} val
 * @return {bool}
 */

module.exports = isArray || function (val) {
  return !! val && '[object Array]' == str.call(val);
};

},{}],43:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      }
      throw TypeError('Uncaught, unspecified "error" event.');
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        len = arguments.length;
        args = new Array(len - 1);
        for (i = 1; i < len; i++)
          args[i - 1] = arguments[i];
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    len = arguments.length;
    args = new Array(len - 1);
    for (i = 1; i < len; i++)
      args[i - 1] = arguments[i];

    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    var m;
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.listenerCount = function(emitter, type) {
  var ret;
  if (!emitter._events || !emitter._events[type])
    ret = 0;
  else if (isFunction(emitter._events[type]))
    ret = 1;
  else
    ret = emitter._events[type].length;
  return ret;
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],44:[function(require,module,exports){
arguments[4][27][0].apply(exports,arguments)
},{"dup":27}],45:[function(require,module,exports){
/**
 * Determine if an object is Buffer
 *
 * Author:   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * License:  MIT
 *
 * `npm install is-buffer`
 */

module.exports = function (obj) {
  return !!(obj != null &&
    (obj._isBuffer || // For Safari 5-7 (missing Object.prototype.constructor)
      (obj.constructor &&
      typeof obj.constructor.isBuffer === 'function' &&
      obj.constructor.isBuffer(obj))
    ))
}

},{}],46:[function(require,module,exports){
module.exports = Array.isArray || function (arr) {
  return Object.prototype.toString.call(arr) == '[object Array]';
};

},{}],47:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        setTimeout(drainQueue, 0);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],48:[function(require,module,exports){
module.exports = require("./lib/_stream_duplex.js")

},{"./lib/_stream_duplex.js":49}],49:[function(require,module,exports){
// a duplex stream is just a stream that is both readable and writable.
// Since JS doesn't have multiple prototypal inheritance, this class
// prototypally inherits from Readable, and then parasitically from
// Writable.

'use strict';

/*<replacement>*/
var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) keys.push(key);
  return keys;
}
/*</replacement>*/


module.exports = Duplex;

/*<replacement>*/
var processNextTick = require('process-nextick-args');
/*</replacement>*/



/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

var Readable = require('./_stream_readable');
var Writable = require('./_stream_writable');

util.inherits(Duplex, Readable);

var keys = objectKeys(Writable.prototype);
for (var v = 0; v < keys.length; v++) {
  var method = keys[v];
  if (!Duplex.prototype[method])
    Duplex.prototype[method] = Writable.prototype[method];
}

function Duplex(options) {
  if (!(this instanceof Duplex))
    return new Duplex(options);

  Readable.call(this, options);
  Writable.call(this, options);

  if (options && options.readable === false)
    this.readable = false;

  if (options && options.writable === false)
    this.writable = false;

  this.allowHalfOpen = true;
  if (options && options.allowHalfOpen === false)
    this.allowHalfOpen = false;

  this.once('end', onend);
}

// the no-half-open enforcer
function onend() {
  // if we allow half-open state, or if the writable side ended,
  // then we're ok.
  if (this.allowHalfOpen || this._writableState.ended)
    return;

  // no more data can be written.
  // But allow more writes to happen in this tick.
  processNextTick(onEndNT, this);
}

function onEndNT(self) {
  self.end();
}

function forEach (xs, f) {
  for (var i = 0, l = xs.length; i < l; i++) {
    f(xs[i], i);
  }
}

},{"./_stream_readable":51,"./_stream_writable":53,"core-util-is":54,"inherits":44,"process-nextick-args":55}],50:[function(require,module,exports){
// a passthrough stream.
// basically just the most minimal sort of Transform stream.
// Every written chunk gets output as-is.

'use strict';

module.exports = PassThrough;

var Transform = require('./_stream_transform');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

util.inherits(PassThrough, Transform);

function PassThrough(options) {
  if (!(this instanceof PassThrough))
    return new PassThrough(options);

  Transform.call(this, options);
}

PassThrough.prototype._transform = function(chunk, encoding, cb) {
  cb(null, chunk);
};

},{"./_stream_transform":52,"core-util-is":54,"inherits":44}],51:[function(require,module,exports){
(function (process){
'use strict';

module.exports = Readable;

/*<replacement>*/
var processNextTick = require('process-nextick-args');
/*</replacement>*/


/*<replacement>*/
var isArray = require('isarray');
/*</replacement>*/


/*<replacement>*/
var Buffer = require('buffer').Buffer;
/*</replacement>*/

Readable.ReadableState = ReadableState;

var EE = require('events').EventEmitter;

/*<replacement>*/
if (!EE.listenerCount) EE.listenerCount = function(emitter, type) {
  return emitter.listeners(type).length;
};
/*</replacement>*/



/*<replacement>*/
var Stream;
(function (){try{
  Stream = require('st' + 'ream');
}catch(_){}finally{
  if (!Stream)
    Stream = require('events').EventEmitter;
}}())
/*</replacement>*/

var Buffer = require('buffer').Buffer;

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/



/*<replacement>*/
var debug = require('util');
if (debug && debug.debuglog) {
  debug = debug.debuglog('stream');
} else {
  debug = function () {};
}
/*</replacement>*/

var StringDecoder;

util.inherits(Readable, Stream);

function ReadableState(options, stream) {
  var Duplex = require('./_stream_duplex');

  options = options || {};

  // object stream flag. Used to make read(n) ignore n and to
  // make all the buffer merging and length checks go away
  this.objectMode = !!options.objectMode;

  if (stream instanceof Duplex)
    this.objectMode = this.objectMode || !!options.readableObjectMode;

  // the point at which it stops calling _read() to fill the buffer
  // Note: 0 is a valid value, means "don't call _read preemptively ever"
  var hwm = options.highWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;
  this.highWaterMark = (hwm || hwm === 0) ? hwm : defaultHwm;

  // cast to ints.
  this.highWaterMark = ~~this.highWaterMark;

  this.buffer = [];
  this.length = 0;
  this.pipes = null;
  this.pipesCount = 0;
  this.flowing = null;
  this.ended = false;
  this.endEmitted = false;
  this.reading = false;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // whenever we return null, then we set a flag to say
  // that we're awaiting a 'readable' event emission.
  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // when piping, we only care about 'readable' events that happen
  // after read()ing all the bytes and not getting any pushback.
  this.ranOut = false;

  // the number of writers that are awaiting a drain event in .pipe()s
  this.awaitDrain = 0;

  // if true, a maybeReadMore has been scheduled
  this.readingMore = false;

  this.decoder = null;
  this.encoding = null;
  if (options.encoding) {
    if (!StringDecoder)
      StringDecoder = require('string_decoder/').StringDecoder;
    this.decoder = new StringDecoder(options.encoding);
    this.encoding = options.encoding;
  }
}

function Readable(options) {
  var Duplex = require('./_stream_duplex');

  if (!(this instanceof Readable))
    return new Readable(options);

  this._readableState = new ReadableState(options, this);

  // legacy
  this.readable = true;

  if (options && typeof options.read === 'function')
    this._read = options.read;

  Stream.call(this);
}

// Manually shove something into the read() buffer.
// This returns true if the highWaterMark has not been hit yet,
// similar to how Writable.write() returns true if you should
// write() some more.
Readable.prototype.push = function(chunk, encoding) {
  var state = this._readableState;

  if (!state.objectMode && typeof chunk === 'string') {
    encoding = encoding || state.defaultEncoding;
    if (encoding !== state.encoding) {
      chunk = new Buffer(chunk, encoding);
      encoding = '';
    }
  }

  return readableAddChunk(this, state, chunk, encoding, false);
};

// Unshift should *always* be something directly out of read()
Readable.prototype.unshift = function(chunk) {
  var state = this._readableState;
  return readableAddChunk(this, state, chunk, '', true);
};

Readable.prototype.isPaused = function() {
  return this._readableState.flowing === false;
};

function readableAddChunk(stream, state, chunk, encoding, addToFront) {
  var er = chunkInvalid(state, chunk);
  if (er) {
    stream.emit('error', er);
  } else if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
  } else if (state.objectMode || chunk && chunk.length > 0) {
    if (state.ended && !addToFront) {
      var e = new Error('stream.push() after EOF');
      stream.emit('error', e);
    } else if (state.endEmitted && addToFront) {
      var e = new Error('stream.unshift() after end event');
      stream.emit('error', e);
    } else {
      if (state.decoder && !addToFront && !encoding)
        chunk = state.decoder.write(chunk);

      if (!addToFront)
        state.reading = false;

      // if we want the data now, just emit it.
      if (state.flowing && state.length === 0 && !state.sync) {
        stream.emit('data', chunk);
        stream.read(0);
      } else {
        // update the buffer info.
        state.length += state.objectMode ? 1 : chunk.length;
        if (addToFront)
          state.buffer.unshift(chunk);
        else
          state.buffer.push(chunk);

        if (state.needReadable)
          emitReadable(stream);
      }

      maybeReadMore(stream, state);
    }
  } else if (!addToFront) {
    state.reading = false;
  }

  return needMoreData(state);
}



// if it's past the high water mark, we can push in some more.
// Also, if we have no data yet, we can stand some
// more bytes.  This is to work around cases where hwm=0,
// such as the repl.  Also, if the push() triggered a
// readable event, and the user called read(largeNumber) such that
// needReadable was set, then we ought to push more, so that another
// 'readable' event will be triggered.
function needMoreData(state) {
  return !state.ended &&
         (state.needReadable ||
          state.length < state.highWaterMark ||
          state.length === 0);
}

// backwards compatibility.
Readable.prototype.setEncoding = function(enc) {
  if (!StringDecoder)
    StringDecoder = require('string_decoder/').StringDecoder;
  this._readableState.decoder = new StringDecoder(enc);
  this._readableState.encoding = enc;
  return this;
};

// Don't raise the hwm > 128MB
var MAX_HWM = 0x800000;
function roundUpToNextPowerOf2(n) {
  if (n >= MAX_HWM) {
    n = MAX_HWM;
  } else {
    // Get the next highest power of 2
    n--;
    for (var p = 1; p < 32; p <<= 1) n |= n >> p;
    n++;
  }
  return n;
}

function howMuchToRead(n, state) {
  if (state.length === 0 && state.ended)
    return 0;

  if (state.objectMode)
    return n === 0 ? 0 : 1;

  if (n === null || isNaN(n)) {
    // only flow one buffer at a time
    if (state.flowing && state.buffer.length)
      return state.buffer[0].length;
    else
      return state.length;
  }

  if (n <= 0)
    return 0;

  // If we're asking for more than the target buffer level,
  // then raise the water mark.  Bump up to the next highest
  // power of 2, to prevent increasing it excessively in tiny
  // amounts.
  if (n > state.highWaterMark)
    state.highWaterMark = roundUpToNextPowerOf2(n);

  // don't have that much.  return null, unless we've ended.
  if (n > state.length) {
    if (!state.ended) {
      state.needReadable = true;
      return 0;
    } else {
      return state.length;
    }
  }

  return n;
}

// you can override either this method, or the async _read(n) below.
Readable.prototype.read = function(n) {
  debug('read', n);
  var state = this._readableState;
  var nOrig = n;

  if (typeof n !== 'number' || n > 0)
    state.emittedReadable = false;

  // if we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.
  if (n === 0 &&
      state.needReadable &&
      (state.length >= state.highWaterMark || state.ended)) {
    debug('read: emitReadable', state.length, state.ended);
    if (state.length === 0 && state.ended)
      endReadable(this);
    else
      emitReadable(this);
    return null;
  }

  n = howMuchToRead(n, state);

  // if we've ended, and we're now clear, then finish it up.
  if (n === 0 && state.ended) {
    if (state.length === 0)
      endReadable(this);
    return null;
  }

  // All the actual chunk generation logic needs to be
  // *below* the call to _read.  The reason is that in certain
  // synthetic stream cases, such as passthrough streams, _read
  // may be a completely synchronous operation which may change
  // the state of the read buffer, providing enough data when
  // before there was *not* enough.
  //
  // So, the steps are:
  // 1. Figure out what the state of things will be after we do
  // a read from the buffer.
  //
  // 2. If that resulting state will trigger a _read, then call _read.
  // Note that this may be asynchronous, or synchronous.  Yes, it is
  // deeply ugly to write APIs this way, but that still doesn't mean
  // that the Readable class should behave improperly, as streams are
  // designed to be sync/async agnostic.
  // Take note if the _read call is sync or async (ie, if the read call
  // has returned yet), so that we know whether or not it's safe to emit
  // 'readable' etc.
  //
  // 3. Actually pull the requested chunks out of the buffer and return.

  // if we need a readable event, then we need to do some reading.
  var doRead = state.needReadable;
  debug('need readable', doRead);

  // if we currently have less than the highWaterMark, then also read some
  if (state.length === 0 || state.length - n < state.highWaterMark) {
    doRead = true;
    debug('length less than watermark', doRead);
  }

  // however, if we've ended, then there's no point, and if we're already
  // reading, then it's unnecessary.
  if (state.ended || state.reading) {
    doRead = false;
    debug('reading or ended', doRead);
  }

  if (doRead) {
    debug('do read');
    state.reading = true;
    state.sync = true;
    // if the length is currently zero, then we *need* a readable event.
    if (state.length === 0)
      state.needReadable = true;
    // call internal read method
    this._read(state.highWaterMark);
    state.sync = false;
  }

  // If _read pushed data synchronously, then `reading` will be false,
  // and we need to re-evaluate how much data we can return to the user.
  if (doRead && !state.reading)
    n = howMuchToRead(nOrig, state);

  var ret;
  if (n > 0)
    ret = fromList(n, state);
  else
    ret = null;

  if (ret === null) {
    state.needReadable = true;
    n = 0;
  }

  state.length -= n;

  // If we have nothing in the buffer, then we want to know
  // as soon as we *do* get something into the buffer.
  if (state.length === 0 && !state.ended)
    state.needReadable = true;

  // If we tried to read() past the EOF, then emit end on the next tick.
  if (nOrig !== n && state.ended && state.length === 0)
    endReadable(this);

  if (ret !== null)
    this.emit('data', ret);

  return ret;
};

function chunkInvalid(state, chunk) {
  var er = null;
  if (!(Buffer.isBuffer(chunk)) &&
      typeof chunk !== 'string' &&
      chunk !== null &&
      chunk !== undefined &&
      !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  return er;
}


function onEofChunk(stream, state) {
  if (state.ended) return;
  if (state.decoder) {
    var chunk = state.decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;

  // emit 'readable' now to make sure it gets picked up.
  emitReadable(stream);
}

// Don't emit readable right away in sync mode, because this can trigger
// another read() call => stack overflow.  This way, it might trigger
// a nextTick recursion warning, but that's not so bad.
function emitReadable(stream) {
  var state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    debug('emitReadable', state.flowing);
    state.emittedReadable = true;
    if (state.sync)
      processNextTick(emitReadable_, stream);
    else
      emitReadable_(stream);
  }
}

function emitReadable_(stream) {
  debug('emit readable');
  stream.emit('readable');
  flow(stream);
}


// at this point, the user has presumably seen the 'readable' event,
// and called read() to consume some data.  that may have triggered
// in turn another _read(n) call, in which case reading = true if
// it's in progress.
// However, if we're not ended, or reading, and the length < hwm,
// then go ahead and try to read some more preemptively.
function maybeReadMore(stream, state) {
  if (!state.readingMore) {
    state.readingMore = true;
    processNextTick(maybeReadMore_, stream, state);
  }
}

function maybeReadMore_(stream, state) {
  var len = state.length;
  while (!state.reading && !state.flowing && !state.ended &&
         state.length < state.highWaterMark) {
    debug('maybeReadMore read 0');
    stream.read(0);
    if (len === state.length)
      // didn't get any data, stop spinning.
      break;
    else
      len = state.length;
  }
  state.readingMore = false;
}

// abstract method.  to be overridden in specific implementation classes.
// call cb(er, data) where data is <= n in length.
// for virtual (non-string, non-buffer) streams, "length" is somewhat
// arbitrary, and perhaps not very meaningful.
Readable.prototype._read = function(n) {
  this.emit('error', new Error('not implemented'));
};

Readable.prototype.pipe = function(dest, pipeOpts) {
  var src = this;
  var state = this._readableState;

  switch (state.pipesCount) {
    case 0:
      state.pipes = dest;
      break;
    case 1:
      state.pipes = [state.pipes, dest];
      break;
    default:
      state.pipes.push(dest);
      break;
  }
  state.pipesCount += 1;
  debug('pipe count=%d opts=%j', state.pipesCount, pipeOpts);

  var doEnd = (!pipeOpts || pipeOpts.end !== false) &&
              dest !== process.stdout &&
              dest !== process.stderr;

  var endFn = doEnd ? onend : cleanup;
  if (state.endEmitted)
    processNextTick(endFn);
  else
    src.once('end', endFn);

  dest.on('unpipe', onunpipe);
  function onunpipe(readable) {
    debug('onunpipe');
    if (readable === src) {
      cleanup();
    }
  }

  function onend() {
    debug('onend');
    dest.end();
  }

  // when the dest drains, it reduces the awaitDrain counter
  // on the source.  This would be more elegant with a .once()
  // handler in flow(), but adding and removing repeatedly is
  // too slow.
  var ondrain = pipeOnDrain(src);
  dest.on('drain', ondrain);

  function cleanup() {
    debug('cleanup');
    // cleanup event handlers once the pipe is broken
    dest.removeListener('close', onclose);
    dest.removeListener('finish', onfinish);
    dest.removeListener('drain', ondrain);
    dest.removeListener('error', onerror);
    dest.removeListener('unpipe', onunpipe);
    src.removeListener('end', onend);
    src.removeListener('end', cleanup);
    src.removeListener('data', ondata);

    // if the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    // So, if this is awaiting a drain, then we just call it now.
    // If we don't know, then assume that we are waiting for one.
    if (state.awaitDrain &&
        (!dest._writableState || dest._writableState.needDrain))
      ondrain();
  }

  src.on('data', ondata);
  function ondata(chunk) {
    debug('ondata');
    var ret = dest.write(chunk);
    if (false === ret) {
      debug('false write response, pause',
            src._readableState.awaitDrain);
      src._readableState.awaitDrain++;
      src.pause();
    }
  }

  // if the dest has an error, then stop piping into it.
  // however, don't suppress the throwing behavior for this.
  function onerror(er) {
    debug('onerror', er);
    unpipe();
    dest.removeListener('error', onerror);
    if (EE.listenerCount(dest, 'error') === 0)
      dest.emit('error', er);
  }
  // This is a brutally ugly hack to make sure that our error handler
  // is attached before any userland ones.  NEVER DO THIS.
  if (!dest._events || !dest._events.error)
    dest.on('error', onerror);
  else if (isArray(dest._events.error))
    dest._events.error.unshift(onerror);
  else
    dest._events.error = [onerror, dest._events.error];



  // Both close and finish should trigger unpipe, but only once.
  function onclose() {
    dest.removeListener('finish', onfinish);
    unpipe();
  }
  dest.once('close', onclose);
  function onfinish() {
    debug('onfinish');
    dest.removeListener('close', onclose);
    unpipe();
  }
  dest.once('finish', onfinish);

  function unpipe() {
    debug('unpipe');
    src.unpipe(dest);
  }

  // tell the dest that it's being piped to
  dest.emit('pipe', src);

  // start the flow if it hasn't been started already.
  if (!state.flowing) {
    debug('pipe resume');
    src.resume();
  }

  return dest;
};

function pipeOnDrain(src) {
  return function() {
    var state = src._readableState;
    debug('pipeOnDrain', state.awaitDrain);
    if (state.awaitDrain)
      state.awaitDrain--;
    if (state.awaitDrain === 0 && EE.listenerCount(src, 'data')) {
      state.flowing = true;
      flow(src);
    }
  };
}


Readable.prototype.unpipe = function(dest) {
  var state = this._readableState;

  // if we're not piping anywhere, then do nothing.
  if (state.pipesCount === 0)
    return this;

  // just one destination.  most common case.
  if (state.pipesCount === 1) {
    // passed in one, but it's not the right one.
    if (dest && dest !== state.pipes)
      return this;

    if (!dest)
      dest = state.pipes;

    // got a match.
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;
    if (dest)
      dest.emit('unpipe', this);
    return this;
  }

  // slow case. multiple pipe destinations.

  if (!dest) {
    // remove all.
    var dests = state.pipes;
    var len = state.pipesCount;
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;

    for (var i = 0; i < len; i++)
      dests[i].emit('unpipe', this);
    return this;
  }

  // try to find the right one.
  var i = indexOf(state.pipes, dest);
  if (i === -1)
    return this;

  state.pipes.splice(i, 1);
  state.pipesCount -= 1;
  if (state.pipesCount === 1)
    state.pipes = state.pipes[0];

  dest.emit('unpipe', this);

  return this;
};

// set up data events if they are asked for
// Ensure readable listeners eventually get something
Readable.prototype.on = function(ev, fn) {
  var res = Stream.prototype.on.call(this, ev, fn);

  // If listening to data, and it has not explicitly been paused,
  // then call resume to start the flow of data on the next tick.
  if (ev === 'data' && false !== this._readableState.flowing) {
    this.resume();
  }

  if (ev === 'readable' && this.readable) {
    var state = this._readableState;
    if (!state.readableListening) {
      state.readableListening = true;
      state.emittedReadable = false;
      state.needReadable = true;
      if (!state.reading) {
        processNextTick(nReadingNextTick, this);
      } else if (state.length) {
        emitReadable(this, state);
      }
    }
  }

  return res;
};
Readable.prototype.addListener = Readable.prototype.on;

function nReadingNextTick(self) {
  debug('readable nexttick read 0');
  self.read(0);
}

// pause() and resume() are remnants of the legacy readable stream API
// If the user uses them, then switch into old mode.
Readable.prototype.resume = function() {
  var state = this._readableState;
  if (!state.flowing) {
    debug('resume');
    state.flowing = true;
    resume(this, state);
  }
  return this;
};

function resume(stream, state) {
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    processNextTick(resume_, stream, state);
  }
}

function resume_(stream, state) {
  if (!state.reading) {
    debug('resume read 0');
    stream.read(0);
  }

  state.resumeScheduled = false;
  stream.emit('resume');
  flow(stream);
  if (state.flowing && !state.reading)
    stream.read(0);
}

Readable.prototype.pause = function() {
  debug('call pause flowing=%j', this._readableState.flowing);
  if (false !== this._readableState.flowing) {
    debug('pause');
    this._readableState.flowing = false;
    this.emit('pause');
  }
  return this;
};

function flow(stream) {
  var state = stream._readableState;
  debug('flow', state.flowing);
  if (state.flowing) {
    do {
      var chunk = stream.read();
    } while (null !== chunk && state.flowing);
  }
}

// wrap an old-style stream as the async data source.
// This is *not* part of the readable stream interface.
// It is an ugly unfortunate mess of history.
Readable.prototype.wrap = function(stream) {
  var state = this._readableState;
  var paused = false;

  var self = this;
  stream.on('end', function() {
    debug('wrapped end');
    if (state.decoder && !state.ended) {
      var chunk = state.decoder.end();
      if (chunk && chunk.length)
        self.push(chunk);
    }

    self.push(null);
  });

  stream.on('data', function(chunk) {
    debug('wrapped data');
    if (state.decoder)
      chunk = state.decoder.write(chunk);

    // don't skip over falsy values in objectMode
    if (state.objectMode && (chunk === null || chunk === undefined))
      return;
    else if (!state.objectMode && (!chunk || !chunk.length))
      return;

    var ret = self.push(chunk);
    if (!ret) {
      paused = true;
      stream.pause();
    }
  });

  // proxy all the other methods.
  // important when wrapping filters and duplexes.
  for (var i in stream) {
    if (this[i] === undefined && typeof stream[i] === 'function') {
      this[i] = function(method) { return function() {
        return stream[method].apply(stream, arguments);
      }; }(i);
    }
  }

  // proxy certain important events.
  var events = ['error', 'close', 'destroy', 'pause', 'resume'];
  forEach(events, function(ev) {
    stream.on(ev, self.emit.bind(self, ev));
  });

  // when we try to consume some more bytes, simply unpause the
  // underlying stream.
  self._read = function(n) {
    debug('wrapped _read', n);
    if (paused) {
      paused = false;
      stream.resume();
    }
  };

  return self;
};



// exposed for testing purposes only.
Readable._fromList = fromList;

// Pluck off n bytes from an array of buffers.
// Length is the combined lengths of all the buffers in the list.
function fromList(n, state) {
  var list = state.buffer;
  var length = state.length;
  var stringMode = !!state.decoder;
  var objectMode = !!state.objectMode;
  var ret;

  // nothing in the list, definitely empty.
  if (list.length === 0)
    return null;

  if (length === 0)
    ret = null;
  else if (objectMode)
    ret = list.shift();
  else if (!n || n >= length) {
    // read it all, truncate the array.
    if (stringMode)
      ret = list.join('');
    else
      ret = Buffer.concat(list, length);
    list.length = 0;
  } else {
    // read just some of it.
    if (n < list[0].length) {
      // just take a part of the first list item.
      // slice is the same for buffers and strings.
      var buf = list[0];
      ret = buf.slice(0, n);
      list[0] = buf.slice(n);
    } else if (n === list[0].length) {
      // first list is a perfect match
      ret = list.shift();
    } else {
      // complex case.
      // we have enough to cover it, but it spans past the first buffer.
      if (stringMode)
        ret = '';
      else
        ret = new Buffer(n);

      var c = 0;
      for (var i = 0, l = list.length; i < l && c < n; i++) {
        var buf = list[0];
        var cpy = Math.min(n - c, buf.length);

        if (stringMode)
          ret += buf.slice(0, cpy);
        else
          buf.copy(ret, c, 0, cpy);

        if (cpy < buf.length)
          list[0] = buf.slice(cpy);
        else
          list.shift();

        c += cpy;
      }
    }
  }

  return ret;
}

function endReadable(stream) {
  var state = stream._readableState;

  // If we get here before consuming all the bytes, then that is a
  // bug in node.  Should never happen.
  if (state.length > 0)
    throw new Error('endReadable called on non-empty stream');

  if (!state.endEmitted) {
    state.ended = true;
    processNextTick(endReadableNT, state, stream);
  }
}

function endReadableNT(state, stream) {
  // Check that we didn't get one last unshift.
  if (!state.endEmitted && state.length === 0) {
    state.endEmitted = true;
    stream.readable = false;
    stream.emit('end');
  }
}

function forEach (xs, f) {
  for (var i = 0, l = xs.length; i < l; i++) {
    f(xs[i], i);
  }
}

function indexOf (xs, x) {
  for (var i = 0, l = xs.length; i < l; i++) {
    if (xs[i] === x) return i;
  }
  return -1;
}

}).call(this,require('_process'))

},{"./_stream_duplex":49,"_process":47,"buffer":39,"core-util-is":54,"events":43,"inherits":44,"isarray":46,"process-nextick-args":55,"string_decoder/":62,"util":38}],52:[function(require,module,exports){
// a transform stream is a readable/writable stream where you do
// something with the data.  Sometimes it's called a "filter",
// but that's not a great name for it, since that implies a thing where
// some bits pass through, and others are simply ignored.  (That would
// be a valid example of a transform, of course.)
//
// While the output is causally related to the input, it's not a
// necessarily symmetric or synchronous transformation.  For example,
// a zlib stream might take multiple plain-text writes(), and then
// emit a single compressed chunk some time in the future.
//
// Here's how this works:
//
// The Transform stream has all the aspects of the readable and writable
// stream classes.  When you write(chunk), that calls _write(chunk,cb)
// internally, and returns false if there's a lot of pending writes
// buffered up.  When you call read(), that calls _read(n) until
// there's enough pending readable data buffered up.
//
// In a transform stream, the written data is placed in a buffer.  When
// _read(n) is called, it transforms the queued up data, calling the
// buffered _write cb's as it consumes chunks.  If consuming a single
// written chunk would result in multiple output chunks, then the first
// outputted bit calls the readcb, and subsequent chunks just go into
// the read buffer, and will cause it to emit 'readable' if necessary.
//
// This way, back-pressure is actually determined by the reading side,
// since _read has to be called to start processing a new chunk.  However,
// a pathological inflate type of transform can cause excessive buffering
// here.  For example, imagine a stream where every byte of input is
// interpreted as an integer from 0-255, and then results in that many
// bytes of output.  Writing the 4 bytes {ff,ff,ff,ff} would result in
// 1kb of data being output.  In this case, you could write a very small
// amount of input, and end up with a very large amount of output.  In
// such a pathological inflating mechanism, there'd be no way to tell
// the system to stop doing the transform.  A single 4MB write could
// cause the system to run out of memory.
//
// However, even in such a pathological case, only a single written chunk
// would be consumed, and then the rest would wait (un-transformed) until
// the results of the previous transformed chunk were consumed.

'use strict';

module.exports = Transform;

var Duplex = require('./_stream_duplex');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

util.inherits(Transform, Duplex);


function TransformState(stream) {
  this.afterTransform = function(er, data) {
    return afterTransform(stream, er, data);
  };

  this.needTransform = false;
  this.transforming = false;
  this.writecb = null;
  this.writechunk = null;
}

function afterTransform(stream, er, data) {
  var ts = stream._transformState;
  ts.transforming = false;

  var cb = ts.writecb;

  if (!cb)
    return stream.emit('error', new Error('no writecb in Transform class'));

  ts.writechunk = null;
  ts.writecb = null;

  if (data !== null && data !== undefined)
    stream.push(data);

  if (cb)
    cb(er);

  var rs = stream._readableState;
  rs.reading = false;
  if (rs.needReadable || rs.length < rs.highWaterMark) {
    stream._read(rs.highWaterMark);
  }
}


function Transform(options) {
  if (!(this instanceof Transform))
    return new Transform(options);

  Duplex.call(this, options);

  this._transformState = new TransformState(this);

  // when the writable side finishes, then flush out anything remaining.
  var stream = this;

  // start out asking for a readable event once data is transformed.
  this._readableState.needReadable = true;

  // we have implemented the _read method, and done the other things
  // that Readable wants before the first _read call, so unset the
  // sync guard flag.
  this._readableState.sync = false;

  if (options) {
    if (typeof options.transform === 'function')
      this._transform = options.transform;

    if (typeof options.flush === 'function')
      this._flush = options.flush;
  }

  this.once('prefinish', function() {
    if (typeof this._flush === 'function')
      this._flush(function(er) {
        done(stream, er);
      });
    else
      done(stream);
  });
}

Transform.prototype.push = function(chunk, encoding) {
  this._transformState.needTransform = false;
  return Duplex.prototype.push.call(this, chunk, encoding);
};

// This is the part where you do stuff!
// override this function in implementation classes.
// 'chunk' is an input chunk.
//
// Call `push(newChunk)` to pass along transformed output
// to the readable side.  You may call 'push' zero or more times.
//
// Call `cb(err)` when you are done with this chunk.  If you pass
// an error, then that'll put the hurt on the whole operation.  If you
// never call cb(), then you'll never get another chunk.
Transform.prototype._transform = function(chunk, encoding, cb) {
  throw new Error('not implemented');
};

Transform.prototype._write = function(chunk, encoding, cb) {
  var ts = this._transformState;
  ts.writecb = cb;
  ts.writechunk = chunk;
  ts.writeencoding = encoding;
  if (!ts.transforming) {
    var rs = this._readableState;
    if (ts.needTransform ||
        rs.needReadable ||
        rs.length < rs.highWaterMark)
      this._read(rs.highWaterMark);
  }
};

// Doesn't matter what the args are here.
// _transform does all the work.
// That we got here means that the readable side wants more data.
Transform.prototype._read = function(n) {
  var ts = this._transformState;

  if (ts.writechunk !== null && ts.writecb && !ts.transforming) {
    ts.transforming = true;
    this._transform(ts.writechunk, ts.writeencoding, ts.afterTransform);
  } else {
    // mark that we need a transform, so that any data that comes in
    // will get processed, now that we've asked for it.
    ts.needTransform = true;
  }
};


function done(stream, er) {
  if (er)
    return stream.emit('error', er);

  // if there's nothing in the write buffer, then that means
  // that nothing more will ever be provided
  var ws = stream._writableState;
  var ts = stream._transformState;

  if (ws.length)
    throw new Error('calling transform done when ws.length != 0');

  if (ts.transforming)
    throw new Error('calling transform done when still transforming');

  return stream.push(null);
}

},{"./_stream_duplex":49,"core-util-is":54,"inherits":44}],53:[function(require,module,exports){
// A bit simpler than readable streams.
// Implement an async ._write(chunk, cb), and it'll handle all
// the drain event emission and buffering.

'use strict';

module.exports = Writable;

/*<replacement>*/
var processNextTick = require('process-nextick-args');
/*</replacement>*/


/*<replacement>*/
var Buffer = require('buffer').Buffer;
/*</replacement>*/

Writable.WritableState = WritableState;


/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/



/*<replacement>*/
var Stream;
(function (){try{
  Stream = require('st' + 'ream');
}catch(_){}finally{
  if (!Stream)
    Stream = require('events').EventEmitter;
}}())
/*</replacement>*/

var Buffer = require('buffer').Buffer;

util.inherits(Writable, Stream);

function nop() {}

function WriteReq(chunk, encoding, cb) {
  this.chunk = chunk;
  this.encoding = encoding;
  this.callback = cb;
  this.next = null;
}

function WritableState(options, stream) {
  var Duplex = require('./_stream_duplex');

  options = options || {};

  // object stream flag to indicate whether or not this stream
  // contains buffers or objects.
  this.objectMode = !!options.objectMode;

  if (stream instanceof Duplex)
    this.objectMode = this.objectMode || !!options.writableObjectMode;

  // the point at which write() starts returning false
  // Note: 0 is a valid value, means that we always return false if
  // the entire buffer is not flushed immediately on write()
  var hwm = options.highWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;
  this.highWaterMark = (hwm || hwm === 0) ? hwm : defaultHwm;

  // cast to ints.
  this.highWaterMark = ~~this.highWaterMark;

  this.needDrain = false;
  // at the start of calling end()
  this.ending = false;
  // when end() has been called, and returned
  this.ended = false;
  // when 'finish' is emitted
  this.finished = false;

  // should we decode strings into buffers before passing to _write?
  // this is here so that some node-core streams can optimize string
  // handling at a lower level.
  var noDecode = options.decodeStrings === false;
  this.decodeStrings = !noDecode;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // not an actual buffer we keep track of, but a measurement
  // of how much we're waiting to get pushed to some underlying
  // socket or file.
  this.length = 0;

  // a flag to see when we're in the middle of a write.
  this.writing = false;

  // when true all writes will be buffered until .uncork() call
  this.corked = 0;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // a flag to know if we're processing previously buffered items, which
  // may call the _write() callback in the same tick, so that we don't
  // end up in an overlapped onwrite situation.
  this.bufferProcessing = false;

  // the callback that's passed to _write(chunk,cb)
  this.onwrite = function(er) {
    onwrite(stream, er);
  };

  // the callback that the user supplies to write(chunk,encoding,cb)
  this.writecb = null;

  // the amount that is being written when _write is called.
  this.writelen = 0;

  this.bufferedRequest = null;
  this.lastBufferedRequest = null;

  // number of pending user-supplied write callbacks
  // this must be 0 before 'finish' can be emitted
  this.pendingcb = 0;

  // emit prefinish if the only thing we're waiting for is _write cbs
  // This is relevant for synchronous Transform streams
  this.prefinished = false;

  // True if the error was already emitted and should not be thrown again
  this.errorEmitted = false;
}

WritableState.prototype.getBuffer = function writableStateGetBuffer() {
  var current = this.bufferedRequest;
  var out = [];
  while (current) {
    out.push(current);
    current = current.next;
  }
  return out;
};

(function (){try {
Object.defineProperty(WritableState.prototype, 'buffer', {
  get: require('util-deprecate')(function() {
    return this.getBuffer();
  }, '_writableState.buffer is deprecated. Use ' +
      '_writableState.getBuffer() instead.')
});
}catch(_){}}());


function Writable(options) {
  var Duplex = require('./_stream_duplex');

  // Writable ctor is applied to Duplexes, though they're not
  // instanceof Writable, they're instanceof Readable.
  if (!(this instanceof Writable) && !(this instanceof Duplex))
    return new Writable(options);

  this._writableState = new WritableState(options, this);

  // legacy.
  this.writable = true;

  if (options) {
    if (typeof options.write === 'function')
      this._write = options.write;

    if (typeof options.writev === 'function')
      this._writev = options.writev;
  }

  Stream.call(this);
}

// Otherwise people can pipe Writable streams, which is just wrong.
Writable.prototype.pipe = function() {
  this.emit('error', new Error('Cannot pipe. Not readable.'));
};


function writeAfterEnd(stream, cb) {
  var er = new Error('write after end');
  // TODO: defer error events consistently everywhere, not just the cb
  stream.emit('error', er);
  processNextTick(cb, er);
}

// If we get something that is not a buffer, string, null, or undefined,
// and we're not in objectMode, then that's an error.
// Otherwise stream chunks are all considered to be of length=1, and the
// watermarks determine how many objects to keep in the buffer, rather than
// how many bytes or characters.
function validChunk(stream, state, chunk, cb) {
  var valid = true;

  if (!(Buffer.isBuffer(chunk)) &&
      typeof chunk !== 'string' &&
      chunk !== null &&
      chunk !== undefined &&
      !state.objectMode) {
    var er = new TypeError('Invalid non-string/buffer chunk');
    stream.emit('error', er);
    processNextTick(cb, er);
    valid = false;
  }
  return valid;
}

Writable.prototype.write = function(chunk, encoding, cb) {
  var state = this._writableState;
  var ret = false;

  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (Buffer.isBuffer(chunk))
    encoding = 'buffer';
  else if (!encoding)
    encoding = state.defaultEncoding;

  if (typeof cb !== 'function')
    cb = nop;

  if (state.ended)
    writeAfterEnd(this, cb);
  else if (validChunk(this, state, chunk, cb)) {
    state.pendingcb++;
    ret = writeOrBuffer(this, state, chunk, encoding, cb);
  }

  return ret;
};

Writable.prototype.cork = function() {
  var state = this._writableState;

  state.corked++;
};

Writable.prototype.uncork = function() {
  var state = this._writableState;

  if (state.corked) {
    state.corked--;

    if (!state.writing &&
        !state.corked &&
        !state.finished &&
        !state.bufferProcessing &&
        state.bufferedRequest)
      clearBuffer(this, state);
  }
};

Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
  // node::ParseEncoding() requires lower case.
  if (typeof encoding === 'string')
    encoding = encoding.toLowerCase();
  if (!(['hex', 'utf8', 'utf-8', 'ascii', 'binary', 'base64',
'ucs2', 'ucs-2','utf16le', 'utf-16le', 'raw']
.indexOf((encoding + '').toLowerCase()) > -1))
    throw new TypeError('Unknown encoding: ' + encoding);
  this._writableState.defaultEncoding = encoding;
};

function decodeChunk(state, chunk, encoding) {
  if (!state.objectMode &&
      state.decodeStrings !== false &&
      typeof chunk === 'string') {
    chunk = new Buffer(chunk, encoding);
  }
  return chunk;
}

// if we're already writing something, then just put this
// in the queue, and wait our turn.  Otherwise, call _write
// If we return false, then we need a drain event, so set that flag.
function writeOrBuffer(stream, state, chunk, encoding, cb) {
  chunk = decodeChunk(state, chunk, encoding);

  if (Buffer.isBuffer(chunk))
    encoding = 'buffer';
  var len = state.objectMode ? 1 : chunk.length;

  state.length += len;

  var ret = state.length < state.highWaterMark;
  // we must ensure that previous needDrain will not be reset to false.
  if (!ret)
    state.needDrain = true;

  if (state.writing || state.corked) {
    var last = state.lastBufferedRequest;
    state.lastBufferedRequest = new WriteReq(chunk, encoding, cb);
    if (last) {
      last.next = state.lastBufferedRequest;
    } else {
      state.bufferedRequest = state.lastBufferedRequest;
    }
  } else {
    doWrite(stream, state, false, len, chunk, encoding, cb);
  }

  return ret;
}

function doWrite(stream, state, writev, len, chunk, encoding, cb) {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  if (writev)
    stream._writev(chunk, state.onwrite);
  else
    stream._write(chunk, encoding, state.onwrite);
  state.sync = false;
}

function onwriteError(stream, state, sync, er, cb) {
  --state.pendingcb;
  if (sync)
    processNextTick(cb, er);
  else
    cb(er);

  stream._writableState.errorEmitted = true;
  stream.emit('error', er);
}

function onwriteStateUpdate(state) {
  state.writing = false;
  state.writecb = null;
  state.length -= state.writelen;
  state.writelen = 0;
}

function onwrite(stream, er) {
  var state = stream._writableState;
  var sync = state.sync;
  var cb = state.writecb;

  onwriteStateUpdate(state);

  if (er)
    onwriteError(stream, state, sync, er, cb);
  else {
    // Check if we're actually ready to finish, but don't emit yet
    var finished = needFinish(state);

    if (!finished &&
        !state.corked &&
        !state.bufferProcessing &&
        state.bufferedRequest) {
      clearBuffer(stream, state);
    }

    if (sync) {
      processNextTick(afterWrite, stream, state, finished, cb);
    } else {
      afterWrite(stream, state, finished, cb);
    }
  }
}

function afterWrite(stream, state, finished, cb) {
  if (!finished)
    onwriteDrain(stream, state);
  state.pendingcb--;
  cb();
  finishMaybe(stream, state);
}

// Must force callback to be called on nextTick, so that we don't
// emit 'drain' before the write() consumer gets the 'false' return
// value, and has a chance to attach a 'drain' listener.
function onwriteDrain(stream, state) {
  if (state.length === 0 && state.needDrain) {
    state.needDrain = false;
    stream.emit('drain');
  }
}


// if there's something in the buffer waiting, then process it
function clearBuffer(stream, state) {
  state.bufferProcessing = true;
  var entry = state.bufferedRequest;

  if (stream._writev && entry && entry.next) {
    // Fast case, write everything using _writev()
    var buffer = [];
    var cbs = [];
    while (entry) {
      cbs.push(entry.callback);
      buffer.push(entry);
      entry = entry.next;
    }

    // count the one we are adding, as well.
    // TODO(isaacs) clean this up
    state.pendingcb++;
    state.lastBufferedRequest = null;
    doWrite(stream, state, true, state.length, buffer, '', function(err) {
      for (var i = 0; i < cbs.length; i++) {
        state.pendingcb--;
        cbs[i](err);
      }
    });

    // Clear buffer
  } else {
    // Slow case, write chunks one-by-one
    while (entry) {
      var chunk = entry.chunk;
      var encoding = entry.encoding;
      var cb = entry.callback;
      var len = state.objectMode ? 1 : chunk.length;

      doWrite(stream, state, false, len, chunk, encoding, cb);
      entry = entry.next;
      // if we didn't call the onwrite immediately, then
      // it means that we need to wait until it does.
      // also, that means that the chunk and cb are currently
      // being processed, so move the buffer counter past them.
      if (state.writing) {
        break;
      }
    }

    if (entry === null)
      state.lastBufferedRequest = null;
  }
  state.bufferedRequest = entry;
  state.bufferProcessing = false;
}

Writable.prototype._write = function(chunk, encoding, cb) {
  cb(new Error('not implemented'));
};

Writable.prototype._writev = null;

Writable.prototype.end = function(chunk, encoding, cb) {
  var state = this._writableState;

  if (typeof chunk === 'function') {
    cb = chunk;
    chunk = null;
    encoding = null;
  } else if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (chunk !== null && chunk !== undefined)
    this.write(chunk, encoding);

  // .end() fully uncorks
  if (state.corked) {
    state.corked = 1;
    this.uncork();
  }

  // ignore unnecessary end() calls.
  if (!state.ending && !state.finished)
    endWritable(this, state, cb);
};


function needFinish(state) {
  return (state.ending &&
          state.length === 0 &&
          state.bufferedRequest === null &&
          !state.finished &&
          !state.writing);
}

function prefinish(stream, state) {
  if (!state.prefinished) {
    state.prefinished = true;
    stream.emit('prefinish');
  }
}

function finishMaybe(stream, state) {
  var need = needFinish(state);
  if (need) {
    if (state.pendingcb === 0) {
      prefinish(stream, state);
      state.finished = true;
      stream.emit('finish');
    } else {
      prefinish(stream, state);
    }
  }
  return need;
}

function endWritable(stream, state, cb) {
  state.ending = true;
  finishMaybe(stream, state);
  if (cb) {
    if (state.finished)
      processNextTick(cb);
    else
      stream.once('finish', cb);
  }
  state.ended = true;
}

},{"./_stream_duplex":49,"buffer":39,"core-util-is":54,"events":43,"inherits":44,"process-nextick-args":55,"util-deprecate":56}],54:[function(require,module,exports){
(function (Buffer){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

function isBuffer(arg) {
  return Buffer.isBuffer(arg);
}
exports.isBuffer = isBuffer;

function objectToString(o) {
  return Object.prototype.toString.call(o);
}
}).call(this,{"isBuffer":require("/usr/local/lib/node_modules/browserify/node_modules/insert-module-globals/node_modules/is-buffer/index.js")})

},{"/usr/local/lib/node_modules/browserify/node_modules/insert-module-globals/node_modules/is-buffer/index.js":45}],55:[function(require,module,exports){
(function (process){
'use strict';
module.exports = nextTick;

function nextTick(fn) {
  var args = new Array(arguments.length - 1);
  var i = 0;
  while (i < args.length) {
    args[i++] = arguments[i];
  }
  process.nextTick(function afterTick() {
    fn.apply(null, args);
  });
}

}).call(this,require('_process'))

},{"_process":47}],56:[function(require,module,exports){
(function (global){

/**
 * Module exports.
 */

module.exports = deprecate;

/**
 * Mark that a method should not be used.
 * Returns a modified function which warns once by default.
 *
 * If `localStorage.noDeprecation = true` is set, then it is a no-op.
 *
 * If `localStorage.throwDeprecation = true` is set, then deprecated functions
 * will throw an Error when invoked.
 *
 * If `localStorage.traceDeprecation = true` is set, then deprecated functions
 * will invoke `console.trace()` instead of `console.error()`.
 *
 * @param {Function} fn - the function to deprecate
 * @param {String} msg - the string to print to the console when `fn` is invoked
 * @returns {Function} a new "deprecated" version of `fn`
 * @api public
 */

function deprecate (fn, msg) {
  if (config('noDeprecation')) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (config('throwDeprecation')) {
        throw new Error(msg);
      } else if (config('traceDeprecation')) {
        console.trace(msg);
      } else {
        console.warn(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
}

/**
 * Checks `localStorage` for boolean values for the given `name`.
 *
 * @param {String} name
 * @returns {Boolean}
 * @api private
 */

function config (name) {
  // accessing global.localStorage can trigger a DOMException in sandboxed iframes
  try {
    if (!global.localStorage) return false;
  } catch (_) {
    return false;
  }
  var val = global.localStorage[name];
  if (null == val) return false;
  return String(val).toLowerCase() === 'true';
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],57:[function(require,module,exports){
module.exports = require("./lib/_stream_passthrough.js")

},{"./lib/_stream_passthrough.js":50}],58:[function(require,module,exports){
var Stream = (function (){
  try {
    return require('st' + 'ream'); // hack to fix a circular dependency issue when used with browserify
  } catch(_){}
}());
exports = module.exports = require('./lib/_stream_readable.js');
exports.Stream = Stream || exports;
exports.Readable = exports;
exports.Writable = require('./lib/_stream_writable.js');
exports.Duplex = require('./lib/_stream_duplex.js');
exports.Transform = require('./lib/_stream_transform.js');
exports.PassThrough = require('./lib/_stream_passthrough.js');

},{"./lib/_stream_duplex.js":49,"./lib/_stream_passthrough.js":50,"./lib/_stream_readable.js":51,"./lib/_stream_transform.js":52,"./lib/_stream_writable.js":53}],59:[function(require,module,exports){
module.exports = require("./lib/_stream_transform.js")

},{"./lib/_stream_transform.js":52}],60:[function(require,module,exports){
module.exports = require("./lib/_stream_writable.js")

},{"./lib/_stream_writable.js":53}],61:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

module.exports = Stream;

var EE = require('events').EventEmitter;
var inherits = require('inherits');

inherits(Stream, EE);
Stream.Readable = require('readable-stream/readable.js');
Stream.Writable = require('readable-stream/writable.js');
Stream.Duplex = require('readable-stream/duplex.js');
Stream.Transform = require('readable-stream/transform.js');
Stream.PassThrough = require('readable-stream/passthrough.js');

// Backwards-compat with node 0.4.x
Stream.Stream = Stream;



// old-style streams.  Note that the pipe method (the only relevant
// part of this class) is overridden in the Readable class.

function Stream() {
  EE.call(this);
}

Stream.prototype.pipe = function(dest, options) {
  var source = this;

  function ondata(chunk) {
    if (dest.writable) {
      if (false === dest.write(chunk) && source.pause) {
        source.pause();
      }
    }
  }

  source.on('data', ondata);

  function ondrain() {
    if (source.readable && source.resume) {
      source.resume();
    }
  }

  dest.on('drain', ondrain);

  // If the 'end' option is not supplied, dest.end() will be called when
  // source gets the 'end' or 'close' events.  Only dest.end() once.
  if (!dest._isStdio && (!options || options.end !== false)) {
    source.on('end', onend);
    source.on('close', onclose);
  }

  var didOnEnd = false;
  function onend() {
    if (didOnEnd) return;
    didOnEnd = true;

    dest.end();
  }


  function onclose() {
    if (didOnEnd) return;
    didOnEnd = true;

    if (typeof dest.destroy === 'function') dest.destroy();
  }

  // don't leave dangling pipes when there are errors.
  function onerror(er) {
    cleanup();
    if (EE.listenerCount(this, 'error') === 0) {
      throw er; // Unhandled stream error in pipe.
    }
  }

  source.on('error', onerror);
  dest.on('error', onerror);

  // remove all the event listeners that were added.
  function cleanup() {
    source.removeListener('data', ondata);
    dest.removeListener('drain', ondrain);

    source.removeListener('end', onend);
    source.removeListener('close', onclose);

    source.removeListener('error', onerror);
    dest.removeListener('error', onerror);

    source.removeListener('end', cleanup);
    source.removeListener('close', cleanup);

    dest.removeListener('close', cleanup);
  }

  source.on('end', cleanup);
  source.on('close', cleanup);

  dest.on('close', cleanup);

  dest.emit('pipe', source);

  // Allow for unix-like usage: A.pipe(B).pipe(C)
  return dest;
};

},{"events":43,"inherits":44,"readable-stream/duplex.js":48,"readable-stream/passthrough.js":57,"readable-stream/readable.js":58,"readable-stream/transform.js":59,"readable-stream/writable.js":60}],62:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var Buffer = require('buffer').Buffer;

var isBufferEncoding = Buffer.isEncoding
  || function(encoding) {
       switch (encoding && encoding.toLowerCase()) {
         case 'hex': case 'utf8': case 'utf-8': case 'ascii': case 'binary': case 'base64': case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': case 'raw': return true;
         default: return false;
       }
     }


function assertEncoding(encoding) {
  if (encoding && !isBufferEncoding(encoding)) {
    throw new Error('Unknown encoding: ' + encoding);
  }
}

// StringDecoder provides an interface for efficiently splitting a series of
// buffers into a series of JS strings without breaking apart multi-byte
// characters. CESU-8 is handled as part of the UTF-8 encoding.
//
// @TODO Handling all encodings inside a single object makes it very difficult
// to reason about this code, so it should be split up in the future.
// @TODO There should be a utf8-strict encoding that rejects invalid UTF-8 code
// points as used by CESU-8.
var StringDecoder = exports.StringDecoder = function(encoding) {
  this.encoding = (encoding || 'utf8').toLowerCase().replace(/[-_]/, '');
  assertEncoding(encoding);
  switch (this.encoding) {
    case 'utf8':
      // CESU-8 represents each of Surrogate Pair by 3-bytes
      this.surrogateSize = 3;
      break;
    case 'ucs2':
    case 'utf16le':
      // UTF-16 represents each of Surrogate Pair by 2-bytes
      this.surrogateSize = 2;
      this.detectIncompleteChar = utf16DetectIncompleteChar;
      break;
    case 'base64':
      // Base-64 stores 3 bytes in 4 chars, and pads the remainder.
      this.surrogateSize = 3;
      this.detectIncompleteChar = base64DetectIncompleteChar;
      break;
    default:
      this.write = passThroughWrite;
      return;
  }

  // Enough space to store all bytes of a single character. UTF-8 needs 4
  // bytes, but CESU-8 may require up to 6 (3 bytes per surrogate).
  this.charBuffer = new Buffer(6);
  // Number of bytes received for the current incomplete multi-byte character.
  this.charReceived = 0;
  // Number of bytes expected for the current incomplete multi-byte character.
  this.charLength = 0;
};


// write decodes the given buffer and returns it as JS string that is
// guaranteed to not contain any partial multi-byte characters. Any partial
// character found at the end of the buffer is buffered up, and will be
// returned when calling write again with the remaining bytes.
//
// Note: Converting a Buffer containing an orphan surrogate to a String
// currently works, but converting a String to a Buffer (via `new Buffer`, or
// Buffer#write) will replace incomplete surrogates with the unicode
// replacement character. See https://codereview.chromium.org/121173009/ .
StringDecoder.prototype.write = function(buffer) {
  var charStr = '';
  // if our last write ended with an incomplete multibyte character
  while (this.charLength) {
    // determine how many remaining bytes this buffer has to offer for this char
    var available = (buffer.length >= this.charLength - this.charReceived) ?
        this.charLength - this.charReceived :
        buffer.length;

    // add the new bytes to the char buffer
    buffer.copy(this.charBuffer, this.charReceived, 0, available);
    this.charReceived += available;

    if (this.charReceived < this.charLength) {
      // still not enough chars in this buffer? wait for more ...
      return '';
    }

    // remove bytes belonging to the current character from the buffer
    buffer = buffer.slice(available, buffer.length);

    // get the character that was split
    charStr = this.charBuffer.slice(0, this.charLength).toString(this.encoding);

    // CESU-8: lead surrogate (D800-DBFF) is also the incomplete character
    var charCode = charStr.charCodeAt(charStr.length - 1);
    if (charCode >= 0xD800 && charCode <= 0xDBFF) {
      this.charLength += this.surrogateSize;
      charStr = '';
      continue;
    }
    this.charReceived = this.charLength = 0;

    // if there are no more bytes in this buffer, just emit our char
    if (buffer.length === 0) {
      return charStr;
    }
    break;
  }

  // determine and set charLength / charReceived
  this.detectIncompleteChar(buffer);

  var end = buffer.length;
  if (this.charLength) {
    // buffer the incomplete character bytes we got
    buffer.copy(this.charBuffer, 0, buffer.length - this.charReceived, end);
    end -= this.charReceived;
  }

  charStr += buffer.toString(this.encoding, 0, end);

  var end = charStr.length - 1;
  var charCode = charStr.charCodeAt(end);
  // CESU-8: lead surrogate (D800-DBFF) is also the incomplete character
  if (charCode >= 0xD800 && charCode <= 0xDBFF) {
    var size = this.surrogateSize;
    this.charLength += size;
    this.charReceived += size;
    this.charBuffer.copy(this.charBuffer, size, 0, size);
    buffer.copy(this.charBuffer, 0, 0, size);
    return charStr.substring(0, end);
  }

  // or just emit the charStr
  return charStr;
};

// detectIncompleteChar determines if there is an incomplete UTF-8 character at
// the end of the given buffer. If so, it sets this.charLength to the byte
// length that character, and sets this.charReceived to the number of bytes
// that are available for this character.
StringDecoder.prototype.detectIncompleteChar = function(buffer) {
  // determine how many bytes we have to check at the end of this buffer
  var i = (buffer.length >= 3) ? 3 : buffer.length;

  // Figure out if one of the last i bytes of our buffer announces an
  // incomplete char.
  for (; i > 0; i--) {
    var c = buffer[buffer.length - i];

    // See http://en.wikipedia.org/wiki/UTF-8#Description

    // 110XXXXX
    if (i == 1 && c >> 5 == 0x06) {
      this.charLength = 2;
      break;
    }

    // 1110XXXX
    if (i <= 2 && c >> 4 == 0x0E) {
      this.charLength = 3;
      break;
    }

    // 11110XXX
    if (i <= 3 && c >> 3 == 0x1E) {
      this.charLength = 4;
      break;
    }
  }
  this.charReceived = i;
};

StringDecoder.prototype.end = function(buffer) {
  var res = '';
  if (buffer && buffer.length)
    res = this.write(buffer);

  if (this.charReceived) {
    var cr = this.charReceived;
    var buf = this.charBuffer;
    var enc = this.encoding;
    res += buf.slice(0, cr).toString(enc);
  }

  return res;
};

function passThroughWrite(buffer) {
  return buffer.toString(this.encoding);
}

function utf16DetectIncompleteChar(buffer) {
  this.charReceived = buffer.length % 2;
  this.charLength = this.charReceived ? 2 : 0;
}

function base64DetectIncompleteChar(buffer) {
  this.charReceived = buffer.length % 3;
  this.charLength = this.charReceived ? 3 : 0;
}

},{"buffer":39}],63:[function(require,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],64:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = require('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = require('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"./support/isBuffer":63,"_process":47,"inherits":44}],"crate-core":[function(require,module,exports){
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var Spray = require('spray-wrtc');
var CausalBroadcast = require('causal-broadcast-definition');
var VVwE = require('version-vector-with-exceptions');
var LSEQTree = require('lseqtree');
var GUID = require('./guid.js');

var MInsertOperation = require('./messages.js').MInsertOperation;
var MAEInsertOperation = require('./messages.js').MAEInsertOperation;
var MRemoveOperation = require('./messages.js').MRemoveOperation;
var MCaretMovedOperation = require('./messages.js').MCaretMovedOperation;

util.inherits(CrateCore, EventEmitter);

/*!
 * \brief link together all components of the model of the CRATE editor
 * \param id the unique site identifier
 * \param options the webrtc specific options 
 */
function CrateCore(id, options){
    EventEmitter.call(this);
    
    this.id = id || GUID();
    this.options = options;
    this.broadcast = new CausalBroadcast(new Spray(this.id, this.options),
                                         new VVwE(this.id));
    this.sequence = new LSEQTree(this.id);

    var self = this;
    // #A regular receive
    this.broadcast.on('receive', function(receivedBroadcastMessage){
        switch (receivedBroadcastMessage.type){
        case 'MRemoveOperation':
            self.remoteRemove(receivedBroadcastMessage.remove);
            break;
        case 'MInsertOperation':
            self.remoteInsert(receivedBroadcastMessage.insert);
            break;
        case 'MCaretMovedOperation':
            self.remoteCaretMoved(receivedBroadcastMessage.caretMoved);
            break;
        };
    });
    // #B anti-entropy for the missing operation
    this.broadcast.on('antiEntropy', function(socket, remoteVVwE, localVVwE){
        var remoteVVwE = (new VVwE(null)).fromJSON(remoteVVwE); // cast
        var toSearch = [];
        // #1 for each entry of our VVwE, look if the remote VVwE knows less
        for (var i=0; i<localVVwE.vector.arr.length; ++i){
            var localEntry = localVVwE.vector.arr[i];
            var index = remoteVVwE.vector.indexOf(localVVwE.vector.arr[i]);
            var start = 1;
            // #A check if the entry exists in the remote vvwe
            if (index >=0){ start = remoteVVwE.vector.arr[index].v + 1; };
            for (var j=start; j<=localEntry.v; ++j){
                // #B check if not one of the local exceptions
                if (localEntry.x.indexOf(j)<0){
                    toSearch.push({_e: localEntry.e, _c: j});
                };
            };
            // #C handle the exceptions of the remote vector
            if (index >=0){
                for (var j=0; j<remoteVVwE.vector.arr[index].x.length;++j){
                    var except = remoteVVwE.vector.arr[index].x[j];
                    if (localEntry.x.indexOf(except)<0 && except<=localEntry.v){
                        toSearch.push({_e: localEntry.e, _c: except});
                    };
                };
            };
        };
        var elements = self.getElements(toSearch);
        //var elements = [];
        // #2 send back the found elements
        self.broadcast.sendAntiEntropyResponse(socket, localVVwE, elements);
    });
};

/*!
 * \brief create the core from an existing object
 * \param object the object to initialize the core model of crate containing a 
 * sequence and causality tracking metadata
 */
CrateCore.prototype.init = function(object){
    // import the sequence and version vector, yet it keeps the identifier of
    // this instance of the core.
    var local = this.broadcast.causality.local;
    this.broadcast.causality.fromJSON(object.causality);
    this.broadcast.causality.local = local;
    this.broadcast.causality.vector.insert(this.broadcast.causality.local);
    
    this.sequence.fromJSON(object.sequence);
    this.sequence._s = local.e;
    this.sequence._c = local.v;
};

/*!
 * \brief local insertion of a character inside the sequence structure. It
 * broadcasts the operation to the rest of the network.
 * \param character the character to insert in the sequence
 * \param index the index in the sequence to insert
 * \return the identifier freshly allocated
 */
CrateCore.prototype.insert = function(character, index){
    var ei = this.sequence.insert(character, index);
    var id = {_e: ei._i._s[ei._i._s.length-1], _c: ei._i._c[ei._i._c.length-1]};
    this.broadcast.send(new MInsertOperation(ei), id, null);
    return ei;
};

/*!
 * \brief local deletion of a character from the sequence structure. It 
 * broadcasts the operation to the rest of the network.
 * \param index the index of the element to remove
 * \return the identifier freshly removed
 */
CrateCore.prototype.remove = function(index){
    var i = this.sequence.remove(index);
    var isReady = {_e: i._s[i._s.length-1], _c: i._c[i._c.length-1]};
    this.sequence._c += 1;
    var id = {_e:this.sequence._s, _c: this.sequence._c } // (TODO) fix uglyness
    this.broadcast.send(new MRemoveOperation(i), id, isReady);
    return i;
};

CrateCore.prototype.caretMoved = function(index){
    var isReady = {
    _e: this.sequence._s,
    _c: this.sequence._c
    };
    this.sequence._c += 1;
    var id = {_e:this.sequence._s, _c: this.sequence._c } // (TODO) fix uglyness
    var param = {
    index: index,
    guid : this.sequence._s
    }
    this.broadcast.send(new MCaretMovedOperation(param), id, isReady);
    console.log("MCaretMovedOperation sended");
    return index;
};

/*!
 * \brief insertion of an element from a remote site. It emits 'remoteInsert' 
 * with the index of the element to insert, -1 if already existing.
 * \param ei the result of the remote insert operation
 */
CrateCore.prototype.remoteInsert = function(ei){
    var index = this.sequence.applyInsert(ei._e, ei._i, false);
    this.emit('remoteInsert',
              ei._e,
              index);
    // (TODO) fix the noIndex thing
    if (ei._i._s){
      this.emit('remoteCaretMoved', ei._i._s[0], index);
    }else{
    // anti-entropy insert message
    this.emit('remoteCaretMoved', ei._i.t.s, index);
    }
};

/*!
 * \brief removal of an element from a remote site.  It emits 'remoteRemove'
 * with the index of the element to remove, -1 if does not exist
 * \param id the result of the remote insert operation
 */
CrateCore.prototype.remoteRemove = function(id){
    var index = this.sequence.applyRemove(id);
    this.emit('remoteRemove', index);
    if (id._i._s){
    this.emit('remoteCaretMoved', id._s[0], index - 1);
    }else{
    // anti-entropy insert message
    this.emit('remoteCaretMoved', id.t.s, index - 1);
    }
};

CrateCore.prototype.remoteCaretMoved = function(param){
    this.emit('remoteCaretMoved', param.guid, param.index);
};


/*!
 * \brief search a set of elements in our sequence and return them
 * \param toSearch the array of elements {_e, _c} to search
 * \returns an array of nodes
 */
CrateCore.prototype.getElements = function(toSearch){
    var result = [], found, node, tempNode, i=this.sequence.length, j=0;
    // (TODO) improve research by exploiting the fact that if a node is
    // missing, all its children are missing too.
    // (TODO) improve the returned representation: either a tree to factorize
    // common parts of the structure or identifiers to get the polylog size
    // (TODO) improve the search by using the fact that toSearch is a sorted
    // array, possibly restructure this argument to be even more efficient
    while (toSearch.length > 0 && i<=this.sequence.length && i>0){
        node = this.sequence.get(i);
        tempNode = node;
        while( tempNode.children.length > 0){
            tempNode = tempNode.children[0];
        };
        j = 0;
        found = false;
        while (j < toSearch.length && !found){
            if (tempNode.t.s === toSearch[j]._e &&
                tempNode.t.c === toSearch[j]._c){
                found = true;
                result.push(new MAEInsertOperation({_e: tempNode.e, _i:node},
                                                   {_e: toSearch[j]._e,
                                                    _c: toSearch[j]._c} ));
                toSearch.splice(j,1);
            } else {
                ++j;
            };
        };
        //        ++i;
        --i;
    };
     return result;
};

module.exports = CrateCore;

},{"./guid.js":1,"./messages.js":2,"causal-broadcast-definition":3,"events":43,"lseqtree":11,"spray-wrtc":21,"util":64,"version-vector-with-exceptions":34}]},{},[])
//# sourceMappingURL=data:application/json;charset:utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXItcGFjay9fcHJlbHVkZS5qcyIsImxpYi9ndWlkLmpzIiwibGliL21lc3NhZ2VzLmpzIiwibm9kZV9tb2R1bGVzL2NhdXNhbC1icm9hZGNhc3QtZGVmaW5pdGlvbi9saWIvY2F1c2FsYnJvYWRjYXN0LmpzIiwibm9kZV9tb2R1bGVzL2NhdXNhbC1icm9hZGNhc3QtZGVmaW5pdGlvbi9saWIvbWVzc2FnZXMuanMiLCJub2RlX21vZHVsZXMvY2F1c2FsLWJyb2FkY2FzdC1kZWZpbml0aW9uL25vZGVfbW9kdWxlcy91bmljYXN0LWRlZmluaXRpb24vbGliL21lc3NhZ2VzLmpzIiwibm9kZV9tb2R1bGVzL2NhdXNhbC1icm9hZGNhc3QtZGVmaW5pdGlvbi9ub2RlX21vZHVsZXMvdW5pY2FzdC1kZWZpbml0aW9uL2xpYi91bmljYXN0LmpzIiwibm9kZV9tb2R1bGVzL2xzZXF0cmVlL2xpYi9iYXNlLmpzIiwibm9kZV9tb2R1bGVzL2xzZXF0cmVlL2xpYi9pZGVudGlmaWVyLmpzIiwibm9kZV9tb2R1bGVzL2xzZXF0cmVlL2xpYi9sc2Vxbm9kZS5qcyIsIm5vZGVfbW9kdWxlcy9sc2VxdHJlZS9saWIvbHNlcXRyZWUuanMiLCJub2RlX21vZHVsZXMvbHNlcXRyZWUvbGliL3N0cmF0ZWd5LmpzIiwibm9kZV9tb2R1bGVzL2xzZXF0cmVlL2xpYi90cmlwbGUuanMiLCJub2RlX21vZHVsZXMvbHNlcXRyZWUvbGliL3V0aWwuanMiLCJub2RlX21vZHVsZXMvbHNlcXRyZWUvbm9kZV9tb2R1bGVzL0JpZ0ludC9zcmMvQmlnSW50LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbGliL2ludmlldy5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL2xpYi9tZXNzYWdlcy5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL2xpYi9wYXJ0aWFsdmlldy5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL2xpYi9zb2NrZXRzLmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbGliL3NwcmF5LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL3NpbXBsZS1wZWVyL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL3NpbXBsZS1wZWVyL25vZGVfbW9kdWxlcy9kZWJ1Zy9icm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL3NpbXBsZS1wZWVyL25vZGVfbW9kdWxlcy9kZWJ1Zy9kZWJ1Zy5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9zaW1wbGUtcGVlci9ub2RlX21vZHVsZXMvZGVidWcvbm9kZV9tb2R1bGVzL21zL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL3NpbXBsZS1wZWVyL25vZGVfbW9kdWxlcy9oYXQvaW5kZXguanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvc2ltcGxlLXBlZXIvbm9kZV9tb2R1bGVzL2luaGVyaXRzL2luaGVyaXRzX2Jyb3dzZXIuanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvc2ltcGxlLXBlZXIvbm9kZV9tb2R1bGVzL2lzLXR5cGVkYXJyYXkvaW5kZXguanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvc2ltcGxlLXBlZXIvbm9kZV9tb2R1bGVzL29uY2Uvbm9kZV9tb2R1bGVzL3dyYXBweS93cmFwcHkuanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvc2ltcGxlLXBlZXIvbm9kZV9tb2R1bGVzL29uY2Uvb25jZS5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9zaW1wbGUtcGVlci9ub2RlX21vZHVsZXMvdHlwZWRhcnJheS10by1idWZmZXIvaW5kZXguanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvc29ydGVkLWNtcC1hcnJheS9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9zb3J0ZWQtY21wLWFycmF5L25vZGVfbW9kdWxlcy9iaW5hcnktc2VhcmNoL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3ZlcnNpb24tdmVjdG9yLXdpdGgtZXhjZXB0aW9ucy9saWIvdnZ3ZS5qcyIsIm5vZGVfbW9kdWxlcy92ZXJzaW9uLXZlY3Rvci13aXRoLWV4Y2VwdGlvbnMvbGliL3Z2d2VlbnRyeS5qcyIsIi4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXItcmVzb2x2ZS9lbXB0eS5qcyIsIi4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2J1ZmZlci9pbmRleC5qcyIsIi4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2J1ZmZlci9ub2RlX21vZHVsZXMvYmFzZTY0LWpzL2xpYi9iNjQuanMiLCIuLi8uLi8uLi8uLi91c3IvbG9jYWwvbGliL25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9idWZmZXIvbm9kZV9tb2R1bGVzL2llZWU3NTQvaW5kZXguanMiLCIuLi8uLi8uLi8uLi91c3IvbG9jYWwvbGliL25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9idWZmZXIvbm9kZV9tb2R1bGVzL2lzLWFycmF5L2luZGV4LmpzIiwiLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvZXZlbnRzL2V2ZW50cy5qcyIsIi4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2luc2VydC1tb2R1bGUtZ2xvYmFscy9ub2RlX21vZHVsZXMvaXMtYnVmZmVyL2luZGV4LmpzIiwiLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvaXNhcnJheS9pbmRleC5qcyIsIi4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3Byb2Nlc3MvYnJvd3Nlci5qcyIsIi4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3JlYWRhYmxlLXN0cmVhbS9kdXBsZXguanMiLCIuLi8uLi8uLi8uLi91c3IvbG9jYWwvbGliL25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9yZWFkYWJsZS1zdHJlYW0vbGliL19zdHJlYW1fZHVwbGV4LmpzIiwiLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvcmVhZGFibGUtc3RyZWFtL2xpYi9fc3RyZWFtX3Bhc3N0aHJvdWdoLmpzIiwiLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvcmVhZGFibGUtc3RyZWFtL2xpYi9fc3RyZWFtX3JlYWRhYmxlLmpzIiwiLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvcmVhZGFibGUtc3RyZWFtL2xpYi9fc3RyZWFtX3RyYW5zZm9ybS5qcyIsIi4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3JlYWRhYmxlLXN0cmVhbS9saWIvX3N0cmVhbV93cml0YWJsZS5qcyIsIi4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3JlYWRhYmxlLXN0cmVhbS9ub2RlX21vZHVsZXMvY29yZS11dGlsLWlzL2xpYi91dGlsLmpzIiwiLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvcmVhZGFibGUtc3RyZWFtL25vZGVfbW9kdWxlcy9wcm9jZXNzLW5leHRpY2stYXJncy9pbmRleC5qcyIsIi4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3JlYWRhYmxlLXN0cmVhbS9ub2RlX21vZHVsZXMvdXRpbC1kZXByZWNhdGUvYnJvd3Nlci5qcyIsIi4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3JlYWRhYmxlLXN0cmVhbS9wYXNzdGhyb3VnaC5qcyIsIi4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3JlYWRhYmxlLXN0cmVhbS9yZWFkYWJsZS5qcyIsIi4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3JlYWRhYmxlLXN0cmVhbS90cmFuc2Zvcm0uanMiLCIuLi8uLi8uLi8uLi91c3IvbG9jYWwvbGliL25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9yZWFkYWJsZS1zdHJlYW0vd3JpdGFibGUuanMiLCIuLi8uLi8uLi8uLi91c3IvbG9jYWwvbGliL25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9zdHJlYW0tYnJvd3NlcmlmeS9pbmRleC5qcyIsIi4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3N0cmluZ19kZWNvZGVyL2luZGV4LmpzIiwiLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvdXRpbC9zdXBwb3J0L2lzQnVmZmVyQnJvd3Nlci5qcyIsIi4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3V0aWwvdXRpbC5qcyIsImxpYi9jcmF0ZS1jb3JlLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDdk5BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNYQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3RUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdPQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbkxBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4SkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQzdnREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDekRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BOQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUMxb0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDamdCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4S0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JNQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDekNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDckJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUMvQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25DQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7OztBQzlEQTs7O0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDeGdEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwRkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDakNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUM3U0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pCQTtBQUNBO0FBQ0E7QUFDQTs7QUNIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNGQTtBQUNBOztBQ0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbEZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUMzQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDLzdCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDck1BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ3hnQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7QUMxR0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7QUNiQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDbkVBO0FBQ0E7O0FDREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDWkE7QUFDQTs7QUNEQTtBQUNBOztBQ0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3TkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDMWtCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCIvKlxuICogXFx1cmwgaHR0cHM6Ly9naXRodWIuY29tL2p1c3RheWFrL3l1dGlscy9ibG9iL21hc3Rlci95dXRpbHMuanNcbiAqIFxcYXV0aG9yIGp1c3RheWFrXG4gKi9cblxuLyohXG4gKiBcXGJyaWVmIGdldCBhIGdsb2JhbGx5IHVuaXF1ZSAod2l0aCBoaWdoIHByb2JhYmlsaXR5KSBpZGVudGlmaWVyXG4gKiBcXHJldHVybiBhIHN0cmluZyBiZWluZyB0aGUgaWRlbnRpZmllclxuICovXG5mdW5jdGlvbiBHVUlEKCl7XG4gICAgdmFyIGQgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKTtcbiAgICB2YXIgZ3VpZCA9ICd4eHh4eHh4eC14eHh4LTR4eHgteXh4eC14eHh4eHh4eHh4eHgnLnJlcGxhY2UoL1t4eV0vZywgZnVuY3Rpb24gKGMpIHtcbiAgICAgICAgdmFyIHIgPSAoZCArIE1hdGgucmFuZG9tKCkgKiAxNikgJSAxNiB8IDA7XG4gICAgICAgIGQgPSBNYXRoLmZsb29yKGQgLyAxNik7XG4gICAgICAgIHJldHVybiAoYyA9PT0gJ3gnID8gciA6IChyICYgMHgzIHwgMHg4KSkudG9TdHJpbmcoMTYpO1xuICAgIH0pO1xuICAgIHJldHVybiBndWlkO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBHVUlEO1xuIiwiLyohXG4gKiBcXGJyaWVmIG9iamVjdCB0aGF0IHJlcHJlc2VudHMgdGhlIHJlc3VsdCBvZiBhbiBpbnNlcnQgb3BlcmF0aW9uXG4gKiBcXHBhcmFtIGluc2VydCB0aGUgcmVzdWx0IG9mIHRoZSBsb2NhbCBpbnNlcnQgb3BlcmF0aW9uXG4gKi9cbmZ1bmN0aW9uIE1JbnNlcnRPcGVyYXRpb24oaW5zZXJ0KXtcbiAgICB0aGlzLnR5cGUgPSBcIk1JbnNlcnRPcGVyYXRpb25cIjtcbiAgICB0aGlzLmluc2VydCA9IGluc2VydDtcbn07XG5tb2R1bGUuZXhwb3J0cy5NSW5zZXJ0T3BlcmF0aW9uID0gTUluc2VydE9wZXJhdGlvbjtcblxuZnVuY3Rpb24gTUFFSW5zZXJ0T3BlcmF0aW9uKGluc2VydCwgaWQpe1xuICAgIHRoaXMudHlwZSA9IFwiTUFFSW5zZXJ0T3BlcmF0aW9uXCI7XG4gICAgdGhpcy5wYXlsb2FkID0gbmV3IE1JbnNlcnRPcGVyYXRpb24oaW5zZXJ0KTtcbiAgICB0aGlzLmlkID0gaWQ7XG4gICAgdGhpcy5pc1JlYWR5ID0gbnVsbDtcbn07XG5tb2R1bGUuZXhwb3J0cy5NQUVJbnNlcnRPcGVyYXRpb24gPSBNQUVJbnNlcnRPcGVyYXRpb247XG5cbi8qIVxuICogXFxicmllZiBvYmplY3QgdGhhdCByZXByZXNlbnRzIHRoZSByZXN1bHQgb2YgYSBkZWxldGUgb3BlcmF0aW9uXG4gKiBcXHBhcmFtIHJlbW92ZSB0aGUgcmVzdWx0IG9mIHRoZSBsb2NhbCBkZWxldGUgb3BlcmF0aW9uXG4gKi9cbmZ1bmN0aW9uIE1SZW1vdmVPcGVyYXRpb24ocmVtb3ZlKXtcbiAgICB0aGlzLnR5cGUgPSBcIk1SZW1vdmVPcGVyYXRpb25cIjtcbiAgICB0aGlzLnJlbW92ZSA9IHJlbW92ZTtcbn07XG5tb2R1bGUuZXhwb3J0cy5NUmVtb3ZlT3BlcmF0aW9uID0gTVJlbW92ZU9wZXJhdGlvbjtcblxuLyohXG4gKiBcXGJyaWVmIG9iamVjdCB0aGF0IHJlcHJlc2VudHMgdGhlIHJlc3VsdCBvZiBhIGNhcmV0TW92ZWQgT3BlcmF0aW9uXG4gKiBcXHBhcmFtIHJlbW92ZSB0aGUgcmVzdWx0IG9mIHRoZSBsb2NhbCBjYXJldE1vdmVkIE9wZXJhdGlvblxuICovXG5mdW5jdGlvbiBNQ2FyZXRNb3ZlZE9wZXJhdGlvbihjYXJldE1vdmVkKXtcbiAgICB0aGlzLnR5cGUgPSBcIk1DYXJldE1vdmVkT3BlcmF0aW9uXCI7XG4gICAgdGhpcy5jYXJldE1vdmVkID0gY2FyZXRNb3ZlZDtcbn07XG5tb2R1bGUuZXhwb3J0cy5NQ2FyZXRNb3ZlZE9wZXJhdGlvbiA9IE1DYXJldE1vdmVkT3BlcmF0aW9uOyIsInZhciBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKS5FdmVudEVtaXR0ZXI7XG52YXIgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcbnZhciBHVUlEID0gcmVxdWlyZSgnLi9ndWlkLmpzJyk7XG5cbnZhciBNQnJvYWRjYXN0ID0gcmVxdWlyZSgnLi9tZXNzYWdlcycpLk1Ccm9hZGNhc3Q7XG52YXIgTUFudGlFbnRyb3B5UmVxdWVzdCA9IHJlcXVpcmUoJy4vbWVzc2FnZXMuanMnKS5NQW50aUVudHJvcHlSZXF1ZXN0O1xudmFyIE1BbnRpRW50cm9weVJlc3BvbnNlID0gcmVxdWlyZSgnLi9tZXNzYWdlcy5qcycpLk1BbnRpRW50cm9weVJlc3BvbnNlO1xuXG52YXIgVW5pY2FzdCA9IHJlcXVpcmUoJ3VuaWNhc3QtZGVmaW5pdGlvbicpO1xuXG51dGlsLmluaGVyaXRzKENhdXNhbEJyb2FkY2FzdCwgRXZlbnRFbWl0dGVyKTtcblxuLyohXG4gKiBJdCB0YWtlcyBhIHVuaXF1ZSB2YWx1ZSBmb3IgcGVlciBhbmQgYSBjb3VudGVyIHRvIGRpc3Rpbmd1aXNoIGEgbWVzc2FnZS4gSXRcbiAqIGVtaXRzICdyZWNlaXZlJyBldmVudCB3aGVuIHRoZSBtZXNzYWdlIGlzIGNvbnNpZGVyZWQgcmVhZHlcbiAqIFxccGFyYW0gc291cmNlIHRoZSBwcm90b2NvbCByZWNlaXZpbmcgdGhlIG1lc3NhZ2VzXG4gKiBcXHBhcmFtIGNhdXNhbGl0eSB0aGUgY2F1c2FsaXR5IHRyYWNraW5nIHN0cnVjdHVyZVxuICovXG5mdW5jdGlvbiBDYXVzYWxCcm9hZGNhc3Qoc291cmNlLCBjYXVzYWxpdHksIG5hbWUpIHtcbiAgICBFdmVudEVtaXR0ZXIuY2FsbCh0aGlzKTtcbiAgICB0aGlzLm5hbWUgPSBuYW1lIHx8ICdjYXVzYWwnO1xuICAgIHRoaXMuc291cmNlID0gc291cmNlO1xuICAgIHRoaXMuY2F1c2FsaXR5ID0gY2F1c2FsaXR5O1xuICAgIHRoaXMuZGVsdGFBbnRpRW50cm9weSA9IDEwMDAqNjAqMS8yOyAvLyAoVE9ETykgY29uZmlndXJhYmxlIChjdXJyZW50bHkgMzBzKVxuICAgIHRoaXMudW5pY2FzdCA9IG5ldyBVbmljYXN0KHRoaXMuc291cmNlLCB0aGlzLm5hbWUrJy11bmljYXN0Jyk7XG5cbiAgICAvLyBidWZmZXIgb2Ygb3BlcmF0aW9uc1xuICAgIHRoaXMuYnVmZmVyID0gW107IFxuICAgIC8vIGJ1ZmZlciBvZiBhbnRpLWVudHJvcHkgbWVzc2FnZXMgKGNodW5raWZpZWQgYmVjYXVzZSBvZiBsYXJnZSBzaXplKVxuICAgIHRoaXMuYnVmZmVyQW50aUVudHJvcHkgPSBuZXcgTUFudGlFbnRyb3B5UmVzcG9uc2UoJ2luaXQnKTtcbiAgICBcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgdGhpcy5zb3VyY2Uub24oc2VsZi5uYW1lKyctYnJvYWRjYXN0LXJlY2VpdmUnLCBmdW5jdGlvbihzb2NrZXQsIG1lc3NhZ2Upe1xuICAgICAgICBzZWxmLnJlY2VpdmVCcm9hZGNhc3QobWVzc2FnZSk7XG4gICAgfSk7XG4gICAgdGhpcy51bmljYXN0Lm9uKCdyZWNlaXZlJywgZnVuY3Rpb24oc29ja2V0LCBtZXNzYWdlKXtcbiAgICAgICAgc2VsZi5yZWNlaXZlVW5pY2FzdChzb2NrZXQsIG1lc3NhZ2UpO1xuICAgIH0pO1xuICAgIHRoaXMuc291cmNlLm9uKCdzdGF0ZWNoYW5nZScsIGZ1bmN0aW9uKHN0YXRlKXtcbiAgICAgICAgaWYgKHN0YXRlPT09J2Nvbm5lY3QnKXtcbiAgICAgICAgICAgIHNlbGYudW5pY2FzdC5zZW5kKG5ldyBNQW50aUVudHJvcHlSZXF1ZXN0KHNlbGYuY2F1c2FsaXR5KSk7XG4gICAgICAgIH07XG4gICAgfSk7XG4gICAgc2V0SW50ZXJ2YWwoZnVuY3Rpb24oKXtcbiAgICAgICAgc2VsZi51bmljYXN0LnNlbmQobmV3IE1BbnRpRW50cm9weVJlcXVlc3Qoc2VsZi5jYXVzYWxpdHkpKTtcbiAgICB9LCBzZWxmLmRlbHRhQW50aUVudHJvcHkpOyAgICBcbn07XG5cbi8qIVxuICogXFxicmllZiBicm9hZGNhc3QgdGhlIG1lc3NhZ2UgdG8gYWxsIHBhcnRpY2lwYW50c1xuICogXFxwYXJhbSBtZXNzYWdlIHRoZSBtZXNzYWdlIHRvIGJyb2FkY2FzdFxuICogXFxwYXJhbSBpZCB0aGUgaWQgb2YgdGhlIG1lc3NhZ2VcbiAqIFxccGFyYW0gaXNSZWFkeSB0aGUgaWQocykgdGhhdCBtdXN0IGV4aXN0IHRvIGRlbGl2ZXIgdGhlIG1lc3NhZ2VcbiAqL1xuQ2F1c2FsQnJvYWRjYXN0LnByb3RvdHlwZS5zZW5kID0gZnVuY3Rpb24obWVzc2FnZSwgaWQsIGlzUmVhZHkpe1xuICAgIC8vICMxIGdldCB0aGUgbmVpZ2hib3Job29kIGFuZCBjcmVhdGUgdGhlIG1lc3NhZ2VcbiAgICB2YXIgbGlua3MgPSB0aGlzLnNvdXJjZS5nZXRQZWVycyhOdW1iZXIuTUFYX1ZBTFVFKTtcbiAgICB2YXIgbUJyb2FkY2FzdCA9IG5ldyBNQnJvYWRjYXN0KHRoaXMubmFtZSwgaWQgfHwgR1VJRCgpLCBpc1JlYWR5LCBtZXNzYWdlKTtcbiAgICAvLyAjMiByZWdpc3RlciB0aGUgbWVzc2FnZSBpbiB0aGUgc3RydWN0dXJlXG4gICAgdGhpcy5jYXVzYWxpdHkuaW5jcmVtZW50RnJvbShpZCk7XG4gICAgLy8gIzMgc2VuZCB0aGUgbWVzc2FnZSB0byB0aGUgbmVpZ2hib3Job29kXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsaW5rcy5sZW5ndGg7ICsraSl7XG4gICAgICAgIGlmIChsaW5rc1tpXS5jb25uZWN0ZWQgJiZcbiAgICAgICAgICAgIGxpbmtzW2ldLl9jaGFubmVsICYmIGxpbmtzW2ldLl9jaGFubmVsLnJlYWR5U3RhdGU9PT0nb3Blbicpe1xuICAgICAgICAgICAgbGlua3NbaV0uc2VuZChtQnJvYWRjYXN0KTtcbiAgICAgICAgfTtcbiAgICB9O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGFuc3dlcnMgdG8gYW4gYW50aWVudHJvcHkgcmVxdWVzdCBtZXNzYWdlIHdpdGggdGhlIG1pc3NpbmcgZWxlbWVudHNcbiAqIFxccGFyYW0gc29ja2V0IHRoZSBvcmlnaW4gb2YgdGhlIHJlcXVlc3RcbiAqIFxccGFyYW0gY2F1c2FsaXR5QXRSZWNlaXB0IHRoZSBsb2NhbCBjYXVzYWxpdHkgc3RydWN0dXJlIHdoZW4gdGhlIG1lc3NhZ2Ugd2FzXG4gKiByZWNlaXZlZFxuICogXFxwYXJhbSBtZXNzYWdlcyB0aGUgbWlzc2luZyBtZXNzYWdlc1xuICovIFxuQ2F1c2FsQnJvYWRjYXN0LnByb3RvdHlwZS5zZW5kQW50aUVudHJvcHlSZXNwb25zZSA9XG4gICAgZnVuY3Rpb24oc29ja2V0LCBjYXVzYWxpdHlBdFJlY2VpcHQsIG1lc3NhZ2VzKXtcbiAgICAgICAgdmFyIGlkID0gR1VJRCgpO1xuICAgICAgICAvLyAjMSBtZXRhZGF0YSBvZiB0aGUgYW50aWVudHJvcHkgcmVzcG9uc2VcbiAgICAgICAgdGhpcy51bmljYXN0LnNlbmQobmV3IE1BbnRpRW50cm9weVJlc3BvbnNlKGlkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2F1c2FsaXR5QXRSZWNlaXB0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbWVzc2FnZXMubGVuZ3RoKSwgc29ja2V0KTtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBtZXNzYWdlcy5sZW5ndGg7ICsraSl7XG4gICAgICAgICAgICB0aGlzLnVuaWNhc3Quc2VuZChuZXcgTUFudGlFbnRyb3B5UmVzcG9uc2UoaWQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbnVsbCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXNzYWdlcy5sZW5ndGgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbWVzc2FnZXNbaV0pLCAgc29ja2V0KTtcbiAgICAgICAgfTtcbiAgICB9O1xuXG4vKiFcbiAqIFxcYnJpZWYgcmVjZWl2ZSBhIGJyb2FkY2FzdCBtZXNzYWdlXG4gKiBcXHBhcmFtIG1lc3NhZ2UgdGhlIHJlY2VpdmVkIG1lc3NhZ2VcbiAqL1xuQ2F1c2FsQnJvYWRjYXN0LnByb3RvdHlwZS5yZWNlaXZlQnJvYWRjYXN0ID0gZnVuY3Rpb24obWVzc2FnZSl7XG4gICAgdmFyIGlkID0gbWVzc2FnZS5pZCxcbiAgICAgICAgaXNSZWFkeSA9IG1lc3NhZ2UuaXNSZWFkeTtcblxuICAgIGlmICghdGhpcy5zdG9wUHJvcGFnYXRpb24obWVzc2FnZSkpe1xuICAgICAgICAvLyAjMSByZWdpc3RlciB0aGUgb3BlcmF0aW9uXG4gICAgICAgIHRoaXMuYnVmZmVyLnB1c2gobWVzc2FnZSk7XG4gICAgICAgIC8vICMyIGRlbGl2ZXJcbiAgICAgICAgdGhpcy5yZXZpZXdCdWZmZXIoKTtcbiAgICAgICAgLy8gIzMgcmVicm9hZGNhc3RcbiAgICAgICAgdmFyIGxpbmtzID0gdGhpcy5zb3VyY2UuZ2V0UGVlcnMoTnVtYmVyLk1BWF9WQUxVRSk7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGlua3MubGVuZ3RoOyArK2kpe1xuICAgICAgICAgICAgaWYgKGxpbmtzW2ldLmNvbm5lY3RlZCAmJlxuICAgICAgICAgICAgICAgIGxpbmtzW2ldLl9jaGFubmVsICYmIGxpbmtzW2ldLl9jaGFubmVsLnJlYWR5U3RhdGU9PT0nb3Blbicpe1xuICAgICAgICAgICAgICAgIGxpbmtzW2ldLnNlbmQobWVzc2FnZSk7XG4gICAgICAgICAgICB9O1xuICAgICAgICB9O1xuICAgIH07XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZ28gdGhyb3VnaCB0aGUgYnVmZmVyIG9mIG1lc3NhZ2VzIGFuZCBkZWxpdmVycyBhbGxcbiAqIHJlYWR5IG9wZXJhdGlvbnNcbiAqL1xuQ2F1c2FsQnJvYWRjYXN0LnByb3RvdHlwZS5yZXZpZXdCdWZmZXIgPSBmdW5jdGlvbigpe1xuICAgIHZhciBmb3VuZCA9IGZhbHNlLFxuICAgICAgICBpID0gdGhpcy5idWZmZXIubGVuZ3RoIC0gMTtcbiAgICB3aGlsZShpPj0wKXtcbiAgICAgICAgdmFyIG1lc3NhZ2UgPSB0aGlzLmJ1ZmZlcltpXTtcbiAgICAgICAgaWYgKHRoaXMuY2F1c2FsaXR5LmlzTG93ZXIobWVzc2FnZS5pZCkpe1xuICAgICAgICAgICAgdGhpcy5idWZmZXIuc3BsaWNlKGksIDEpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKHRoaXMuY2F1c2FsaXR5LmlzUmVhZHkobWVzc2FnZS5pc1JlYWR5KSl7XG4gICAgICAgICAgICAgICAgZm91bmQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHRoaXMuY2F1c2FsaXR5LmluY3JlbWVudEZyb20obWVzc2FnZS5pZCk7XG4gICAgICAgICAgICAgICAgdGhpcy5idWZmZXIuc3BsaWNlKGksIDEpO1xuICAgICAgICAgICAgICAgIHRoaXMuZW1pdCgncmVjZWl2ZScsIG1lc3NhZ2UucGF5bG9hZCk7XG4gICAgICAgICAgICB9O1xuICAgICAgICB9O1xuICAgICAgICAtLWk7XG4gICAgfTtcbiAgICBpZiAoZm91bmQpeyB0aGlzLnJldmlld0J1ZmZlcigpOyAgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiByZWNlaXZlIGEgdW5pY2FzdCBtZXNzYWdlLCBpLmUuLCBlaXRoZXIgYW4gYW50aWVudHJvcHkgcmVxdWVzdCBvciBhblxuICogYW50aWVudHJvcHkgcmVzcG9uc2VcbiAqIFxcYnJpZWYgc29ja2V0IHRoZSBvcmlnaW4gb2YgdGhlIG1lc3NhZ2VcbiAqIFxcYnJpZWYgbWVzc2FnZSB0aGUgbWVzc2FnZSByZWNlaXZlZCBcbiAqL1xuQ2F1c2FsQnJvYWRjYXN0LnByb3RvdHlwZS5yZWNlaXZlVW5pY2FzdCA9IGZ1bmN0aW9uKHNvY2tldCwgbWVzc2FnZSl7XG4gICAgc3dpdGNoIChtZXNzYWdlLnR5cGUpe1xuICAgIGNhc2UgJ01BbnRpRW50cm9weVJlcXVlc3QnOlxuICAgICAgICB0aGlzLmVtaXQoJ2FudGlFbnRyb3B5JyxcbiAgICAgICAgICAgICAgICAgIHNvY2tldCwgbWVzc2FnZS5jYXVzYWxpdHksIHRoaXMuY2F1c2FsaXR5LmNsb25lKCkpO1xuICAgICAgICBicmVhaztcbiAgICBjYXNlICdNQW50aUVudHJvcHlSZXNwb25zZSc6XG4gICAgICAgIC8vICNBIHJlcGxhY2UgdGhlIGJ1ZmZlcmVkIG1lc3NhZ2VcbiAgICAgICAgaWYgKHRoaXMuYnVmZmVyQW50aUVudHJvcHkuaWQgIT09IG1lc3NhZ2UuaWQpe1xuICAgICAgICAgICAgdGhpcy5idWZmZXJBbnRpRW50cm9weSA9IG1lc3NhZ2U7XG4gICAgICAgIH07XG4gICAgICAgIC8vICNCIGFkZCB0aGUgbmV3IGVsZW1lbnQgdG8gdGhlIGJ1ZmZlciAgICAgICAgXG4gICAgICAgIGlmIChtZXNzYWdlLmVsZW1lbnQpe1xuICAgICAgICAgICAgdGhpcy5idWZmZXJBbnRpRW50cm9weS5lbGVtZW50cy5wdXNoKG1lc3NhZ2UuZWxlbWVudCk7XG4gICAgICAgIH07XG4gICAgICAgIC8vICNDIGFkZCBjYXVzYWxpdHkgbWV0YWRhdGFcbiAgICAgICAgaWYgKG1lc3NhZ2UuY2F1c2FsaXR5KXtcbiAgICAgICAgICAgIHRoaXMuYnVmZmVyQW50aUVudHJvcHkuY2F1c2FsaXR5ID0gbWVzc2FnZS5jYXVzYWxpdHk7XG4gICAgICAgIH07XG4gICAgICAgIC8vICNEIHRoZSBidWZmZXJlZCBtZXNzYWdlIGlzIGZ1bGx5IGFycml2ZWQsIGRlbGl2ZXJcbiAgICAgICAgaWYgKHRoaXMuYnVmZmVyQW50aUVudHJvcHkuZWxlbWVudHMubGVuZ3RoID09PVxuICAgICAgICAgICAgdGhpcy5idWZmZXJBbnRpRW50cm9weS5uYkVsZW1lbnRzKXtcbiAgICAgICAgICAgIC8vICMxIGNvbnNpZGVyZSBlYWNoIG1lc3NhZ2UgaW4gdGhlIHJlc3BvbnNlIGluZGVwZW5kYW50bHlcbiAgICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpPHRoaXMuYnVmZmVyQW50aUVudHJvcHkuZWxlbWVudHMubGVuZ3RoOyArK2kpe1xuICAgICAgICAgICAgICAgIHZhciBlbGVtZW50ID0gdGhpcy5idWZmZXJBbnRpRW50cm9weS5lbGVtZW50c1tpXTtcbiAgICAgICAgICAgICAgICAvLyAjMiBvbmx5IGNoZWNrIGlmIHRoZSBtZXNzYWdlIGhhcyBub3QgYmVlbiByZWNlaXZlZCB5ZXRcbiAgICAgICAgICAgICAgICBpZiAoIXRoaXMuc3RvcFByb3BhZ2F0aW9uKGVsZW1lbnQpKXtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5jYXVzYWxpdHkuaW5jcmVtZW50RnJvbShlbGVtZW50LmlkKTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5lbWl0KCdyZWNlaXZlJywgZWxlbWVudC5wYXlsb2FkKTtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIC8vICMzIG1lcmdlIGNhdXNhbGl0eSBzdHJ1Y3R1cmVzXG4gICAgICAgICAgICB0aGlzLmNhdXNhbGl0eS5tZXJnZSh0aGlzLmJ1ZmZlckFudGlFbnRyb3B5LmNhdXNhbGl0eSk7XG4gICAgICAgIH07XG4gICAgICAgIGJyZWFrO1xuICAgIH07XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0cyBjYWxsZWQgd2hlbiBhIGJyb2FkY2FzdCBtZXNzYWdlIHJlYWNoZXMgdGhpcyBub2RlLiAgdGhpc1xuICogZnVuY3Rpb24gZXZhbHVhdGVzIGlmIHRoZSBub2RlIHNob3VsZCBwcm9wYWdhdGUgdGhlIG1lc3NhZ2UgZnVydGhlciBvciBpZiBpdFxuICogc2hvdWxkIHN0b3Agc2VuZGluZyBpdC5cbiAqIFxccGFyYW0gbWVzc2FnZSBhIGJyb2FkY2FzdCBtZXNzYWdlXG4gKiBcXHJldHVybiB0cnVlIGlmIHRoZSBtZXNzYWdlIGlzIGFscmVhZHkga25vd24sIGZhbHNlIG90aGVyd2lzZVxuICovXG5DYXVzYWxCcm9hZGNhc3QucHJvdG90eXBlLnN0b3BQcm9wYWdhdGlvbiA9IGZ1bmN0aW9uIChtZXNzYWdlKSB7XG4gICAgcmV0dXJuIHRoaXMuY2F1c2FsaXR5LmlzTG93ZXIobWVzc2FnZS5pZCkgfHxcbiAgICAgICAgdGhpcy5idWZmZXJJbmRleE9mKG1lc3NhZ2UuaWQpPj0wO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGdldCB0aGUgaW5kZXggaW4gdGhlIGJ1ZmZlciBvZiB0aGUgbWVzc2FnZSBpZGVudGlmaWVkIGJ5IGlkXG4gKiBcXHBhcmFtIGlkIHRoZSBpZGVudGlmaWVyIHRvIHNlYXJjaFxuICogXFxyZXR1cm4gdGhlIGluZGV4IG9mIHRoZSBtZXNzYWdlIGluIHRoZSBidWZmZXIsIC0xIGlmIG5vdCBmb3VuZFxuICovXG5DYXVzYWxCcm9hZGNhc3QucHJvdG90eXBlLmJ1ZmZlckluZGV4T2YgPSBmdW5jdGlvbihpZCl7XG4gICAgdmFyIGZvdW5kID0gZmFsc2UsXG4gICAgICAgIGluZGV4ID0gLTEsXG4gICAgICAgIGkgPSAwO1xuICAgIHdoaWxlICghZm91bmQgJiYgaTx0aGlzLmJ1ZmZlci5sZW5ndGgpe1xuICAgICAgICAvLyAoVE9ETykgZml4IHVnbHluZXNzXG4gICAgICAgIGlmIChKU09OLnN0cmluZ2lmeSh0aGlzLmJ1ZmZlcltpXS5pZCkgPT09IEpTT04uc3RyaW5naWZ5KGlkKSl7IFxuICAgICAgICAgICAgZm91bmQgPSB0cnVlOyBpbmRleCA9IGk7XG4gICAgICAgIH07XG4gICAgICAgICsraVxuICAgIH07XG4gICAgcmV0dXJuIGluZGV4O1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBDYXVzYWxCcm9hZGNhc3Q7XG4iLCJcbi8qIVxuICogXFxicmllZiBtZXNzYWdlIGNvbnRhaW5pbmcgZGF0YSB0byBicm9hZGNhc3RcbiAqIFxccGFyYW0gbmFtZSB0aGUgbmFtZSBvZiB0aGUgcHJvdG9jb2wsIGRlZmF1bHQgJ2NhdXNhbCdcbiAqIFxccGFyYW0gaWQgdGhlIGlkZW50aWZpZXIgb2YgdGhlIGJyb2FkY2FzdCBtZXNzYWdlXG4gKiBcXHBhcmFtIGlzUmVhZHkgdGhlIGlkZW50aWZpZXIocykgdGhhdCBtdXN0IGV4aXN0IHRvIGRlbGl2ZXIgdGhpcyBtZXNzYWdlXG4gKiBcXHBhcmFtIHBheWxvYWQgdGhlIGJyb2FkY2FzdGVkIGRhdGFcbiAqL1xuZnVuY3Rpb24gTUJyb2FkY2FzdChuYW1lLCBpZCwgaXNSZWFkeSwgcGF5bG9hZCl7XG4gICAgdGhpcy5wcm90b2NvbCA9IChuYW1lICYmIG5hbWUrJy1icm9hZGNhc3QnKSB8fCAnY2F1c2FsLWJyb2FkY2FzdCc7XG4gICAgdGhpcy5pZCA9IGlkO1xuICAgIHRoaXMuaXNSZWFkeSA9IGlzUmVhZHk7XG4gICAgdGhpcy5wYXlsb2FkID0gcGF5bG9hZDtcbn07XG5tb2R1bGUuZXhwb3J0cy5NQnJvYWRjYXN0ID0gTUJyb2FkY2FzdDtcblxuLyohXG4gKiBcXGJyaWVmIG1lc3NhZ2UgdGhhdCByZXF1ZXN0IGFuIEFudGlFbnRyb3B5IFxuICogXFxwYXJhbSBjYXVzYWxpdHkgdGhlIGNhdXNhbGl0eSBzdHJ1Y3R1cmVcbiAqL1xuZnVuY3Rpb24gTUFudGlFbnRyb3B5UmVxdWVzdChjYXVzYWxpdHkpe1xuICAgIHRoaXMudHlwZSA9ICdNQW50aUVudHJvcHlSZXF1ZXN0JztcbiAgICB0aGlzLmNhdXNhbGl0eSA9IGNhdXNhbGl0eTtcbn07XG5tb2R1bGUuZXhwb3J0cy5NQW50aUVudHJvcHlSZXF1ZXN0ID0gTUFudGlFbnRyb3B5UmVxdWVzdDtcblxuLyohXG4gKiBcXGJyaWVmIG1lc3NhZ2UgcmVzcG9uZGluZyB0byB0aGUgQW50aUVudHJvcHkgcmVxdWVzdFxuICogXFxwYXJhbSBpZCB0aGUgaWRlbnRpZmllciBvZiB0aGUgcmVzcG9uc2UgbWVzc2FnZVxuICogXFxwYXJhbSBjYXVzYWxpdHkgdGhlIGNhdXNhbGl0eSBzdHJ1Y3R1cmVcbiAqIFxccGFyYW0gbmJFbGVtZW50cyB0aGUgbnVtYmVyIG9mIGVsZW1lbnQgdG8gc2VuZFxuICogXFxwYXJhbSBlbGVtZW50IGVhY2ggZWxlbWVudCB0byBzZW5kIFxuICovXG5mdW5jdGlvbiBNQW50aUVudHJvcHlSZXNwb25zZShpZCwgY2F1c2FsaXR5LCBuYkVsZW1lbnRzLCBlbGVtZW50KXtcbiAgICB0aGlzLnR5cGUgPSAnTUFudGlFbnRyb3B5UmVzcG9uc2UnO1xuICAgIHRoaXMuaWQgPSBpZDtcbiAgICB0aGlzLmNhdXNhbGl0eSA9IGNhdXNhbGl0eTtcbiAgICB0aGlzLm5iRWxlbWVudHMgPSBuYkVsZW1lbnRzO1xuICAgIHRoaXMuZWxlbWVudCA9IGVsZW1lbnQ7XG4gICAgdGhpcy5lbGVtZW50cyA9IFtdO1xufTtcbm1vZHVsZS5leHBvcnRzLk1BbnRpRW50cm9weVJlc3BvbnNlID0gTUFudGlFbnRyb3B5UmVzcG9uc2U7XG5cbiIsIlxuLyohXG4gKiBcXGJyaWVmIG1lc3NhZ2UgY29udGFpbmluZyBkYXRhIHRvIHVuaWNhc3RcbiAqIFxccGFyYW0gbmFtZSB0aGUgcHJvdG9jb2wgbmFtZVxuICogXFxwYXJhbSBwYXlsb2FkIHRoZSBzZW50IGRhdGFcbiAqL1xuZnVuY3Rpb24gTVVuaWNhc3QobmFtZSwgcGF5bG9hZCl7XG4gICAgdGhpcy5wcm90b2NvbCA9IG5hbWUgfHwgJ3VuaWNhc3QnO1xuICAgIHRoaXMucGF5bG9hZCA9IHBheWxvYWQ7XG59O1xubW9kdWxlLmV4cG9ydHMuTVVuaWNhc3QgPSBNVW5pY2FzdDtcbiIsInZhciBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKS5FdmVudEVtaXR0ZXI7XG52YXIgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcblxudmFyIE1VbmljYXN0ID0gcmVxdWlyZSgnLi9tZXNzYWdlcycpLk1VbmljYXN0O1xuXG51dGlsLmluaGVyaXRzKFVuaWNhc3QsIEV2ZW50RW1pdHRlcik7XG5cbi8qIVxuICogVW5pY2FzdCBjb21wb25lbnQgdGhhdCBzaW1wbHkgY2hvc2UgYSByYW5kb20gcGVlciBhbmQgc2VuZCBhIG1lc3NhZ2VcbiAqIFxccGFyYW0gc291cmNlIHRoZSBwcm90b2NvbCByZWNlaXZpbmcgdGhlIG1lc3NhZ2VzXG4gKiBcXHBhcmFtIG5hbWUgdGhlIG5hbWUgb2YgdGhlIHByb3RvY29sLCBkZWZhdWx0IGlzICd1bmljYXN0J1xuICovXG5mdW5jdGlvbiBVbmljYXN0KHNvdXJjZSwgbWF4LCBuYW1lKSB7XG4gICAgRXZlbnRFbWl0dGVyLmNhbGwodGhpcyk7XG4gICAgdGhpcy5uYW1lID0gbmFtZSB8fCAndW5pY2FzdCc7XG4gICAgdGhpcy5zb3VyY2UgPSBzb3VyY2U7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHRoaXMuc291cmNlLm9uKHNlbGYubmFtZSsnLXJlY2VpdmUnLCBmdW5jdGlvbihzb2NrZXQsIG1lc3NhZ2Upe1xuICAgICAgICBzZWxmLmVtaXQoJ3JlY2VpdmUnLCBzb2NrZXQsIG1lc3NhZ2UucGF5bG9hZCk7XG4gICAgfSk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgc2VuZCB0aGUgbWVzc2FnZSB0byBvbmUgcmFuZG9tIHBhcnRpY2lwYW50XG4gKiBcXHBhcmFtIG1lc3NhZ2UgdGhlIG1lc3NhZ2UgdG8gc2VuZFxuICogXFxwYXJhbSBzb2NrZXQgb3B0aW9uYWwga25vd24gc29ja2V0XG4gKi9cblVuaWNhc3QucHJvdG90eXBlLnNlbmQgPSBmdW5jdGlvbihtZXNzYWdlLCBzb2NrZXQpe1xuICAgIC8vICMxIGdldCB0aGUgbmVpZ2hib3Job29kIGFuZCBjcmVhdGUgdGhlIG1lc3NhZ2VcbiAgICB2YXIgbGlua3MgPSAoc29ja2V0ICYmIFtzb2NrZXRdKSB8fCB0aGlzLnNvdXJjZS5nZXRQZWVycygxKTtcbiAgICB2YXIgbVVuaWNhc3QgPSBuZXcgTVVuaWNhc3QodGhpcy5uYW1lLCBtZXNzYWdlKTtcbiAgICAvLyAjMiBzZW5kIHRoZSBtZXNzYWdlXG4gICAgaWYgKGxpbmtzLmxlbmd0aD4wICYmIGxpbmtzWzBdLmNvbm5lY3RlZCl7XG4gICAgICAgIGxpbmtzWzBdLnNlbmQobVVuaWNhc3QpO1xuICAgIH07XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IFVuaWNhc3Q7XG4iLCJ2YXIgQkkgPSByZXF1aXJlKCdCaWdJbnQnKTtcblxuLyohXG4gKiBcXGNsYXNzIEJhc2VcbiAqIFxcYnJpZWYgcHJvdmlkZXMgYmFzaWMgZnVuY3Rpb24gdG8gYml0IG1hbmlwdWxhdGlvblxuICogXFxwYXJhbSBiIHRoZSBudW1iZXIgb2YgYml0cyBhdCBsZXZlbCAwIG9mIHRoZSBkZW5zZSBzcGFjZVxuICovXG5mdW5jdGlvbiBCYXNlKGIpeyAgICBcbiAgICB2YXIgREVGQVVMVF9CQVNFID0gMztcbiAgICB0aGlzLl9iID0gYiB8fCBERUZBVUxUX0JBU0U7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgUHJvY2VzcyB0aGUgbnVtYmVyIG9mIGJpdHMgdXNhZ2UgYXQgYSBjZXJ0YWluIGxldmVsIG9mIGRlbnNlIHNwYWNlXG4gKiBcXHBhcmFtIGxldmVsIHRoZSBsZXZlbCBpbiBkZW5zZSBzcGFjZSwgaS5lLiwgdGhlIG51bWJlciBvZiBjb25jYXRlbmF0aW9uXG4gKi9cbkJhc2UucHJvdG90eXBlLmdldEJpdEJhc2UgPSBmdW5jdGlvbihsZXZlbCl7XG4gICAgcmV0dXJuIHRoaXMuX2IgKyBsZXZlbDtcbn07XG5cbi8qIVxuICogXFxicmllZiBQcm9jZXNzIHRoZSB0b3RhbCBudW1iZXIgb2YgYml0cyB1c2FnZSB0byBnZXQgdG8gYSBjZXJ0YWluIGxldmVsXG4gKiBcXHBhcmFtIGxldmVsIHRoZSBsZXZlbCBpbiBkZW5zZSBzcGFjZVxuICovXG5CYXNlLnByb3RvdHlwZS5nZXRTdW1CaXQgPSBmdW5jdGlvbihsZXZlbCl7XG4gICAgdmFyIG4gPSB0aGlzLmdldEJpdEJhc2UobGV2ZWwpLFxuICAgICAgICBtID0gdGhpcy5fYi0xO1xuICAgIHJldHVybiAobiAqIChuICsgMSkpIC8gMiAtIChtICogKG0gKyAxKSAvIDIpO1xufTtcblxuLyohXG4gIFxcYnJpZWYgcHJvY2VzcyB0aGUgaW50ZXJ2YWwgYmV0d2VlbiB0d28gTFNFUU5vZGVcbiAgXFxwYXJhbSBwIHRoZSBwcmV2aW91cyBMU0VRTm9kZVxuICBcXHBhcmFtIHEgdGhlIG5leHQgTFNFUU5vZGVcbiAgXFxwYXJhbSBsZXZlbCB0aGUgZGVwdGggb2YgdGhlIHRyZWUgdG8gcHJvY2Vzc1xuICBcXHJldHVybiBhbiBpbnRlZ2VyIHdoaWNoIGlzIHRoZSBpbnRlcnZhbCBiZXR3ZWVuIHRoZSB0d28gbm9kZSBhdCB0aGUgZGVwdGhcbiovXG5CYXNlLnByb3RvdHlwZS5nZXRJbnRlcnZhbCA9IGZ1bmN0aW9uKHAsIHEsIGxldmVsKXtcbiAgICB2YXIgc3VtID0gMCwgaSA9IDAsXG4gICAgICAgIHBJc0dyZWF0ZXIgPSBmYWxzZSwgY29tbW9uUm9vdCA9IHRydWUsXG4gICAgICAgIHByZXZWYWx1ZSA9IDAsIG5leHRWYWx1ZSA9IDA7XG4gICAgXG4gICAgd2hpbGUgKGk8PWxldmVsKXtcbiAgICAgICAgcHJldlZhbHVlID0gMDsgaWYgKHAgIT09IG51bGwpeyBwcmV2VmFsdWUgPSBwLnQucDsgfVxuICAgICAgICBuZXh0VmFsdWUgPSAwOyBpZiAocSAhPT0gbnVsbCl7IG5leHRWYWx1ZSA9IHEudC5wOyB9XG4gICAgICAgIGlmIChjb21tb25Sb290ICYmIHByZXZWYWx1ZSAhPT0gbmV4dFZhbHVlKXtcbiAgICAgICAgICAgIGNvbW1vblJvb3QgPSBmYWxzZTtcbiAgICAgICAgICAgIHBJc0dyZWF0ZXIgPSBwcmV2VmFsdWUgPiBuZXh0VmFsdWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBJc0dyZWF0ZXIpeyBuZXh0VmFsdWUgPSBNYXRoLnBvdygyLHRoaXMuZ2V0Qml0QmFzZShpKSktMTsgfVxuICAgICAgICBpZiAoY29tbW9uUm9vdCB8fCBwSXNHcmVhdGVyIHx8IGkhPT1sZXZlbCl7XG4gICAgICAgICAgICBzdW0gKz0gbmV4dFZhbHVlIC0gcHJldlZhbHVlOyBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHN1bSArPSBuZXh0VmFsdWUgLSBwcmV2VmFsdWUgLSAxO1xuICAgICAgICB9XG4gICAgICAgIGlmIChpIT09bGV2ZWwpe1xuICAgICAgICAgICAgc3VtICo9IE1hdGgucG93KDIsdGhpcy5nZXRCaXRCYXNlKGkrMSkpO1xuICAgICAgICB9O1xuICAgICAgICBpZiAocCE9PW51bGwgJiYgcC5jaGlsZHJlbi5sZW5ndGghPT0wKXtwPXAuY2hpbGRyZW5bMF07fSBlbHNle3A9bnVsbDt9O1xuICAgICAgICBpZiAocSE9PW51bGwgJiYgcS5jaGlsZHJlbi5sZW5ndGghPT0wKXtxPXEuY2hpbGRyZW5bMF07fSBlbHNle3E9bnVsbDt9O1xuICAgICAgICArK2k7XG4gICAgfVxuICAgIHJldHVybiBzdW07XG59O1xuXG5CYXNlLmluc3RhbmNlID0gbnVsbDtcblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihhcmdzKXtcbiAgICBpZiAoYXJncyl7XG4gICAgICAgIEJhc2UuaW5zdGFuY2UgPSBuZXcgQmFzZShhcmdzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoQmFzZS5pbnN0YW5jZSA9PT0gbnVsbCl7XG4gICAgICAgICAgICBCYXNlLmluc3RhbmNlID0gbmV3IEJhc2UoKTtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIHJldHVybiBCYXNlLmluc3RhbmNlO1xufTtcbiIsInZhciBCSSA9IHJlcXVpcmUoJ0JpZ0ludCcpO1xudmFyIEJhc2UgPSByZXF1aXJlKCcuL2Jhc2UuanMnKSgpO1xudmFyIFRyaXBsZSA9IHJlcXVpcmUoJy4vdHJpcGxlLmpzJyk7XG52YXIgTFNFUU5vZGUgPSByZXF1aXJlKCcuL2xzZXFub2RlLmpzJyk7XG5cbi8qIVxuICogXFxjbGFzcyBJZGVudGlmaWVyXG4gKiBcXGJyaWVmIFVuaXF1ZSBhbmQgaW1tdXRhYmxlIGlkZW50aWZpZXIgY29tcG9zZWQgb2YgZGlnaXQsIHNvdXJjZXMsIGNvdW50ZXJzXG4gKiBcXHBhcmFtIGQgdGhlIGRpZ2l0IChwb3NpdGlvbiBpbiBkZW5zZSBzcGFjZSlcbiAqIFxccGFyYW0gcyB0aGUgbGlzdCBvZiBzb3VyY2VzXG4gKiBcXHBhcmFtIGMgdGhlIGxpc3Qgb2YgY291bnRlcnNcbiAqL1xuZnVuY3Rpb24gSWRlbnRpZmllcihkLCBzLCBjKXtcbiAgICB0aGlzLl9kID0gZDtcbiAgICB0aGlzLl9zID0gcztcbiAgICB0aGlzLl9jID0gYztcbn07XG5cbi8qIVxuICogXFxicmllZiBzZXQgdGhlIGQscyxjIHZhbHVlcyBhY2NvcmRpbmcgdG8gdGhlIG5vZGUgaW4gYXJndW1lbnRcbiAqIFxccGFyYW0gbm9kZSB0aGUgbHNlcW5vZGUgY29udGFpbmluZyB0aGUgcGF0aCBpbiB0aGUgdHJlZSBzdHJ1Y3R1cmVcbiAqL1xuSWRlbnRpZmllci5wcm90b3R5cGUuZnJvbU5vZGUgPSBmdW5jdGlvbihub2RlKXtcbiAgICAvLyAjMSBwcm9jZXNzIHRoZSBsZW5ndGggb2YgdGhlIHBhdGhcbiAgICB2YXIgbGVuZ3RoID0gMSwgdGVtcE5vZGUgPSBub2RlLCBpID0gMDtcbiAgICBcbiAgICB3aGlsZSAodGVtcE5vZGUuY2hpbGRyZW4ubGVuZ3RoICE9PSAwKXtcblx0KytsZW5ndGg7XG4gICAgICAgIHRlbXBOb2RlID0gdGVtcE5vZGUuY2hpbGRyZW5bMF07XG4gICAgfTtcbiAgICAvLyAjMSBjb3B5IHRoZSB2YWx1ZXMgY29udGFpbmVkIGluIHRoZSBwYXRoXG4gICAgdGhpcy5fZCA9IEJJLmludDJiaWdJbnQoMCxCYXNlLmdldFN1bUJpdChsZW5ndGggLSAxKSk7XG4gICAgXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW5ndGggOyArK2kpe1xuICAgICAgICAvLyAjMWEgY29weSB0aGUgc2l0ZSBpZFxuICAgICAgICB0aGlzLl9zLnB1c2gobm9kZS50LnMpO1xuICAgICAgICAvLyAjMWIgY29weSB0aGUgY291bnRlclxuICAgICAgICB0aGlzLl9jLnB1c2gobm9kZS50LmMpO1xuICAgICAgICAvLyAjMWMgY29weSB0aGUgZGlnaXRcbiAgICAgICAgQkkuYWRkSW50Xyh0aGlzLl9kLCBub2RlLnQucCk7XG4gICAgICAgIGlmIChpIT09KGxlbmd0aC0xKSl7XG4gICAgICAgICAgICBCSS5sZWZ0U2hpZnRfKHRoaXMuX2QsIEJhc2UuZ2V0Qml0QmFzZShpKzEpKTtcbiAgICAgICAgfTtcbiAgICAgICAgbm9kZSA9IG5vZGUuY2hpbGRyZW5bMF07XG4gICAgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiBjb252ZXJ0IHRoZSBpZGVudGlmaWVyIGludG8gYSBub2RlIHdpdGhvdXQgZWxlbWVudFxuICogXFxwYXJhbSBlIHRoZSBlbGVtZW50IGFzc29jaWF0ZWQgd2l0aCB0aGUgbm9kZVxuICovXG5JZGVudGlmaWVyLnByb3RvdHlwZS50b05vZGUgPSBmdW5jdGlvbihlKXtcbiAgICB2YXIgcmVzdWx0UGF0aCA9IFtdLCBkQml0TGVuZ3RoID0gQmFzZS5nZXRTdW1CaXQodGhpcy5fYy5sZW5ndGggLTEpLCBpID0gMCxcbiAgICAgICAgbWluZTtcbiAgICAvLyAjMSBkZWNvbnN0cnVjdCB0aGUgZGlnaXQgXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLl9jLmxlbmd0aDsgKytpKXtcbiAgICAgICAgLy8gIzEgdHJ1bmNhdGUgbWluZVxuICAgICAgICBtaW5lID0gQkkuZHVwKHRoaXMuX2QpO1xuICAgICAgICAvLyAjMWEgc2hpZnQgcmlnaHQgdG8gZXJhc2UgdGhlIHRhaWwgb2YgdGhlIHBhdGhcbiAgICAgICAgQkkucmlnaHRTaGlmdF8obWluZSwgZEJpdExlbmd0aCAtIEJhc2UuZ2V0U3VtQml0KGkpKTtcbiAgICAgICAgLy8gIzFiIGNvcHkgdmFsdWUgaW4gdGhlIHJlc3VsdFxuICAgICAgICByZXN1bHRQYXRoLnB1c2gobmV3IFRyaXBsZShCSS5tb2RJbnQobWluZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIE1hdGgucG93KDIsQmFzZS5nZXRCaXRCYXNlKGkpKSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3NbaV0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2NbaV0pKTtcbiAgICB9O1xuICAgIHJldHVybiBuZXcgTFNFUU5vZGUocmVzdWx0UGF0aCwgZSk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgY29tcGFyZSB0d28gaWRlbnRpZmllcnNcbiAqIFxccGFyYW0gbyB0aGUgb3RoZXIgaWRlbnRpZmllclxuICogXFxyZXR1cm4gLTEgaWYgdGhpcyBpcyBsb3dlciwgMCBpZiB0aGV5IGFyZSBlcXVhbCwgMSBpZiB0aGlzIGlzIGdyZWF0ZXJcbiAqL1xuSWRlbnRpZmllci5wcm90b3R5cGUuY29tcGFyZSA9IGZ1bmN0aW9uKG8pe1xuICAgIHZhciBkQml0TGVuZ3RoID0gQmFzZS5nZXRTdW1CaXQodGhpcy5fYy5sZW5ndGggLSAxKSxcbiAgICAgICAgb2RCaXRMZW5ndGggPSBCYXNlLmdldFN1bUJpdChvLl9jLmxlbmd0aCAtIDEpLFxuICAgICAgICBjb21wYXJpbmcgPSB0cnVlLFxuICAgICAgICBjb21wID0gMCwgaSA9IDAsXG4gICAgICAgIHN1bSwgbWluZSwgb3RoZXI7XG4gICAgXG4gICAgLy8gIzEgQ29tcGFyZSB0aGUgbGlzdCBvZiA8ZCxzLGM+XG4gICAgd2hpbGUgKGNvbXBhcmluZyAmJiBpIDwgTWF0aC5taW4odGhpcy5fYy5sZW5ndGgsIG8uX2MubGVuZ3RoKSApIHtcbiAgICAgICAgLy8gY2FuIHN0b3AgYmVmb3JlIHRoZSBlbmQgb2YgZm9yIGxvb3Agd2l6IHJldHVyblxuICAgICAgICBzdW0gPSBCYXNlLmdldFN1bUJpdChpKTtcbiAgICAgICAgLy8gIzFhIHRydW5jYXRlIG1pbmVcbiAgICAgICAgbWluZSA9IEJJLmR1cCh0aGlzLl9kKTtcbiAgICAgICAgQkkucmlnaHRTaGlmdF8obWluZSwgZEJpdExlbmd0aCAtIHN1bSk7XG4gICAgICAgIC8vICMxYiB0cnVuY2F0ZSBvdGhlclxuICAgICAgICBvdGhlciA9IEJJLmR1cChvLl9kKTtcbiAgICAgICAgQkkucmlnaHRTaGlmdF8ob3RoZXIsIG9kQml0TGVuZ3RoIC0gc3VtKTtcbiAgICAgICAgLy8gIzIgQ29tcGFyZSB0cmlwbGVzXG4gICAgICAgIGlmICghQkkuZXF1YWxzKG1pbmUsb3RoZXIpKSB7ICAvLyAjMmEgZGlnaXRcbiAgICAgICAgICAgIGlmIChCSS5ncmVhdGVyKG1pbmUsb3RoZXIpKXtjb21wID0gMTt9ZWxzZXtjb21wID0gLTE7fTtcbiAgICAgICAgICAgIGNvbXBhcmluZyA9IGZhbHNlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29tcCA9IHRoaXMuX3NbaV0gLSBvLl9zW2ldOyAvLyAjMmIgc291cmNlXG4gICAgICAgICAgICBpZiAoY29tcCAhPT0gMCkge1xuICAgICAgICAgICAgICAgIGNvbXBhcmluZyA9IGZhbHNlO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb21wID0gdGhpcy5fY1tpXSAtIG8uX2NbaV07IC8vIDJjIGNsb2NrXG4gICAgICAgICAgICAgICAgaWYgKGNvbXAgIT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgY29tcGFyaW5nID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH07XG4gICAgICAgIH07XG4gICAgICAgICsraTtcbiAgICB9O1xuICAgIFxuICAgIGlmIChjb21wPT09MCl7XG4gICAgICAgIGNvbXAgPSB0aGlzLl9jLmxlbmd0aCAtIG8uX2MubGVuZ3RoOyAvLyAjMyBjb21wYXJlIGxpc3Qgc2l6ZVxuICAgIH07XG4gICAgcmV0dXJuIGNvbXA7XG59O1xuXG5cbm1vZHVsZS5leHBvcnRzID0gSWRlbnRpZmllcjtcbiIsInZhciBUcmlwbGUgPSByZXF1aXJlKCcuL3RyaXBsZS5qcycpO1xucmVxdWlyZSgnLi91dGlsLmpzJyk7XG5cbi8qIVxuICogXFxicmllZiBhIG5vZGUgb2YgdGhlIExTRVEgdHJlZVxuICogXFxwYXJhbSB0cmlwbGVMaXN0IHRoZSBsaXN0IG9mIHRyaXBsZSBjb21wb3NpbmcgdGhlIHBhdGggdG8gdGhlIGVsZW1lbnRcbiAqIFxccGFyYW0gZWxlbWVudCB0aGUgZWxlbWVudCB0byBpbnNlcnQgaW4gdGhlIHN0cnVjdHVyZVxuICovXG5mdW5jdGlvbiBMU0VRTm9kZSh0cmlwbGVMaXN0LCBlbGVtZW50KXtcbiAgICB0aGlzLnQgPSB0cmlwbGVMaXN0LnNoaWZ0KCk7XG4gICAgaWYgKHRyaXBsZUxpc3QubGVuZ3RoID09PSAwKXtcbiAgICAgICAgdGhpcy5lID0gZWxlbWVudDtcbiAgICAgICAgdGhpcy5zdWJDb3VudGVyID0gMDsgLy8gY291bnQgdGhlIG51bWJlciBvZiBjaGlsZHJlbiBhbmQgc3ViY2hpbGRyZW5cbiAgICAgICAgdGhpcy5jaGlsZHJlbiA9IFtdO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuZSA9IG51bGw7XG4gICAgICAgIHRoaXMuc3ViQ291bnRlciA9IDE7XG4gICAgICAgIHRoaXMuY2hpbGRyZW4gPSBbXTtcbiAgICAgICAgdGhpcy5jaGlsZHJlbi5wdXNoKG5ldyBMU0VRTm9kZSh0cmlwbGVMaXN0LCBlbGVtZW50KSk7XG4gICAgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiBhZGQgYSBwYXRoIGVsZW1lbnQgdG8gdGhlIGN1cnJlbnQgbm9kZVxuICogXFxwYXJhbSBub2RlIHRoZSBub2RlIHRvIGFkZCBhcyBhIGNoaWxkcmVuIG9mIHRoaXMgbm9kZVxuICogXFxyZXR1cm4gLTEgaWYgdGhlIGVsZW1lbnQgYWxyZWFkeSBleGlzdHNcbiAqL1xuTFNFUU5vZGUucHJvdG90eXBlLmFkZCA9IGZ1bmN0aW9uKG5vZGUpe1xuICAgIHZhciBpbmRleCA9IHRoaXMuY2hpbGRyZW4uYmluYXJ5SW5kZXhPZihub2RlKTtcbiAgICBcbiAgICAvLyAjMSBpZiB0aGUgcGF0aCBkbyBubyBleGlzdCwgY3JlYXRlIGl0XG4gICAgaWYgKGluZGV4IDwgMCB8fCB0aGlzLmNoaWxkcmVuLmxlbmd0aCA9PT0gMCAgfHxcbiAgICAgICAgKGluZGV4ID09PSAwICYmIHRoaXMuY2hpbGRyZW4ubGVuZ3RoID4gMCAmJiBcbiAgICAgICAgIHRoaXMuY2hpbGRyZW5bMF0uY29tcGFyZShub2RlKSE9PTApKXtcbiAgICAgICAgdGhpcy5jaGlsZHJlbi5zcGxpY2UoLWluZGV4LCAwLCBub2RlKTtcbiAgICAgICAgdGhpcy5zdWJDb3VudGVyKz0xO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIC8vICMyIG90aGVyd2lzZSwgY29udGludWUgdG8gZXhwbG9yZSB0aGUgc3VidHJlZXNcbiAgICAgICAgaWYgKG5vZGUuY2hpbGRyZW4ubGVuZ3RoID09PSAwKXtcbiAgICAgICAgICAgIC8vICMyYSBjaGVjayBpZiB0aGUgZWxlbWVudCBhbHJlYWR5IGV4aXN0c1xuICAgICAgICAgICAgaWYgKHRoaXMuY2hpbGRyZW5baW5kZXhdLmUgIT09IG51bGwpe1xuICAgICAgICAgICAgICAgIHJldHVybiAtMTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5jaGlsZHJlbltpbmRleF0uZSA9IG5vZGUuZTtcbiAgICAgICAgICAgICAgICB0aGlzLnN1YkNvdW50ZXIrPTE7XG4gICAgICAgICAgICB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gIzMgaWYgZGlkbm90IGV4aXN0LCBpbmNyZW1lbnQgdGhlIGNvdW50ZXJcbiAgICAgICAgICAgIGlmICh0aGlzLmNoaWxkcmVuW2luZGV4XS5hZGQobm9kZS5jaGlsZHJlblswXSkhPT0tMSl7XG4gICAgICAgICAgICAgICAgdGhpcy5zdWJDb3VudGVyKz0xO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfTtcbiAgICB9O1xufTtcblxuLyohIFxuICogXFxicmllZiByZW1vdmUgdGhlIG5vZGUgb2YgdGhlIHRyZWUgYW5kIGFsbCBub2RlIHdpdGhpbiBwYXRoIGJlaW5nIHVzZWxlc3NcbiAqIFxccGFyYW0gbm9kZSB0aGUgbm9kZSBjb250YWluaW5nIHRoZSBwYXRoIHRvIHJlbW92ZVxuICogXFxyZXR1cm4gLTEgaWYgdGhlIG5vZGUgZG9lcyBub3QgZXhpc3RcbiAqL1xuTFNFUU5vZGUucHJvdG90eXBlLmRlbCA9IGZ1bmN0aW9uKG5vZGUpe1xuICAgIHZhciBpbmRleGVzID0gdGhpcy5nZXRJbmRleGVzKG5vZGUpLFxuICAgICAgICBjdXJyZW50VHJlZSA9IHRoaXMsIGkgPSAwLCBpc1NwbGl0dGVkID0gZmFsc2U7XG5cbiAgICBpZiAoaW5kZXhlcyA9PT0gLTEpIHsgcmV0dXJuIC0xOyB9OyAvLyBpdCBkb2VzIG5vdCBleGlzdHNcbiAgICB0aGlzLnN1YkNvdW50ZXIgLT0gMTtcbiAgICB3aGlsZSAoaSA8IGluZGV4ZXMubGVuZ3RoICYmICEoaXNTcGxpdHRlZCkpe1xuICAgICAgICBpZiAoIShjdXJyZW50VHJlZS5jaGlsZHJlbltpbmRleGVzW2ldXS5lICE9PSBudWxsICYmXG4gICAgICAgICAgICAgIGk9PT0oaW5kZXhlcy5sZW5ndGggLSAxKSkpe1xuICAgICAgICAgICAgY3VycmVudFRyZWUuY2hpbGRyZW5baW5kZXhlc1tpXV0uc3ViQ291bnRlciAtPSAxOyAgICAgXG4gICAgICAgIH07XG4gICAgICAgIGlmIChjdXJyZW50VHJlZS5jaGlsZHJlbltpbmRleGVzW2ldXS5zdWJDb3VudGVyIDw9IDBcbiAgICAgICAgICAgICYmIChjdXJyZW50VHJlZS5jaGlsZHJlbltpbmRleGVzW2ldXS5lID09PSBudWxsIHx8XG4gICAgICAgICAgICAgICAgKGN1cnJlbnRUcmVlLmNoaWxkcmVuW2luZGV4ZXNbaV1dLmUgIT09IG51bGwgJiZcbiAgICAgICAgICAgICAgICAgaT09PShpbmRleGVzLmxlbmd0aCAtIDEpKSkpe1xuICAgICAgICAgICAgY3VycmVudFRyZWUuY2hpbGRyZW4uc3BsaWNlKGluZGV4ZXNbaV0sMSk7XG4gICAgICAgICAgICBpc1NwbGl0dGVkID0gdHJ1ZTtcbiAgICAgICAgfTtcbiAgICAgICAgY3VycmVudFRyZWUgPSBjdXJyZW50VHJlZS5jaGlsZHJlbltpbmRleGVzW2ldXTtcbiAgICAgICAgKytpO1xuICAgIH07XG4gICAgaWYgKCFpc1NwbGl0dGVkKXsgY3VycmVudFRyZWUuZSA9IG51bGw7fTtcbn07XG5cbi8qIVxuICogXFxicmllZiBjb21wYXJpc29uIGZ1bmN0aW9uIHVzZWQgdG8gb3JkZXIgdGhlIGxpc3Qgb2YgY2hpbGRyZW4gYXQgZWFjaCBub2RlXG4gKiBcXHBhcmFtIG8gdGhlIG90aGVyIG5vZGUgdG8gY29tcGFyZSB3aXRoXG4gKi9cbkxTRVFOb2RlLnByb3RvdHlwZS5jb21wYXJlID0gZnVuY3Rpb24obyl7XG4gICAgcmV0dXJuIHRoaXMudC5jb21wYXJlKG8udCk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgdGhlIG9yZGVyZWQgdHJlZSBjYW4gYmUgbGluZWFyaXplZCBpbnRvIGEgc2VxdWVuY2UuIFRoaXMgZnVuY3Rpb24gZ2V0XG4gKiB0aGUgaW5kZXggb2YgdGhlIHBhdGggcmVwcmVzZW50ZWQgYnkgdGhlIGxpc3Qgb2YgdHJpcGxlc1xuICogXFxwYXJhbSBub2RlIHRoZSBub2RlIGNvbnRhaW5pbmcgdGhlIHBhdGhcbiAqIFxccmV0dXJuIHRoZSBpbmRleCBvZiB0aGUgcGF0aCBpbiB0aGUgbm9kZVxuICovXG5MU0VRTm9kZS5wcm90b3R5cGUuaW5kZXhPZiA9IGZ1bmN0aW9uKG5vZGUpe1xuICAgIHZhciBpbmRleGVzID0gdGhpcy5nZXRJbmRleGVzKG5vZGUpLFxuICAgICAgICBzdW0gPSAwLCBjdXJyZW50VHJlZSA9IHRoaXMsXG4gICAgICAgIGogPSAwO1xuICAgIGlmIChpbmRleGVzID09PSAtMSl7cmV0dXJuIC0xO307IC8vIG5vZGUgZG9lcyBub3QgZXhpc3RcbiAgICBpZiAodGhpcy5lICE9PSBudWxsKXsgc3VtICs9MTsgfTtcbiAgICBcbiAgICBmb3IgKHZhciBpID0gMDsgaTxpbmRleGVzLmxlbmd0aDsgKytpKXtcbiAgICAgICAgaWYgKGluZGV4ZXNbaV0gPCAoY3VycmVudFRyZWUuY2hpbGRyZW4ubGVuZ3RoLzIpKXtcbiAgICAgICAgICAgIC8vICNBIHN0YXJ0IGZyb20gdGhlIGJlZ2lubmluZ1xuICAgICAgICAgICAgZm9yICh2YXIgaiA9IDA7IGo8aW5kZXhlc1tpXTsgKytqKXtcbiAgICAgICAgICAgICAgICBpZiAoY3VycmVudFRyZWUuY2hpbGRyZW5bal0uZSAhPT0gbnVsbCl7IHN1bSs9MTsgfTtcbiAgICAgICAgICAgICAgICBzdW0gKz0gY3VycmVudFRyZWUuY2hpbGRyZW5bal0uc3ViQ291bnRlcjtcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyAjQiBzdGFydCBmcm9tIHRoZSBlbmRcbiAgICAgICAgICAgIHN1bSArPSBjdXJyZW50VHJlZS5zdWJDb3VudGVyO1xuICAgICAgICAgICAgZm9yICh2YXIgaiA9IGN1cnJlbnRUcmVlLmNoaWxkcmVuLmxlbmd0aC0xOyBqPj1pbmRleGVzW2ldOy0tail7XG4gICAgICAgICAgICAgICAgaWYgKGN1cnJlbnRUcmVlLmNoaWxkcmVuW2pdLmUgIT09IG51bGwpeyBzdW0tPTE7IH07XG4gICAgICAgICAgICAgICAgc3VtIC09IGN1cnJlbnRUcmVlLmNoaWxkcmVuW2pdLnN1YkNvdW50ZXI7ICBcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBqICs9IDE7XG4gICAgICAgIH07XG4gICAgICAgIGlmIChjdXJyZW50VHJlZS5jaGlsZHJlbltqXS5lICE9PSBudWxsKXsgc3VtKz0xOyB9O1xuICAgICAgICBjdXJyZW50VHJlZSA9IGN1cnJlbnRUcmVlLmNoaWxkcmVuW2pdO1xuICAgIH07XG4gICAgcmV0dXJuIHN1bS0xOyAvLyAtMSBiZWNhdXNlIGFsZ29yaXRobSBjb3VudGVkIHRoZSBlbGVtZW50IGl0c2VsZlxufTtcblxuLyohXG4gKiBcXGJyaWVmIGdldCB0aGUgbGlzdCBvZiBpbmRleGVzIG9mIHRoZSBhcnJheXMgcmVwcmVzZW50aW5nIHRoZSBjaGlsZHJlbiBpblxuICogdGhlIHRyZWVcbiAqIFxccGFyYW0gbm9kZSB0aGUgbm9kZSBjb250YWluaW5nIHRoZSBwYXRoXG4gKiBcXHJldHVybiBhIGxpc3Qgb2YgaW50ZWdlclxuICovXG5MU0VRTm9kZS5wcm90b3R5cGUuZ2V0SW5kZXhlcyA9IGZ1bmN0aW9uKG5vZGUpe1xuICAgIGZ1bmN0aW9uIF9nZXRJbmRleGVzKGluZGV4ZXMsIGN1cnJlbnRUcmVlLCBjdXJyZW50Tm9kZSl7XG4gICAgICAgIHZhciBpbmRleCA9IGN1cnJlbnRUcmVlLmNoaWxkcmVuLmJpbmFyeUluZGV4T2YoY3VycmVudE5vZGUpO1xuICAgICAgICBpZiAoaW5kZXggPCAwIHx8XG4gICAgICAgICAgICAoaW5kZXg9PT0wICYmIGN1cnJlbnRUcmVlLmNoaWxkcmVuLmxlbmd0aD09PTApKXsgcmV0dXJuIC0xOyB9XG4gICAgICAgIGluZGV4ZXMucHVzaChpbmRleCk7XG4gICAgICAgIGlmIChjdXJyZW50Tm9kZS5jaGlsZHJlbi5sZW5ndGg9PT0wIHx8XG4gICAgICAgICAgICBjdXJyZW50VHJlZS5jaGlsZHJlbi5sZW5ndGg9PT0wKXtcbiAgICAgICAgICAgIHJldHVybiBpbmRleGVzO1xuICAgICAgICB9O1xuICAgICAgICByZXR1cm4gX2dldEluZGV4ZXMoaW5kZXhlcyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnRUcmVlLmNoaWxkcmVuW2luZGV4XSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnROb2RlLmNoaWxkcmVuWzBdKTtcbiAgICAgICAgXG4gICAgfTtcbiAgICByZXR1cm4gX2dldEluZGV4ZXMoW10sIHRoaXMsIG5vZGUpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHRoZSBvcmRlcmVkIHRyZWUgY2FuIGJlIGxpbmVhcml6ZWQuIFRoaXMgZnVuY3Rpb24gZ2V0cyB0aGUgbm9kZSBhdFxuICogdGhlIGluZGV4IGluIHRoZSBwcm9qZWN0ZWQgc2VxdWVuY2UuXG4gKiBcXHBhcmFtIGluZGV4IHRoZSBpbmRleCBpbiB0aGUgc2VxdWVuY2VcbiAqIFxccmV0dXJucyB0aGUgbm9kZSBhdCB0aGUgaW5kZXhcbiAqL1xuTFNFUU5vZGUucHJvdG90eXBlLmdldCA9IGZ1bmN0aW9uKGluZGV4KXtcbiAgICBmdW5jdGlvbiBfZ2V0KGxlZnRTdW0sIGJ1aWxkaW5nTm9kZSwgcXVldWUsIGN1cnJlbnROb2RlKXtcbiAgICAgICAgdmFyIHN0YXJ0QmVnaW5uaW5nID0gdHJ1ZSwgdXNlRnVuY3Rpb24sIGkgPSAwLFxuICAgICAgICAgICAgcCwgdGVtcDtcbiAgICAgICAgLy8gIzAgdGhlIG5vZGUgaXMgZm91bmQsIHJldHVybiB0aGUgaW5jcmVtZW50YWxseSBidWlsdCBub2RlIGFuZCBwcmFpc2VcbiAgICAgICAgLy8gI3RoZSBzdW4gIVxuICAgICAgICBpZiAobGVmdFN1bSA9PT0gaW5kZXggJiYgY3VycmVudE5vZGUuZSAhPT0gbnVsbCl7XG4gICAgICAgICAgICAvLyAxYSBjb3B5IHRoZSB2YWx1ZSBvZiB0aGUgZWxlbWVudCBpbiB0aGUgcGF0aFxuICAgICAgICAgICAgcXVldWUuZSA9IGN1cnJlbnROb2RlLmU7XG4gICAgICAgICAgICByZXR1cm4gYnVpbGRpbmdOb2RlO1xuICAgICAgICB9O1xuICAgICAgICBpZiAoY3VycmVudE5vZGUuZSAhPT0gbnVsbCl7IGxlZnRTdW0gKz0gMTsgfTtcblxuICAgICAgICAvLyAjMSBzZWFyY2g6IGRvIEkgc3RhcnQgZnJvbSB0aGUgYmVnaW5uaW5nIG9yIHRoZSBlbmRcbiAgICAgICAgc3RhcnRCZWdpbm5pbmcgPSAoKGluZGV4LWxlZnRTdW0pPChjdXJyZW50Tm9kZS5zdWJDb3VudGVyLzIpKTtcbiAgICAgICAgaWYgKHN0YXJ0QmVnaW5uaW5nKXtcbiAgICAgICAgICAgIHVzZUZ1bmN0aW9uID0gZnVuY3Rpb24oYSxiKXtyZXR1cm4gYStiO307XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZWZ0U3VtICs9IGN1cnJlbnROb2RlLnN1YkNvdW50ZXI7XG4gICAgICAgICAgICB1c2VGdW5jdGlvbiA9IGZ1bmN0aW9uKGEsYil7cmV0dXJuIGEtYjt9O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gIzJhIGNvdW50aW5nIHRoZSBlbGVtZW50IGZyb20gbGVmdCB0byByaWdodFxuICAgICAgICBpZiAoIXN0YXJ0QmVnaW5uaW5nKSB7IGkgPSBjdXJyZW50Tm9kZS5jaGlsZHJlbi5sZW5ndGgtMTsgfTtcbiAgICAgICAgd2hpbGUgKChzdGFydEJlZ2lubmluZyAmJiBsZWZ0U3VtIDw9IGluZGV4KSB8fFxuICAgICAgICAgICAgICAgKCFzdGFydEJlZ2lubmluZyAmJiBsZWZ0U3VtID4gaW5kZXgpKXtcbiAgICAgICAgICAgIGlmIChjdXJyZW50Tm9kZS5jaGlsZHJlbltpXS5lIT09bnVsbCl7XG4gICAgICAgICAgICAgICAgbGVmdFN1bSA9IHVzZUZ1bmN0aW9uKGxlZnRTdW0sIDEpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGxlZnRTdW0gPSB1c2VGdW5jdGlvbihsZWZ0U3VtLGN1cnJlbnROb2RlLmNoaWxkcmVuW2ldLnN1YkNvdW50ZXIpO1xuICAgICAgICAgICAgaSA9IHVzZUZ1bmN0aW9uKGksIDEpO1xuICAgICAgICB9O1xuXG4gICAgICAgIC8vICMyYiBkZWNyZWFzaW5nIHRoZSBpbmNyZW1lbnRhdGlvblxuICAgICAgICBpID0gdXNlRnVuY3Rpb24oaSwtMSk7XG4gICAgICAgIGlmIChzdGFydEJlZ2lubmluZyl7XG4gICAgICAgICAgICBpZiAoY3VycmVudE5vZGUuY2hpbGRyZW5baV0uZSE9PW51bGwpe1xuICAgICAgICAgICAgICAgIGxlZnRTdW0gPSB1c2VGdW5jdGlvbihsZWZ0U3VtLCAtMSk7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgbGVmdFN1bSA9IHVzZUZ1bmN0aW9uKGxlZnRTdW0sLWN1cnJlbnROb2RlLmNoaWxkcmVuW2ldLnN1YkNvdW50ZXIpO1xuICAgICAgICB9O1xuICAgICAgICBcbiAgICAgICAgLy8gIzMgYnVpbGQgcGF0aFxuICAgICAgICBwID0gW107IHAucHVzaChjdXJyZW50Tm9kZS5jaGlsZHJlbltpXS50KTtcbiAgICAgICAgaWYgKGJ1aWxkaW5nTm9kZSA9PT0gbnVsbCl7XG4gICAgICAgICAgICBidWlsZGluZ05vZGUgPSBuZXcgTFNFUU5vZGUocCxudWxsKTtcbiAgICAgICAgICAgIHF1ZXVlID0gYnVpbGRpbmdOb2RlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGVtcCA9IG5ldyBMU0VRTm9kZShwLG51bGwpO1xuICAgICAgICAgICAgcXVldWUuYWRkKHRlbXApO1xuICAgICAgICAgICAgcXVldWUgPSB0ZW1wO1xuICAgICAgICB9O1xuICAgICAgICByZXR1cm4gX2dldChsZWZ0U3VtLCBidWlsZGluZ05vZGUsIHF1ZXVlLFxuICAgICAgICAgICAgICAgICAgICBjdXJyZW50Tm9kZS5jaGlsZHJlbltpXSk7XG4gICAgfTtcbiAgICByZXR1cm4gX2dldCgwLCBudWxsLCBudWxsLCB0aGlzKTtcbn07XG5cbi8qIVxuICogXFxicmllZiBjYXN0IHRoZSBKU09OIG9iamVjdCB0byBhIExTRVFOb2RlXG4gKiBcXHBhcmFtIG9iamVjdCB0aGUgSlNPTiBvYmplY3RcbiAqIFxccmV0dXJuIGEgc2VsZiByZWZlcmVuY2VcbiAqL1xuTFNFUU5vZGUucHJvdG90eXBlLmZyb21KU09OID0gZnVuY3Rpb24ob2JqZWN0KXtcbiAgICB0aGlzLnQgPSBuZXcgVHJpcGxlKG9iamVjdC50LnAsIG9iamVjdC50LnMsIG9iamVjdC50LmMpO1xuICAgIGlmIChvYmplY3QuY2hpbGRyZW4ubGVuZ3RoID09PSAwKXtcbiAgICAgICAgdGhpcy5lID0gb2JqZWN0LmU7XG4gICAgICAgIHRoaXMuc3ViQ291bnRlciA9IDA7XG4gICAgICAgIHRoaXMuY2hpbGRyZW4gPSBbXTtcbiAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLmUgPSBudWxsO1xuICAgICAgICB0aGlzLnN1YkNvdW50ZXIgPSAxO1xuICAgICAgICB0aGlzLmNoaWxkcmVuID0gW107XG4gICAgICAgIHRoaXMuY2hpbGRyZW4ucHVzaChcbiAgICAgICAgICAgIChuZXcgTFNFUU5vZGUoW10sIG51bGwpLmZyb21KU09OKG9iamVjdC5jaGlsZHJlblswXSkpKTtcbiAgICB9O1xuICAgIHJldHVybiB0aGlzO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBMU0VRTm9kZTtcbiIsInZhciBCSSA9IHJlcXVpcmUoJ0JpZ0ludCcpO1xudmFyIEJhc2UgPSByZXF1aXJlKCcuL2Jhc2UuanMnKSgxNSk7XG52YXIgUyA9IHJlcXVpcmUoJy4vc3RyYXRlZ3kuanMnKSgxMCk7XG52YXIgSUQgPSByZXF1aXJlKCcuL2lkZW50aWZpZXIuanMnKTtcbnZhciBUcmlwbGUgPSByZXF1aXJlKCcuL3RyaXBsZS5qcycpO1xudmFyIExTRVFOb2RlID0gcmVxdWlyZSgnLi9sc2Vxbm9kZS5qcycpO1xuXG4vKiFcbiAqIFxcY2xhc3MgTFNFUVRyZWVcbiAqXG4gKiBcXGJyaWVmIERpc3RyaWJ1dGVkIGFycmF5IHVzaW5nIExTRVEgYWxsb2NhdGlvbiBzdHJhdGVneSB3aXRoIGFuIHVuZGVybHlpbmdcbiAqIGV4cG9uZW50aWFsIHRyZWUgbW9kZWxcbiAqL1xuZnVuY3Rpb24gTFNFUVRyZWUocyl7XG4gICAgdmFyIGxpc3RUcmlwbGU7XG4gICAgXG4gICAgdGhpcy5fcyA9IHM7XG4gICAgdGhpcy5fYyA9IDA7XG4gICAgdGhpcy5faGFzaCA9IGZ1bmN0aW9uKGRlcHRoKSB7IHJldHVybiBkZXB0aCUyOyB9O1xuICAgIHRoaXMubGVuZ3RoID0gMDtcblxuICAgIHRoaXMucm9vdCA9IG5ldyBMU0VRTm9kZShbXSxudWxsKTtcbiAgICBsaXN0VHJpcGxlID0gW107IGxpc3RUcmlwbGUucHVzaChuZXcgVHJpcGxlKDAsMCwwKSk7ICAvLyBtaW4gYm91bmRcbiAgICB0aGlzLnJvb3QuYWRkKG5ldyBMU0VRTm9kZShsaXN0VHJpcGxlLCBcIlwiKSk7XG4gICAgbGlzdFRyaXBsZSA9IFtdO1xuICAgIGxpc3RUcmlwbGUucHVzaChuZXcgVHJpcGxlKE1hdGgucG93KDIsQmFzZS5nZXRCaXRCYXNlKDApKS0xLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIE51bWJlci5NQVhfVkFMVUUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgTnVtYmVyLk1BWF9WQUxVRSkpOyAvLyBtYXggYm91bmRcbiAgICB0aGlzLnJvb3QuYWRkKG5ldyBMU0VRTm9kZShsaXN0VHJpcGxlLCBcIlwiKSk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgcmV0dXJuIHRoZSBMU0VRTm9kZSBvZiB0aGUgZWxlbWVudCBhdCAgdGFyZ2V0ZWQgaW5kZXhcbiAqIFxccGFyYW0gaW5kZXggdGhlIGluZGV4IG9mIHRoZSBlbGVtZW50IGluIHRoZSBmbGF0dGVuZWQgYXJyYXlcbiAqIFxccmV0dXJuIHRoZSBMU0VRTm9kZSB0YXJnZXRpbmcgdGhlIGVsZW1lbnQgYXQgaW5kZXhcbiAqL1xuTFNFUVRyZWUucHJvdG90eXBlLmdldCA9IGZ1bmN0aW9uKGluZGV4KXtcbiAgICAvLyAjMSBzZWFyY2ggaW4gdGhlIHRyZWUgdG8gZ2V0IHRoZSB2YWx1ZVxuICAgIHJldHVybiB0aGlzLnJvb3QuZ2V0KGluZGV4KTtcbn07XG5cbi8qIVxuICogXFxicmllZiBpbnNlcnQgYSB2YWx1ZSBhdCB0aGUgdGFyZ2V0ZWQgaW5kZXhcbiAqIFxccGFyYW0gZWxlbWVudCB0aGUgZWxlbWVudCB0byBpbnNlcnRcbiAqIFxccGFyYW0gaW5kZXggdGhlIHBvc2l0aW9uIGluIHRoZSBhcnJheVxuICogXFxyZXR1cm4gYSBwYWlyIHtfZTogZWxlbWVudCAsIF9pOiBpZGVudGlmaWVyfVxuICovXG5MU0VRVHJlZS5wcm90b3R5cGUuaW5zZXJ0ID0gZnVuY3Rpb24oZWxlbWVudCwgaW5kZXgpe1xuICAgIHZhciBwZWkgPSB0aGlzLmdldChpbmRleCksIC8vICMxYSBwcmV2aW91cyBib3VuZFxuICAgICAgICBxZWkgPSB0aGlzLmdldChpbmRleCsxKSwgLy8gIzFiIG5leHQgYm91bmRcbiAgICAgICAgaWQsIGNvdXBsZTtcbiAgICB0aGlzLl9jICs9IDE7IC8vICMyYSBpbmNyZW1lbnRpbmcgdGhlIGxvY2FsIGNvdW50ZXJcbiAgICBpZCA9IHRoaXMuYWxsb2MocGVpLCBxZWkpOyAvLyAjMmIgZ2VuZXJhdGluZyB0aGUgaWQgaW5iZXR3ZWVuIHRoZSBib3VuZHNcbiAgICAvLyAjMyBhZGQgaXQgdG8gdGhlIHN0cnVjdHVyZSBhbmQgcmV0dXJuIHZhbHVlXG4gICAgY291cGxlID0ge19lOiBlbGVtZW50LCBfaTogaWR9XG4gICAgdGhpcy5hcHBseUluc2VydChlbGVtZW50LCBpZCwgdHJ1ZSk7XG4gICAgcmV0dXJuIGNvdXBsZTtcbn07XG5cbi8qIVxuICogXFxicmllZiBkZWxldGUgdGhlIGVsZW1lbnQgYXQgdGhlIGluZGV4XG4gKiBcXHBhcmFtIGluZGV4IHRoZSBpbmRleCBvZiB0aGUgZWxlbWVudCB0byBkZWxldGUgaW4gdGhlIGFycmF5XG4gKiBcXHJldHVybiB0aGUgaWRlbnRpZmllciBvZiB0aGUgZWxlbWVudCBhdCB0aGUgaW5kZXhcbiAqL1xuTFNFUVRyZWUucHJvdG90eXBlLnJlbW92ZSA9IGZ1bmN0aW9uKGluZGV4KXtcbiAgICB2YXIgZWkgPSB0aGlzLmdldChpbmRleCsxKSxcbiAgICAgICAgaSA9IG5ldyBJRChudWxsLCBbXSwgW10pO1xuICAgIGkuZnJvbU5vZGUoZWkpOyAvLyBmcm9tIG5vZGUgLT4gaWRcbiAgICB0aGlzLmFwcGx5UmVtb3ZlKGVpKTsgXG4gICAgcmV0dXJuIGk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZ2VuZXJhdGUgdGhlIGRpZ2l0IHBhcnQgb2YgdGhlIGlkZW50aWZpZXJzICBiZXR3ZWVuIHAgYW5kIHFcbiAqIFxccGFyYW0gcCB0aGUgZGlnaXQgcGFydCBvZiB0aGUgcHJldmlvdXMgaWRlbnRpZmllclxuICogXFxwYXJhbSBxIHRoZSBkaWdpdCBwYXJ0IG9mIHRoZSBuZXh0IGlkZW50aWZpZXJcbiAqIFxccmV0dXJuIHRoZSBkaWdpdCBwYXJ0IGxvY2F0ZWQgYmV0d2VlbiBwIGFuZCBxXG4gKi9cbkxTRVFUcmVlLnByb3RvdHlwZS5hbGxvYyA9IGZ1bmN0aW9uIChwLHEpe1xuICAgIHZhciBpbnRlcnZhbCA9IDAsIGxldmVsID0gMDtcbiAgICAvLyAjMSBwcm9jZXNzIHRoZSBsZXZlbCBvZiB0aGUgbmV3IGlkZW50aWZpZXJcbiAgICB3aGlsZSAoaW50ZXJ2YWw8PTApeyAvLyBubyByb29tIGZvciBpbnNlcnRpb25cbiAgICAgICAgaW50ZXJ2YWwgPSBCYXNlLmdldEludGVydmFsKHAsIHEsIGxldmVsKTsgLy8gKFRPRE8pIG9wdGltaXplXG4gICAgICAgICsrbGV2ZWw7XG4gICAgfTtcbiAgICBsZXZlbCAtPSAxO1xuICAgIGlmICh0aGlzLl9oYXNoKGxldmVsKSA9PT0gMCl7XG4gICAgICAgIHJldHVybiBTLmJQbHVzKHAsIHEsIGxldmVsLCBpbnRlcnZhbCwgdGhpcy5fcywgdGhpcy5fYyk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIFMuYk1pbnVzKHAsIHEsIGxldmVsLCBpbnRlcnZhbCwgdGhpcy5fcywgdGhpcy5fYyk7XG4gICAgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiBpbnNlcnQgYW4gZWxlbWVudCBjcmVhdGVkIGZyb20gYSByZW1vdGUgc2l0ZSBpbnRvIHRoZSBhcnJheVxuICogXFxwYXJhbSBlIHRoZSBlbGVtZW50IHRvIGluc2VydFxuICogXFxwYXJhbSBpIHRoZSBpZGVudGlmaWVyIG9mIHRoZSBlbGVtZW50XG4gKiBcXHBhcmFtIG5vSW5kZXggd2hldGhlciBvciBub3QgaXQgc2hvdWxkIHJldHVybiB0aGUgaW5kZXggb2YgdGhlIGluc2VydFxuICogXFxyZXR1cm4gdGhlIGluZGV4IG9mIHRoZSBuZXdseSBpbnNlcnRlZCBlbGVtZW50IGluIHRoZSBhcnJheVxuICovXG5MU0VRVHJlZS5wcm90b3R5cGUuYXBwbHlJbnNlcnQgPSBmdW5jdGlvbihlLCBpLCBub0luZGV4KXtcbiAgICB2YXIgbm9kZSwgcmVzdWx0O1xuICAgIC8vICMwIGNhc3QgZnJvbSB0aGUgcHJvcGVyIHR5cGVcbiAgICAvLyAjMEEgdGhlIGlkZW50aWZpZXIgaXMgYW4gSURcbiAgICBpZiAoaSAmJiBpLl9kICYmIGkuX3MgJiYgaS5fYyl7XG4gICAgICAgIG5vZGUgPSAobmV3IElEKGkuX2QsIGkuX3MsIGkuX2MpLnRvTm9kZShlKSk7XG4gICAgfTtcbiAgICAvLyAjMEIgdGhlIGlkZW50aWZpZXIgaXMgYSBMU0VRTm9kZVxuICAgIGlmIChpICYmIGkudCAmJiBpLmNoaWxkcmVuKXtcbiAgICAgICAgbm9kZSA9IChuZXcgTFNFUU5vZGUoW10sbnVsbCkpLmZyb21KU09OKGkpO1xuICAgIH07XG4gICAgLy8gIzIgaW50ZWdyYXRlcyB0aGUgbmV3IGVsZW1lbnQgdG8gdGhlIGRhdGEgc3RydWN0dXJlXG4gICAgcmVzdWx0ID0gdGhpcy5yb290LmFkZChub2RlKTtcbiAgICBpZiAocmVzdWx0ICE9PSAtMSl7XG4gICAgICAgIC8vICMzIGlmIHRoZSBlbGVtZW50IGFzIGJlZW4gYWRkZWRcbiAgICAgICAgdGhpcy5sZW5ndGggKz0gMTtcbiAgICB9O1xuICAgIHJldHVybiByZXN1bHQgfHwgKCFub0luZGV4ICYmIHRoaXMucm9vdC5pbmRleE9mKG5vZGUpKTtcbn07XG5cbi8qIVxuICogXFxicmllZiBkZWxldGUgdGhlIGVsZW1lbnQgd2l0aCB0aGUgdGFyZ2V0ZWQgaWRlbnRpZmllclxuICogXFxwYXJhbSBpIHRoZSBpZGVudGlmaWVyIG9mIHRoZSBlbGVtZW50XG4gKiBcXHJldHVybiB0aGUgaW5kZXggb2YgdGhlIGVsZW1lbnQgZmVzaGx5IGRlbGV0ZWQsIC0xIGlmIG5vIHJlbW92YWxcbiAqL1xuTFNFUVRyZWUucHJvdG90eXBlLmFwcGx5UmVtb3ZlID0gZnVuY3Rpb24oaSl7XG4gICAgdmFyIG5vZGUsIHBvc2l0aW9uO1xuICAgIC8vICMwIGNhc3QgZnJvbSB0aGUgcHJvcGVyIHR5cGVcbiAgICBpZiAoaSAmJiBpLl9kICYmIGkuX3MgJiYgaS5fYyl7XG4gICAgICAgIG5vZGUgPSAobmV3IElEKGkuX2QsIGkuX3MsIGkuX2MpKS50b05vZGUobnVsbCk7XG4gICAgfTtcbiAgICAvLyAjMEIgdGhlIGlkZW50aWZpZXIgaXMgYSBMU0VRTm9kZVxuICAgIGlmIChpICYmIGkudCAmJiBpLmNoaWxkcmVuKXtcbiAgICAgICAgbm9kZSA9IChuZXcgTFNFUU5vZGUoW10sbnVsbCkpLmZyb21KU09OKGkpO1xuICAgIH07XG4gICAgLy8gIzEgZ2V0IHRoZSBpbmRleCBvZiB0aGUgZWxlbWVudCB0byByZW1vdmVcbiAgICBwb3NpdGlvbiA9IHRoaXMucm9vdC5pbmRleE9mKG5vZGUpO1xuICAgIGlmIChwb3NpdGlvbiAhPT0gLTEpe1xuICAgICAgICAvLyAjMiBpZiBpdCBleGlzdHMgcmVtb3ZlIGl0XG4gICAgICAgIHRoaXMucm9vdC5kZWwobm9kZSk7XG4gICAgICAgIHRoaXMubGVuZ3RoIC09IDE7XG4gICAgfTtcbiAgICByZXR1cm4gcG9zaXRpb247XG59O1xuXG5cbi8qIVxuICogXFxicmllZiBjYXN0IHRoZSBKU09OIG9iamVjdCBpbnRvIGEgcHJvcGVyIExTRVFUcmVlLlxuICogXFxwYXJhbSBvYmplY3QgdGhlIEpTT04gb2JqZWN0IHRvIGNhc3RcbiAqIFxccmV0dXJuIGEgc2VsZiByZWZlcmVuY2VcbiAqL1xuTFNFUVRyZWUucHJvdG90eXBlLmZyb21KU09OID0gZnVuY3Rpb24ob2JqZWN0KXtcbiAgICAvLyAjMSBjb3B5IHRoZSBzb3VyY2UsIGNvdW50ZXIsIGFuZCBsZW5ndGggb2YgdGhlIG9iamVjdFxuICAgIHRoaXMuX3MgPSBvYmplY3QuX3M7XG4gICAgdGhpcy5fYyA9IG9iamVjdC5fYztcbiAgICB0aGlzLmxlbmd0aCA9IG9iamVjdC5sZW5ndGg7XG4gICAgLy8gIzIgZGVwdGggZmlyc3QgYWRkaW5nXG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGZ1bmN0aW9uIGRlcHRoRmlyc3QoY3VycmVudE5vZGUsIGN1cnJlbnRQYXRoKXtcbiAgICAgICAgdmFyIHRyaXBsZSA9IG5ldyBUcmlwbGUoY3VycmVudE5vZGUudC5wLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjdXJyZW50Tm9kZS50LnMsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnROb2RlLnQuYyk7XG4gICAgICAgIGN1cnJlbnRQYXRoLnB1c2godHJpcGxlKTsgLy8gc3RhY2tcbiAgICAgICAgaWYgKGN1cnJlbnROb2RlLmUhPT1udWxsKXtcbiAgICAgICAgICAgIHZhciBjb3B5ID0gY3VycmVudFBhdGguc2xpY2UoKTtcbiAgICAgICAgICAgIHNlbGYucm9vdC5hZGQobmV3IExTRVFOb2RlKGNvcHksIGN1cnJlbnROb2RlLmUpKTtcbiAgICAgICAgfTtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGk8Y3VycmVudE5vZGUuY2hpbGRyZW4ubGVuZ3RoOyArK2kpe1xuICAgICAgICAgICAgZGVwdGhGaXJzdChjdXJyZW50Tm9kZS5jaGlsZHJlbltpXSwgY3VycmVudFBhdGgpO1xuICAgICAgICB9O1xuICAgICAgICBjdXJyZW50UGF0aC5wb3AoKTsgLy8gdW5zdGFja1xuICAgIH07XG4gICAgZm9yICh2YXIgaSA9IDA7IGk8b2JqZWN0LnJvb3QuY2hpbGRyZW4ubGVuZ3RoOyArK2kpe1xuICAgICAgICBkZXB0aEZpcnN0KG9iamVjdC5yb290LmNoaWxkcmVuW2ldLCBbXSk7XG4gICAgfTtcbiAgICByZXR1cm4gdGhpcztcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gTFNFUVRyZWU7XG4iLCJ2YXIgQkkgPSByZXF1aXJlKCdCaWdJbnQnKTtcbnZhciBCYXNlID0gcmVxdWlyZSgnLi9iYXNlLmpzJykoKTtcbnZhciBJRCA9IHJlcXVpcmUoJy4vaWRlbnRpZmllci5qcycpO1xuXG4vKiFcbiAqIFxcY2xhc3MgU3RyYXRlZ3lcbiAqIFxcYnJpZWYgRW51bWVyYXRlIHRoZSBhdmFpbGFibGUgc3ViLWFsbG9jYXRpb24gc3RyYXRlZ2llcy4gVGhlIHNpZ25hdHVyZSBvZlxuICogdGhlc2UgZnVuY3Rpb25zIGlzIGYoSWQsIElkLCBOKywgTissIE4sIE4pOiBJZC5cbiAqIFxccGFyYW0gYm91bmRhcnkgdGhlIHZhbHVlIHVzZWQgYXMgdGhlIGRlZmF1bHQgbWF4aW11bSBzcGFjaW5nIGJldHdlZW4gaWRzXG4gKi9cbmZ1bmN0aW9uIFN0cmF0ZWd5KGJvdW5kYXJ5KXtcbiAgICB2YXIgREVGQVVMVF9CT1VOREFSWSA9IDEwO1xuICAgIHRoaXMuX2JvdW5kYXJ5ID0gYm91bmRhcnkgfHwgREVGQVVMVF9CT1VOREFSWTtcbn07XG5cbi8qIVxuICogXFxicmllZiBDaG9vc2UgYW4gaWQgc3RhcnRpbmcgZnJvbSBwcmV2aW91cyBib3VuZCBhbmQgYWRkaW5nIHJhbmRvbSBudW1iZXJcbiAqIFxccGFyYW0gcCB0aGUgcHJldmlvdXMgaWRlbnRpZmllclxuICogXFxwYXJhbSBxIHRoZSBuZXh0IGlkZW50aWZpZXJcbiAqIFxccGFyYW0gbGV2ZWwgdGhlIG51bWJlciBvZiBjb25jYXRlbmF0aW9uIGNvbXBvc2luZyB0aGUgbmV3IGlkZW50aWZpZXJcbiAqIFxccGFyYW0gaW50ZXJ2YWwgdGhlIGludGVydmFsIGJldHdlZW4gcCBhbmQgcVxuICogXFxwYXJhbSBzIHRoZSBzb3VyY2UgdGhhdCBjcmVhdGVzIHRoZSBuZXcgaWRlbnRpZmllclxuICogXFxwYXJhbSBjIHRoZSBjb3VudGVyIG9mIHRoYXQgc291cmNlXG4gKi9cblN0cmF0ZWd5LnByb3RvdHlwZS5iUGx1cyA9IGZ1bmN0aW9uIChwLCBxLCBsZXZlbCwgaW50ZXJ2YWwsIHMsIGMpe1xuICAgIHZhciBjb3B5UCA9IHAsIGNvcHlRID0gcSxcbiAgICAgICAgc3RlcCA9IE1hdGgubWluKHRoaXMuX2JvdW5kYXJ5LCBpbnRlcnZhbCksIC8vIzAgdGhlIG1pbiBpbnRlcnZhbFxuICAgICAgICBkaWdpdCA9IEJJLmludDJiaWdJbnQoMCxCYXNlLmdldFN1bUJpdChsZXZlbCkpLFxuICAgICAgICB2YWx1ZTtcbiAgICBcbiAgICAvLyAjMSBjb3B5IHRoZSBwcmV2aW91cyBpZGVudGlmaWVyXG4gICAgZm9yICh2YXIgaSA9IDA7IGk8PWxldmVsOysraSl7XG5cdCAgICAgIHZhbHVlID0gMDtcbiAgICAgICAgaWYgKHAhPT1udWxsKXsgdmFsdWUgPSBwLnQucDsgfTtcbiAgICAgICAgQkkuYWRkSW50XyhkaWdpdCx2YWx1ZSk7XG4gICAgICAgIGlmIChpIT09bGV2ZWwpeyBCSS5sZWZ0U2hpZnRfKGRpZ2l0LEJhc2UuZ2V0Qml0QmFzZShpKzEpKTsgfTtcbiAgICAgICAgaWYgKHAhPT1udWxsICYmIHAuY2hpbGRyZW4ubGVuZ3RoIT09MCl7XG4gICAgICAgICAgICBwID0gcC5jaGlsZHJlblswXTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHAgPSBudWxsO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgLy8gIzIgY3JlYXRlIGEgZGlnaXQgZm9yIGFuIGlkZW50aWZpZXIgYnkgYWRkaW5nIGEgcmFuZG9tIHZhbHVlXG4gICAgLy8gIzJhIERpZ2l0XG4gICAgQkkuYWRkSW50XyhkaWdpdCwgTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKnN0ZXArMSkpO1xuICAgIC8vICMyYiBTb3VyY2UgJiBjb3VudGVyXG4gICAgcmV0dXJuIGdldFNDKGRpZ2l0LCBjb3B5UCwgY29weVEsIGxldmVsLCBzLCBjKTtcbn07XG5cblxuLyohXG4gKiBcXGJyaWVmIENob29zZSBhbiBpZCBzdGFydGluZyBmcm9tIG5leHQgYm91bmQgYW5kIHN1YnN0cmFjdCBhIHJhbmRvbSBudW1iZXJcbiAqIFxccGFyYW0gcCB0aGUgcHJldmlvdXMgaWRlbnRpZmllclxuICogXFxwYXJhbSBxIHRoZSBuZXh0IGlkZW50aWZpZXJcbiAqIFxccGFyYW0gbGV2ZWwgdGhlIG51bWJlciBvZiBjb25jYXRlbmF0aW9uIGNvbXBvc2luZyB0aGUgbmV3IGlkZW50aWZpZXJcbiAqIFxccGFyYW0gaW50ZXJ2YWwgdGhlIGludGVydmFsIGJldHdlZW4gcCBhbmQgcVxuICogXFxwYXJhbSBzIHRoZSBzb3VyY2UgdGhhdCBjcmVhdGVzIHRoZSBuZXcgaWRlbnRpZmllclxuICogXFxwYXJhbSBjIHRoZSBjb3VudGVyIG9mIHRoYXQgc291cmNlXG4gKi9cblN0cmF0ZWd5LnByb3RvdHlwZS5iTWludXMgPSBmdW5jdGlvbiAocCwgcSwgbGV2ZWwsIGludGVydmFsLCBzLCBjKXtcbiAgICB2YXIgY29weVAgPSBwLCBjb3B5USA9IHEsXG4gICAgICAgIHN0ZXAgPSBNYXRoLm1pbih0aGlzLl9ib3VuZGFyeSwgaW50ZXJ2YWwpLCAvLyAjMCBwcm9jZXNzIG1pbiBpbnRlcnZhbFxuICAgICAgICBkaWdpdCA9IEJJLmludDJiaWdJbnQoMCxCYXNlLmdldFN1bUJpdChsZXZlbCkpLFxuICAgICAgICBwSXNHcmVhdGVyID0gZmFsc2UsIGNvbW1vblJvb3QgPSB0cnVlLFxuICAgICAgICBwcmV2VmFsdWUsIG5leHRWYWx1ZTtcbiAgICBcbiAgICAvLyAjMSBjb3B5IG5leHQsIGlmIHByZXZpb3VzIGlzIGdyZWF0ZXIsIGNvcHkgbWF4VmFsdWUgQCBkZXB0aFxuICAgIGZvciAodmFyIGkgPSAwOyBpPD1sZXZlbDsrK2kpe1xuICAgICAgICBwcmV2VmFsdWUgPSAwOyBpZiAocCAhPT0gbnVsbCl7IHByZXZWYWx1ZSA9IHAudC5wOyB9XG4gICAgICAgIG5leHRWYWx1ZSA9IDA7IGlmIChxICE9PSBudWxsKXsgbmV4dFZhbHVlID0gcS50LnA7IH1cbiAgICAgICAgaWYgKGNvbW1vblJvb3QgJiYgcHJldlZhbHVlICE9PSBuZXh0VmFsdWUpe1xuICAgICAgICAgICAgY29tbW9uUm9vdCA9IGZhbHNlO1xuICAgICAgICAgICAgcElzR3JlYXRlciA9IHByZXZWYWx1ZSA+IG5leHRWYWx1ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocElzR3JlYXRlcil7IG5leHRWYWx1ZSA9IE1hdGgucG93KDIsQmFzZS5nZXRCaXRCYXNlKGkpKS0xOyB9XG4gICAgICAgIEJJLmFkZEludF8oZGlnaXQsIG5leHRWYWx1ZSk7XG4gICAgICAgIGlmIChpIT09bGV2ZWwpeyBCSS5sZWZ0U2hpZnRfKGRpZ2l0LEJhc2UuZ2V0Qml0QmFzZShpKzEpKTsgfVxuICAgICAgICBpZiAocSE9PW51bGwgJiYgcS5jaGlsZHJlbi5sZW5ndGghPT0wKXtcbiAgICAgICAgICAgIHEgPSBxLmNoaWxkcmVuWzBdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcSA9IG51bGw7XG4gICAgICAgIH07XG4gICAgICAgIGlmIChwIT09bnVsbCAmJiBwLmNoaWxkcmVuLmxlbmd0aCE9PTApe1xuICAgICAgICAgICAgcCA9IHAuY2hpbGRyZW5bMF07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBwID0gbnVsbDtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIC8vICMzIGNyZWF0ZSBhIGRpZ2l0IGZvciBhbiBpZGVudGlmaWVyIGJ5IHN1YmluZyBhIHJhbmRvbSB2YWx1ZVxuICAgIC8vICMzYSBEaWdpdFxuICAgIGlmIChwSXNHcmVhdGVyKXtcbiAgICAgICAgQkkuYWRkSW50XyhkaWdpdCwgLU1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSpzdGVwKSApO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIEJJLmFkZEludF8oZGlnaXQsIC1NYXRoLmZsb29yKE1hdGgucmFuZG9tKCkqc3RlcCktMSApO1xuICAgIH07XG4gICAgXG4gICAgLy8gIzNiIFNvdXJjZSAmIGNvdW50ZXJcbiAgICByZXR1cm4gZ2V0U0MoZGlnaXQsIGNvcHlQLCBjb3B5USwgbGV2ZWwsIHMsIGMpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNvcGllcyB0aGUgYXBwcm9wcmlhdGVzIHNvdXJjZSBhbmQgY291bnRlciBmcm9tIHRoZSBhZGphY2VudCBcbiAqIGlkZW50aWZpZXJzIGF0IHRoZSBpbnNlcnRpb24gcG9zaXRpb24uXG4gKiBcXHBhcmFtIGQgdGhlIGRpZ2l0IHBhcnQgb2YgdGhlIG5ldyBpZGVudGlmaWVyXG4gKiBcXHBhcmFtIHAgdGhlIHByZXZpb3VzIGlkZW50aWZpZXJcbiAqIFxccGFyYW0gcSB0aGUgbmV4dCBpZGVudGlmaWVyXG4gKiBcXHBhcmFtIGxldmVsIHRoZSBzaXplIG9mIHRoZSBuZXcgaWRlbnRpZmllclxuICogXFxwYXJhbSBzIHRoZSBsb2NhbCBzaXRlIGlkZW50aWZpZXIgXG4gKiBcXHBhcmFtIGMgdGhlIGxvY2FsIG1vbm90b25pYyBjb3VudGVyXG4gKi9cbmZ1bmN0aW9uIGdldFNDKGQsIHAsIHEsIGxldmVsLCBzLCBjKXtcbiAgICB2YXIgc291cmNlcyA9IFtdLCBjb3VudGVycyA9IFtdLFxuICAgICAgICBpID0gMCxcbiAgICAgICAgc3VtQml0ID0gQmFzZS5nZXRTdW1CaXQobGV2ZWwpLFxuICAgICAgICB0ZW1wRGlnaXQsIHZhbHVlO1xuICAgIFxuICAgIHdoaWxlIChpPD1sZXZlbCl7XG4gICAgICAgIHRlbXBEaWdpdCA9IEJJLmR1cChkKTtcbiAgICAgICAgQkkucmlnaHRTaGlmdF8odGVtcERpZ2l0LCBzdW1CaXQgLSBCYXNlLmdldFN1bUJpdChpKSk7XG4gICAgICAgIHZhbHVlID0gQkkubW9kSW50KHRlbXBEaWdpdCxNYXRoLnBvdygyLEJhc2UuZ2V0Qml0QmFzZShpKSkpO1xuICAgICAgICBzb3VyY2VzW2ldPXM7XG4gICAgICAgIGNvdW50ZXJzW2ldPWNcbiAgICAgICAgaWYgKHEhPT1udWxsICYmIHEudC5wPT09dmFsdWUpeyBzb3VyY2VzW2ldPXEudC5zOyBjb3VudGVyc1tpXT1xLnQuY307XG4gICAgICAgIGlmIChwIT09bnVsbCAmJiBwLnQucD09PXZhbHVlKXsgc291cmNlc1tpXT1wLnQuczsgY291bnRlcnNbaV09cC50LmN9O1xuICAgICAgICBpZiAocSE9PW51bGwgJiYgcS5jaGlsZHJlbi5sZW5ndGghPT0wKXtcbiAgICAgICAgICAgIHEgPSBxLmNoaWxkcmVuWzBdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcSA9IG51bGw7XG4gICAgICAgIH07XG4gICAgICAgIGlmIChwIT09bnVsbCAmJiBwLmNoaWxkcmVuLmxlbmd0aCE9PTApe1xuICAgICAgICAgICAgcCA9IHAuY2hpbGRyZW5bMF07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBwID0gbnVsbDtcbiAgICAgICAgfTtcbiAgICAgICAgKytpO1xuICAgIH07XG4gICAgXG4gICAgcmV0dXJuIG5ldyBJRChkLCBzb3VyY2VzLCBjb3VudGVycyk7XG59O1xuXG5TdHJhdGVneS5pbnN0YW5jZSA9IG51bGw7XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oYXJncyl7XG4gICAgaWYgKGFyZ3Mpe1xuICAgICAgICBTdHJhdGVneS5pbnN0YW5jZSA9IG5ldyBTdHJhdGVneShhcmdzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoU3RyYXRlZ3kuaW5zdGFuY2UgPT09IG51bGwpe1xuICAgICAgICAgICAgU3RyYXRlZ3kuaW5zdGFuY2UgPSBuZXcgU3RyYXRlZ3koKTtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIHJldHVybiBTdHJhdGVneS5pbnN0YW5jZTtcbn07XG4iLCJcbi8qIVxuICogXFxicmllZiB0cmlwbGUgdGhhdCBjb250YWlucyBhIDxwYXRoIHNpdGUgY291bnRlcj5cbiAqIFxccGFyYW0gcGF0aCB0aGUgcGFydCBvZiB0aGUgcGF0aCBpbiB0aGUgdHJlZVxuICogXFxwYXJhbSBzaXRlIHRoZSB1bmlxdWUgc2l0ZSBpZGVudGlmaWVyIHRoYXQgY3JlYXRlZCB0aGUgdHJpcGxlXG4gKiBcXHBhcmFtIGNvdW50ZXIgdGhlIGNvdW50ZXIgb2YgdGhlIHNpdGUgd2hlbiBpdCBjcmVhdGVkIHRoZSB0cmlwbGVcbiAqL1xuZnVuY3Rpb24gVHJpcGxlKHBhdGgsIHNpdGUsIGNvdW50ZXIpe1xuICAgIHRoaXMucCA9IHBhdGg7XG4gICAgdGhpcy5zID0gc2l0ZTtcbiAgICB0aGlzLmMgPSBjb3VudGVyO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNvbXBhcmUgdHdvIHRyaXBsZXMgcHJpb3JpdGl6aW5nIHRoZSBwYXRoLCB0aGVuIHNpdGUsIHRoZW4gY291bnRlclxuICogXFxwYXJhbSBvIHRoZSBvdGhlciB0cmlwbGUgdG8gY29tcGFyZVxuICogXFxyZXR1cm4gLTEgaWYgdGhpcyBpcyBsb3dlciB0aGFuIG8sIDEgaWYgdGhpcyBpcyBncmVhdGVyIHRoYW4gbywgMCBvdGhlcndpc2VcbiAqL1xuVHJpcGxlLnByb3RvdHlwZS5jb21wYXJlID0gZnVuY3Rpb24obyl7XG4gICAgaWYgKHRoaXMucyA9PT0gTnVtYmVyLk1BWF9WQUxVRSAmJiB0aGlzLmMgPT09IE51bWJlci5NQVhfVkFMVUUpe1xuICAgICAgICByZXR1cm4gMTtcbiAgICB9O1xuICAgIGlmIChvLnMgPT09IE51bWJlci5NQVhfVkFMVUUgJiYgby5zID09PSBOdW1iZXIuTUFYX1ZBTFVFKXtcbiAgICAgICAgcmV0dXJuIC0xO1xuICAgIH07XG4gICAgXG4gICAgaWYgKHRoaXMucCA8IG8ucCkgeyByZXR1cm4gLTE7fTtcbiAgICBpZiAodGhpcy5wID4gby5wKSB7IHJldHVybiAxIDt9O1xuICAgIGlmICh0aGlzLnMgPCBvLnMpIHsgcmV0dXJuIC0xO307XG4gICAgaWYgKHRoaXMucyA+IG8ucykgeyByZXR1cm4gMSA7fTtcbiAgICBpZiAodGhpcy5jIDwgby5jKSB7IHJldHVybiAtMTt9O1xuICAgIGlmICh0aGlzLmMgPiBvLmMpIHsgcmV0dXJuIDEgO307XG4gICAgcmV0dXJuIDA7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IFRyaXBsZTtcbiIsIlxuZnVuY3Rpb24gYmluYXJ5SW5kZXhPZigpe1xuXG4vKipcbiAqIFxcZnJvbTogW2h0dHBzOi8vZ2lzdC5naXRodWIuY29tL1dvbGZ5ODcvNTczNDUzMF1cbiAqIFBlcmZvcm1zIGEgYmluYXJ5IHNlYXJjaCBvbiB0aGUgaG9zdCBhcnJheS4gVGhpcyBtZXRob2QgY2FuIGVpdGhlciBiZVxuICogaW5qZWN0ZWQgaW50byBBcnJheS5wcm90b3R5cGUgb3IgY2FsbGVkIHdpdGggYSBzcGVjaWZpZWQgc2NvcGUgbGlrZSB0aGlzOlxuICogYmluYXJ5SW5kZXhPZi5jYWxsKHNvbWVBcnJheSwgc2VhcmNoRWxlbWVudCk7XG4gKlxuICpcbiAqIEBwYXJhbSB7Kn0gc2VhcmNoRWxlbWVudCBUaGUgaXRlbSB0byBzZWFyY2ggZm9yIHdpdGhpbiB0aGUgYXJyYXkuXG4gKiBAcmV0dXJuIHtOdW1iZXJ9IFRoZSBpbmRleCBvZiB0aGUgZWxlbWVudCB3aGljaCBkZWZhdWx0cyB0byAtMSB3aGVuIG5vdFxuICogZm91bmQuXG4gKi9cbkFycmF5LnByb3RvdHlwZS5iaW5hcnlJbmRleE9mID0gZnVuY3Rpb24oc2VhcmNoRWxlbWVudCkge1xuICAgIHZhciBtaW5JbmRleCA9IDA7XG4gICAgdmFyIG1heEluZGV4ID0gdGhpcy5sZW5ndGggLSAxO1xuICAgIHZhciBjdXJyZW50SW5kZXg7XG4gICAgdmFyIGN1cnJlbnRFbGVtZW50O1xuXG4gICAgd2hpbGUgKG1pbkluZGV4IDw9IG1heEluZGV4KSB7XG4gICAgICAgIGN1cnJlbnRJbmRleCA9IE1hdGguZmxvb3IoKG1pbkluZGV4ICsgbWF4SW5kZXgpIC8gMik7XG4gICAgICAgIGN1cnJlbnRFbGVtZW50ID0gdGhpc1tjdXJyZW50SW5kZXhdO1xuICAgICAgICBpZiAoY3VycmVudEVsZW1lbnQuY29tcGFyZShzZWFyY2hFbGVtZW50KSA8IDApIHtcbiAgICAgICAgICAgIG1pbkluZGV4ID0gY3VycmVudEluZGV4ICsgMTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIGlmIChjdXJyZW50RWxlbWVudC5jb21wYXJlKHNlYXJjaEVsZW1lbnQpID4gMCkge1xuICAgICAgICAgICAgbWF4SW5kZXggPSBjdXJyZW50SW5kZXggLSAxO1xuICAgICAgICB9XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuIGN1cnJlbnRJbmRleDtcbiAgICAgICAgfVxuICAgIH07XG4gICAgcmV0dXJuIH5tYXhJbmRleDtcbn07XG5cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBiaW5hcnlJbmRleE9mKCk7IiwiLy8gVmpldXg6IEN1c3RvbWl6ZWQgYmlnSW50MnN0ciBhbmQgc3RyMmJpZ0ludCBpbiBvcmRlciB0byBhY2NlcHQgY3VzdG9tIGJhc2UuXG5cbi8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbi8vIEJpZyBJbnRlZ2VyIExpYnJhcnkgdi4gNS40XG4vLyBDcmVhdGVkIDIwMDAsIGxhc3QgbW9kaWZpZWQgMjAwOVxuLy8gTGVlbW9uIEJhaXJkXG4vLyB3d3cubGVlbW9uLmNvbVxuLy9cbi8vIFZlcnNpb24gaGlzdG9yeTpcbi8vIHYgNS40ICAzIE9jdCAyMDA5XG4vLyAgIC0gYWRkZWQgXCJ2YXIgaVwiIHRvIGdyZWF0ZXJTaGlmdCgpIHNvIGkgaXMgbm90IGdsb2JhbC4gKFRoYW5rcyB0byBQ77+9dGVyIFN6YWLvv70gZm9yIGZpbmRpbmcgdGhhdCBidWcpXG4vL1xuLy8gdiA1LjMgIDIxIFNlcCAyMDA5XG4vLyAgIC0gYWRkZWQgcmFuZFByb2JQcmltZShrKSBmb3IgcHJvYmFibGUgcHJpbWVzXG4vLyAgIC0gdW5yb2xsZWQgbG9vcCBpbiBtb250XyAoc2xpZ2h0bHkgZmFzdGVyKVxuLy8gICAtIG1pbGxlclJhYmluIG5vdyB0YWtlcyBhIGJpZ0ludCBwYXJhbWV0ZXIgcmF0aGVyIHRoYW4gYW4gaW50XG4vL1xuLy8gdiA1LjIgIDE1IFNlcCAyMDA5XG4vLyAgIC0gZml4ZWQgY2FwaXRhbGl6YXRpb24gaW4gY2FsbCB0byBpbnQyYmlnSW50IGluIHJhbmRCaWdJbnRcbi8vICAgICAodGhhbmtzIHRvIEVtaWxpIEV2cmlwaWRvdSwgUmVpbmhvbGQgQmVocmluZ2VyLCBhbmQgU2FtdWVsIE1hY2FsZWVzZSBmb3IgZmluZGluZyB0aGF0IGJ1Zylcbi8vXG4vLyB2IDUuMSAgOCBPY3QgMjAwN1xuLy8gICAtIHJlbmFtZWQgaW52ZXJzZU1vZEludF8gdG8gaW52ZXJzZU1vZEludCBzaW5jZSBpdCBkb2Vzbid0IGNoYW5nZSBpdHMgcGFyYW1ldGVyc1xuLy8gICAtIGFkZGVkIGZ1bmN0aW9ucyBHQ0QgYW5kIHJhbmRCaWdJbnQsIHdoaWNoIGNhbGwgR0NEXyBhbmQgcmFuZEJpZ0ludF9cbi8vICAgLSBmaXhlZCBhIGJ1ZyBmb3VuZCBieSBSb2IgVmlzc2VyIChzZWUgY29tbWVudCB3aXRoIGhpcyBuYW1lIGJlbG93KVxuLy8gICAtIGltcHJvdmVkIGNvbW1lbnRzXG4vL1xuLy8gVGhpcyBmaWxlIGlzIHB1YmxpYyBkb21haW4uICAgWW91IGNhbiB1c2UgaXQgZm9yIGFueSBwdXJwb3NlIHdpdGhvdXQgcmVzdHJpY3Rpb24uXG4vLyBJIGRvIG5vdCBndWFyYW50ZWUgdGhhdCBpdCBpcyBjb3JyZWN0LCBzbyB1c2UgaXQgYXQgeW91ciBvd24gcmlzay4gIElmIHlvdSB1c2Vcbi8vIGl0IGZvciBzb21ldGhpbmcgaW50ZXJlc3RpbmcsIEknZCBhcHByZWNpYXRlIGhlYXJpbmcgYWJvdXQgaXQuICBJZiB5b3UgZmluZFxuLy8gYW55IGJ1Z3Mgb3IgbWFrZSBhbnkgaW1wcm92ZW1lbnRzLCBJJ2QgYXBwcmVjaWF0ZSBoZWFyaW5nIGFib3V0IHRob3NlIHRvby5cbi8vIEl0IHdvdWxkIGFsc28gYmUgbmljZSBpZiBteSBuYW1lIGFuZCBVUkwgd2VyZSBsZWZ0IGluIHRoZSBjb21tZW50cy4gIEJ1dCBub25lXG4vLyBvZiB0aGF0IGlzIHJlcXVpcmVkLlxuLy9cbi8vIFRoaXMgY29kZSBkZWZpbmVzIGEgYmlnSW50IGxpYnJhcnkgZm9yIGFyYml0cmFyeS1wcmVjaXNpb24gaW50ZWdlcnMuXG4vLyBBIGJpZ0ludCBpcyBhbiBhcnJheSBvZiBpbnRlZ2VycyBzdG9yaW5nIHRoZSB2YWx1ZSBpbiBjaHVua3Mgb2YgYnBlIGJpdHMsXG4vLyBsaXR0bGUgZW5kaWFuIChidWZmWzBdIGlzIHRoZSBsZWFzdCBzaWduaWZpY2FudCB3b3JkKS5cbi8vIE5lZ2F0aXZlIGJpZ0ludHMgYXJlIHN0b3JlZCB0d28ncyBjb21wbGVtZW50LiAgQWxtb3N0IGFsbCB0aGUgZnVuY3Rpb25zIHRyZWF0XG4vLyBiaWdJbnRzIGFzIG5vbm5lZ2F0aXZlLiAgVGhlIGZldyB0aGF0IHZpZXcgdGhlbSBhcyB0d28ncyBjb21wbGVtZW50IHNheSBzb1xuLy8gaW4gdGhlaXIgY29tbWVudHMuICBTb21lIGZ1bmN0aW9ucyBhc3N1bWUgdGhlaXIgcGFyYW1ldGVycyBoYXZlIGF0IGxlYXN0IG9uZVxuLy8gbGVhZGluZyB6ZXJvIGVsZW1lbnQuIEZ1bmN0aW9ucyB3aXRoIGFuIHVuZGVyc2NvcmUgYXQgdGhlIGVuZCBvZiB0aGUgbmFtZSBwdXRcbi8vIHRoZWlyIGFuc3dlciBpbnRvIG9uZSBvZiB0aGUgYXJyYXlzIHBhc3NlZCBpbiwgYW5kIGhhdmUgdW5wcmVkaWN0YWJsZSBiZWhhdmlvclxuLy8gaW4gY2FzZSBvZiBvdmVyZmxvdywgc28gdGhlIGNhbGxlciBtdXN0IG1ha2Ugc3VyZSB0aGUgYXJyYXlzIGFyZSBiaWcgZW5vdWdoIHRvXG4vLyBob2xkIHRoZSBhbnN3ZXIuICBCdXQgdGhlIGF2ZXJhZ2UgdXNlciBzaG91bGQgbmV2ZXIgaGF2ZSB0byBjYWxsIGFueSBvZiB0aGVcbi8vIHVuZGVyc2NvcmVkIGZ1bmN0aW9ucy4gIEVhY2ggaW1wb3J0YW50IHVuZGVyc2NvcmVkIGZ1bmN0aW9uIGhhcyBhIHdyYXBwZXIgZnVuY3Rpb25cbi8vIG9mIHRoZSBzYW1lIG5hbWUgd2l0aG91dCB0aGUgdW5kZXJzY29yZSB0aGF0IHRha2VzIGNhcmUgb2YgdGhlIGRldGFpbHMgZm9yIHlvdS5cbi8vIEZvciBlYWNoIHVuZGVyc2NvcmVkIGZ1bmN0aW9uIHdoZXJlIGEgcGFyYW1ldGVyIGlzIG1vZGlmaWVkLCB0aGF0IHNhbWUgdmFyaWFibGVcbi8vIG11c3Qgbm90IGJlIHVzZWQgYXMgYW5vdGhlciBhcmd1bWVudCB0b28uICBTbywgeW91IGNhbm5vdCBzcXVhcmUgeCBieSBkb2luZ1xuLy8gbXVsdE1vZF8oeCx4LG4pLiAgWW91IG11c3QgdXNlIHNxdWFyZU1vZF8oeCxuKSBpbnN0ZWFkLCBvciBkbyB5PWR1cCh4KTsgbXVsdE1vZF8oeCx5LG4pLlxuLy8gT3Igc2ltcGx5IHVzZSB0aGUgbXVsdE1vZCh4LHgsbikgZnVuY3Rpb24gd2l0aG91dCB0aGUgdW5kZXJzY29yZSwgd2hlcmVcbi8vIHN1Y2ggaXNzdWVzIG5ldmVyIGFyaXNlLCBiZWNhdXNlIG5vbi11bmRlcnNjb3JlZCBmdW5jdGlvbnMgbmV2ZXIgY2hhbmdlXG4vLyB0aGVpciBwYXJhbWV0ZXJzOyB0aGV5IGFsd2F5cyBhbGxvY2F0ZSBuZXcgbWVtb3J5IGZvciB0aGUgYW5zd2VyIHRoYXQgaXMgcmV0dXJuZWQuXG4vL1xuLy8gVGhlc2UgZnVuY3Rpb25zIGFyZSBkZXNpZ25lZCB0byBhdm9pZCBmcmVxdWVudCBkeW5hbWljIG1lbW9yeSBhbGxvY2F0aW9uIGluIHRoZSBpbm5lciBsb29wLlxuLy8gRm9yIG1vc3QgZnVuY3Rpb25zLCBpZiBpdCBuZWVkcyBhIEJpZ0ludCBhcyBhIGxvY2FsIHZhcmlhYmxlIGl0IHdpbGwgYWN0dWFsbHkgdXNlXG4vLyBhIGdsb2JhbCwgYW5kIHdpbGwgb25seSBhbGxvY2F0ZSB0byBpdCBvbmx5IHdoZW4gaXQncyBub3QgdGhlIHJpZ2h0IHNpemUuICBUaGlzIGVuc3VyZXNcbi8vIHRoYXQgd2hlbiBhIGZ1bmN0aW9uIGlzIGNhbGxlZCByZXBlYXRlZGx5IHdpdGggc2FtZS1zaXplZCBwYXJhbWV0ZXJzLCBpdCBvbmx5IGFsbG9jYXRlc1xuLy8gbWVtb3J5IG9uIHRoZSBmaXJzdCBjYWxsLlxuLy9cbi8vIE5vdGUgdGhhdCBmb3IgY3J5cHRvZ3JhcGhpYyBwdXJwb3NlcywgdGhlIGNhbGxzIHRvIE1hdGgucmFuZG9tKCkgbXVzdFxuLy8gYmUgcmVwbGFjZWQgd2l0aCBjYWxscyB0byBhIGJldHRlciBwc2V1ZG9yYW5kb20gbnVtYmVyIGdlbmVyYXRvci5cbi8vXG4vLyBJbiB0aGUgZm9sbG93aW5nLCBcImJpZ0ludFwiIG1lYW5zIGEgYmlnSW50IHdpdGggYXQgbGVhc3Qgb25lIGxlYWRpbmcgemVybyBlbGVtZW50LFxuLy8gYW5kIFwiaW50ZWdlclwiIG1lYW5zIGEgbm9ubmVnYXRpdmUgaW50ZWdlciBsZXNzIHRoYW4gcmFkaXguICBJbiBzb21lIGNhc2VzLCBpbnRlZ2VyXG4vLyBjYW4gYmUgbmVnYXRpdmUuICBOZWdhdGl2ZSBiaWdJbnRzIGFyZSAycyBjb21wbGVtZW50LlxuLy9cbi8vIFRoZSBmb2xsb3dpbmcgZnVuY3Rpb25zIGRvIG5vdCBtb2RpZnkgdGhlaXIgaW5wdXRzLlxuLy8gVGhvc2UgcmV0dXJuaW5nIGEgYmlnSW50LCBzdHJpbmcsIG9yIEFycmF5IHdpbGwgZHluYW1pY2FsbHkgYWxsb2NhdGUgbWVtb3J5IGZvciB0aGF0IHZhbHVlLlxuLy8gVGhvc2UgcmV0dXJuaW5nIGEgYm9vbGVhbiB3aWxsIHJldHVybiB0aGUgaW50ZWdlciAwIChmYWxzZSkgb3IgMSAodHJ1ZSkuXG4vLyBUaG9zZSByZXR1cm5pbmcgYm9vbGVhbiBvciBpbnQgd2lsbCBub3QgYWxsb2NhdGUgbWVtb3J5IGV4Y2VwdCBwb3NzaWJseSBvbiB0aGUgZmlyc3Rcbi8vIHRpbWUgdGhleSdyZSBjYWxsZWQgd2l0aCBhIGdpdmVuIHBhcmFtZXRlciBzaXplLlxuLy9cbi8vIGJpZ0ludCAgYWRkKHgseSkgICAgICAgICAgICAgICAvL3JldHVybiAoeCt5KSBmb3IgYmlnSW50cyB4IGFuZCB5LlxuLy8gYmlnSW50ICBhZGRJbnQoeCxuKSAgICAgICAgICAgIC8vcmV0dXJuICh4K24pIHdoZXJlIHggaXMgYSBiaWdJbnQgYW5kIG4gaXMgYW4gaW50ZWdlci5cbi8vIHN0cmluZyAgYmlnSW50MnN0cih4LGJhc2UpICAgICAvL3JldHVybiBhIHN0cmluZyBmb3JtIG9mIGJpZ0ludCB4IGluIGEgZ2l2ZW4gYmFzZSwgd2l0aCAyIDw9IGJhc2UgPD0gOTVcbi8vIGludCAgICAgYml0U2l6ZSh4KSAgICAgICAgICAgICAvL3JldHVybiBob3cgbWFueSBiaXRzIGxvbmcgdGhlIGJpZ0ludCB4IGlzLCBub3QgY291bnRpbmcgbGVhZGluZyB6ZXJvc1xuLy8gYmlnSW50ICBkdXAoeCkgICAgICAgICAgICAgICAgIC8vcmV0dXJuIGEgY29weSBvZiBiaWdJbnQgeFxuLy8gYm9vbGVhbiBlcXVhbHMoeCx5KSAgICAgICAgICAgIC8vaXMgdGhlIGJpZ0ludCB4IGVxdWFsIHRvIHRoZSBiaWdpbnQgeT9cbi8vIGJvb2xlYW4gZXF1YWxzSW50KHgseSkgICAgICAgICAvL2lzIGJpZ2ludCB4IGVxdWFsIHRvIGludGVnZXIgeT9cbi8vIGJpZ0ludCAgZXhwYW5kKHgsbikgICAgICAgICAgICAvL3JldHVybiBhIGNvcHkgb2YgeCB3aXRoIGF0IGxlYXN0IG4gZWxlbWVudHMsIGFkZGluZyBsZWFkaW5nIHplcm9zIGlmIG5lZWRlZFxuLy8gQXJyYXkgICBmaW5kUHJpbWVzKG4pICAgICAgICAgIC8vcmV0dXJuIGFycmF5IG9mIGFsbCBwcmltZXMgbGVzcyB0aGFuIGludGVnZXIgblxuLy8gYmlnSW50ICBHQ0QoeCx5KSAgICAgICAgICAgICAgIC8vcmV0dXJuIGdyZWF0ZXN0IGNvbW1vbiBkaXZpc29yIG9mIGJpZ0ludHMgeCBhbmQgeSAoZWFjaCB3aXRoIHNhbWUgbnVtYmVyIG9mIGVsZW1lbnRzKS5cbi8vIGJvb2xlYW4gZ3JlYXRlcih4LHkpICAgICAgICAgICAvL2lzIHg+eT8gICh4IGFuZCB5IGFyZSBub25uZWdhdGl2ZSBiaWdJbnRzKVxuLy8gYm9vbGVhbiBncmVhdGVyU2hpZnQoeCx5LHNoaWZ0KS8vaXMgKHggPDwoc2hpZnQqYnBlKSkgPiB5P1xuLy8gYmlnSW50ICBpbnQyYmlnSW50KHQsbixtKSAgICAgIC8vcmV0dXJuIGEgYmlnSW50IGVxdWFsIHRvIGludGVnZXIgdCwgd2l0aCBhdCBsZWFzdCBuIGJpdHMgYW5kIG0gYXJyYXkgZWxlbWVudHNcbi8vIGJpZ0ludCAgaW52ZXJzZU1vZCh4LG4pICAgICAgICAvL3JldHVybiAoeCoqKC0xKSBtb2QgbikgZm9yIGJpZ0ludHMgeCBhbmQgbi4gIElmIG5vIGludmVyc2UgZXhpc3RzLCBpdCByZXR1cm5zIG51bGxcbi8vIGludCAgICAgaW52ZXJzZU1vZEludCh4LG4pICAgICAvL3JldHVybiB4KiooLTEpIG1vZCBuLCBmb3IgaW50ZWdlcnMgeCBhbmQgbi4gIFJldHVybiAwIGlmIHRoZXJlIGlzIG5vIGludmVyc2Vcbi8vIGJvb2xlYW4gaXNaZXJvKHgpICAgICAgICAgICAgICAvL2lzIHRoZSBiaWdJbnQgeCBlcXVhbCB0byB6ZXJvP1xuLy8gYm9vbGVhbiBtaWxsZXJSYWJpbih4LGIpICAgICAgIC8vZG9lcyBvbmUgcm91bmQgb2YgTWlsbGVyLVJhYmluIGJhc2UgaW50ZWdlciBiIHNheSB0aGF0IGJpZ0ludCB4IGlzIHBvc3NpYmx5IHByaW1lPyAoYiBpcyBiaWdJbnQsIDE8Yjx4KVxuLy8gYm9vbGVhbiBtaWxsZXJSYWJpbkludCh4LGIpICAgIC8vZG9lcyBvbmUgcm91bmQgb2YgTWlsbGVyLVJhYmluIGJhc2UgaW50ZWdlciBiIHNheSB0aGF0IGJpZ0ludCB4IGlzIHBvc3NpYmx5IHByaW1lPyAoYiBpcyBpbnQsICAgIDE8Yjx4KVxuLy8gYmlnSW50ICBtb2QoeCxuKSAgICAgICAgICAgICAgIC8vcmV0dXJuIGEgbmV3IGJpZ0ludCBlcXVhbCB0byAoeCBtb2QgbikgZm9yIGJpZ0ludHMgeCBhbmQgbi5cbi8vIGludCAgICAgbW9kSW50KHgsbikgICAgICAgICAgICAvL3JldHVybiB4IG1vZCBuIGZvciBiaWdJbnQgeCBhbmQgaW50ZWdlciBuLlxuLy8gYmlnSW50ICBtdWx0KHgseSkgICAgICAgICAgICAgIC8vcmV0dXJuIHgqeSBmb3IgYmlnSW50cyB4IGFuZCB5LiBUaGlzIGlzIGZhc3RlciB3aGVuIHk8eC5cbi8vIGJpZ0ludCAgbXVsdE1vZCh4LHksbikgICAgICAgICAvL3JldHVybiAoeCp5IG1vZCBuKSBmb3IgYmlnSW50cyB4LHksbi4gIEZvciBncmVhdGVyIHNwZWVkLCBsZXQgeTx4LlxuLy8gYm9vbGVhbiBuZWdhdGl2ZSh4KSAgICAgICAgICAgIC8vaXMgYmlnSW50IHggbmVnYXRpdmU/XG4vLyBiaWdJbnQgIHBvd01vZCh4LHksbikgICAgICAgICAgLy9yZXR1cm4gKHgqKnkgbW9kIG4pIHdoZXJlIHgseSxuIGFyZSBiaWdJbnRzIGFuZCAqKiBpcyBleHBvbmVudGlhdGlvbi4gIDAqKjA9MS4gRmFzdGVyIGZvciBvZGQgbi5cbi8vIGJpZ0ludCAgcmFuZEJpZ0ludChuLHMpICAgICAgICAvL3JldHVybiBhbiBuLWJpdCByYW5kb20gQmlnSW50IChuPj0xKS4gIElmIHM9MSwgdGhlbiB0aGUgbW9zdCBzaWduaWZpY2FudCBvZiB0aG9zZSBuIGJpdHMgaXMgc2V0IHRvIDEuXG4vLyBiaWdJbnQgIHJhbmRUcnVlUHJpbWUoaykgICAgICAgLy9yZXR1cm4gYSBuZXcsIHJhbmRvbSwgay1iaXQsIHRydWUgcHJpbWUgYmlnSW50IHVzaW5nIE1hdXJlcidzIGFsZ29yaXRobS5cbi8vIGJpZ0ludCAgcmFuZFByb2JQcmltZShrKSAgICAgICAvL3JldHVybiBhIG5ldywgcmFuZG9tLCBrLWJpdCwgcHJvYmFibGUgcHJpbWUgYmlnSW50IChwcm9iYWJpbGl0eSBpdCdzIGNvbXBvc2l0ZSBsZXNzIHRoYW4gMl4tODApLlxuLy8gYmlnSW50ICBzdHIyYmlnSW50KHMsYixuLG0pICAgIC8vcmV0dXJuIGEgYmlnSW50IGZvciBudW1iZXIgcmVwcmVzZW50ZWQgaW4gc3RyaW5nIHMgaW4gYmFzZSBiIHdpdGggYXQgbGVhc3QgbiBiaXRzIGFuZCBtIGFycmF5IGVsZW1lbnRzXG4vLyBiaWdJbnQgIHN1Yih4LHkpICAgICAgICAgICAgICAgLy9yZXR1cm4gKHgteSkgZm9yIGJpZ0ludHMgeCBhbmQgeS4gIE5lZ2F0aXZlIGFuc3dlcnMgd2lsbCBiZSAycyBjb21wbGVtZW50XG4vLyBiaWdJbnQgIHRyaW0oeCxrKSAgICAgICAgICAgICAgLy9yZXR1cm4gYSBjb3B5IG9mIHggd2l0aCBleGFjdGx5IGsgbGVhZGluZyB6ZXJvIGVsZW1lbnRzXG4vL1xuLy9cbi8vIFRoZSBmb2xsb3dpbmcgZnVuY3Rpb25zIGVhY2ggaGF2ZSBhIG5vbi11bmRlcnNjb3JlZCB2ZXJzaW9uLCB3aGljaCBtb3N0IHVzZXJzIHNob3VsZCBjYWxsIGluc3RlYWQuXG4vLyBUaGVzZSBmdW5jdGlvbnMgZWFjaCB3cml0ZSB0byBhIHNpbmdsZSBwYXJhbWV0ZXIsIGFuZCB0aGUgY2FsbGVyIGlzIHJlc3BvbnNpYmxlIGZvciBlbnN1cmluZyB0aGUgYXJyYXlcbi8vIHBhc3NlZCBpbiBpcyBsYXJnZSBlbm91Z2ggdG8gaG9sZCB0aGUgcmVzdWx0LlxuLy9cbi8vIHZvaWQgICAgYWRkSW50Xyh4LG4pICAgICAgICAgIC8vZG8geD14K24gd2hlcmUgeCBpcyBhIGJpZ0ludCBhbmQgbiBpcyBhbiBpbnRlZ2VyXG4vLyB2b2lkICAgIGFkZF8oeCx5KSAgICAgICAgICAgICAvL2RvIHg9eCt5IGZvciBiaWdJbnRzIHggYW5kIHlcbi8vIHZvaWQgICAgY29weV8oeCx5KSAgICAgICAgICAgIC8vZG8geD15IG9uIGJpZ0ludHMgeCBhbmQgeVxuLy8gdm9pZCAgICBjb3B5SW50Xyh4LG4pICAgICAgICAgLy9kbyB4PW4gb24gYmlnSW50IHggYW5kIGludGVnZXIgblxuLy8gdm9pZCAgICBHQ0RfKHgseSkgICAgICAgICAgICAgLy9zZXQgeCB0byB0aGUgZ3JlYXRlc3QgY29tbW9uIGRpdmlzb3Igb2YgYmlnSW50cyB4IGFuZCB5LCAoeSBpcyBkZXN0cm95ZWQpLiAgKFRoaXMgbmV2ZXIgb3ZlcmZsb3dzIGl0cyBhcnJheSkuXG4vLyBib29sZWFuIGludmVyc2VNb2RfKHgsbikgICAgICAvL2RvIHg9eCoqKC0xKSBtb2QgbiwgZm9yIGJpZ0ludHMgeCBhbmQgbi4gUmV0dXJucyAxICgwKSBpZiBpbnZlcnNlIGRvZXMgKGRvZXNuJ3QpIGV4aXN0XG4vLyB2b2lkICAgIG1vZF8oeCxuKSAgICAgICAgICAgICAvL2RvIHg9eCBtb2QgbiBmb3IgYmlnSW50cyB4IGFuZCBuLiAoVGhpcyBuZXZlciBvdmVyZmxvd3MgaXRzIGFycmF5KS5cbi8vIHZvaWQgICAgbXVsdF8oeCx5KSAgICAgICAgICAgIC8vZG8geD14KnkgZm9yIGJpZ0ludHMgeCBhbmQgeS5cbi8vIHZvaWQgICAgbXVsdE1vZF8oeCx5LG4pICAgICAgIC8vZG8geD14KnkgIG1vZCBuIGZvciBiaWdJbnRzIHgseSxuLlxuLy8gdm9pZCAgICBwb3dNb2RfKHgseSxuKSAgICAgICAgLy9kbyB4PXgqKnkgbW9kIG4sIHdoZXJlIHgseSxuIGFyZSBiaWdJbnRzIChuIGlzIG9kZCkgYW5kICoqIGlzIGV4cG9uZW50aWF0aW9uLiAgMCoqMD0xLlxuLy8gdm9pZCAgICByYW5kQmlnSW50XyhiLG4scykgICAgLy9kbyBiID0gYW4gbi1iaXQgcmFuZG9tIEJpZ0ludC4gaWYgcz0xLCB0aGVuIG50aCBiaXQgKG1vc3Qgc2lnbmlmaWNhbnQgYml0KSBpcyBzZXQgdG8gMS4gbj49MS5cbi8vIHZvaWQgICAgcmFuZFRydWVQcmltZV8oYW5zLGspIC8vZG8gYW5zID0gYSByYW5kb20gay1iaXQgdHJ1ZSByYW5kb20gcHJpbWUgKG5vdCBqdXN0IHByb2JhYmxlIHByaW1lKSB3aXRoIDEgaW4gdGhlIG1zYi5cbi8vIHZvaWQgICAgc3ViXyh4LHkpICAgICAgICAgICAgIC8vZG8geD14LXkgZm9yIGJpZ0ludHMgeCBhbmQgeS4gTmVnYXRpdmUgYW5zd2VycyB3aWxsIGJlIDJzIGNvbXBsZW1lbnQuXG4vL1xuLy8gVGhlIGZvbGxvd2luZyBmdW5jdGlvbnMgZG8gTk9UIGhhdmUgYSBub24tdW5kZXJzY29yZWQgdmVyc2lvbi5cbi8vIFRoZXkgZWFjaCB3cml0ZSBhIGJpZ0ludCByZXN1bHQgdG8gb25lIG9yIG1vcmUgcGFyYW1ldGVycy4gIFRoZSBjYWxsZXIgaXMgcmVzcG9uc2libGUgZm9yXG4vLyBlbnN1cmluZyB0aGUgYXJyYXlzIHBhc3NlZCBpbiBhcmUgbGFyZ2UgZW5vdWdoIHRvIGhvbGQgdGhlIHJlc3VsdHMuXG4vL1xuLy8gdm9pZCBhZGRTaGlmdF8oeCx5LHlzKSAgICAgICAvL2RvIHg9eCsoeTw8KHlzKmJwZSkpXG4vLyB2b2lkIGNhcnJ5Xyh4KSAgICAgICAgICAgICAgIC8vZG8gY2FycmllcyBhbmQgYm9ycm93cyBzbyBlYWNoIGVsZW1lbnQgb2YgdGhlIGJpZ0ludCB4IGZpdHMgaW4gYnBlIGJpdHMuXG4vLyB2b2lkIGRpdmlkZV8oeCx5LHEscikgICAgICAgIC8vZGl2aWRlIHggYnkgeSBnaXZpbmcgcXVvdGllbnQgcSBhbmQgcmVtYWluZGVyIHJcbi8vIGludCAgZGl2SW50Xyh4LG4pICAgICAgICAgICAgLy9kbyB4PWZsb29yKHgvbikgZm9yIGJpZ0ludCB4IGFuZCBpbnRlZ2VyIG4sIGFuZCByZXR1cm4gdGhlIHJlbWFpbmRlci4gKFRoaXMgbmV2ZXIgb3ZlcmZsb3dzIGl0cyBhcnJheSkuXG4vLyBpbnQgIGVHQ0RfKHgseSxkLGEsYikgICAgICAgIC8vc2V0cyBhLGIsZCB0byBwb3NpdGl2ZSBiaWdJbnRzIHN1Y2ggdGhhdCBkID0gR0NEXyh4LHkpID0gYSp4LWIqeVxuLy8gdm9pZCBoYWx2ZV8oeCkgICAgICAgICAgICAgICAvL2RvIHg9Zmxvb3IofHh8LzIpKnNnbih4KSBmb3IgYmlnSW50IHggaW4gMidzIGNvbXBsZW1lbnQuICAoVGhpcyBuZXZlciBvdmVyZmxvd3MgaXRzIGFycmF5KS5cbi8vIHZvaWQgbGVmdFNoaWZ0Xyh4LG4pICAgICAgICAgLy9sZWZ0IHNoaWZ0IGJpZ0ludCB4IGJ5IG4gYml0cy4gIG48YnBlLlxuLy8gdm9pZCBsaW5Db21iXyh4LHksYSxiKSAgICAgICAvL2RvIHg9YSp4K2IqeSBmb3IgYmlnSW50cyB4IGFuZCB5IGFuZCBpbnRlZ2VycyBhIGFuZCBiXG4vLyB2b2lkIGxpbkNvbWJTaGlmdF8oeCx5LGIseXMpIC8vZG8geD14K2IqKHk8PCh5cypicGUpKSBmb3IgYmlnSW50cyB4IGFuZCB5LCBhbmQgaW50ZWdlcnMgYiBhbmQgeXNcbi8vIHZvaWQgbW9udF8oeCx5LG4sbnApICAgICAgICAgLy9Nb250Z29tZXJ5IG11bHRpcGxpY2F0aW9uIChzZWUgY29tbWVudHMgd2hlcmUgdGhlIGZ1bmN0aW9uIGlzIGRlZmluZWQpXG4vLyB2b2lkIG11bHRJbnRfKHgsbikgICAgICAgICAgIC8vZG8geD14Km4gd2hlcmUgeCBpcyBhIGJpZ0ludCBhbmQgbiBpcyBhbiBpbnRlZ2VyLlxuLy8gdm9pZCByaWdodFNoaWZ0Xyh4LG4pICAgICAgICAvL3JpZ2h0IHNoaWZ0IGJpZ0ludCB4IGJ5IG4gYml0cy4gIDAgPD0gbiA8IGJwZS4gKFRoaXMgbmV2ZXIgb3ZlcmZsb3dzIGl0cyBhcnJheSkuXG4vLyB2b2lkIHNxdWFyZU1vZF8oeCxuKSAgICAgICAgIC8vZG8geD14KnggIG1vZCBuIGZvciBiaWdJbnRzIHgsblxuLy8gdm9pZCBzdWJTaGlmdF8oeCx5LHlzKSAgICAgICAvL2RvIHg9eC0oeTw8KHlzKmJwZSkpLiBOZWdhdGl2ZSBhbnN3ZXJzIHdpbGwgYmUgMnMgY29tcGxlbWVudC5cbi8vXG4vLyBUaGUgZm9sbG93aW5nIGZ1bmN0aW9ucyBhcmUgYmFzZWQgb24gYWxnb3JpdGhtcyBmcm9tIHRoZSBfSGFuZGJvb2sgb2YgQXBwbGllZCBDcnlwdG9ncmFwaHlfXG4vLyAgICBwb3dNb2RfKCkgICAgICAgICAgID0gYWxnb3JpdGhtIDE0Ljk0LCBNb250Z29tZXJ5IGV4cG9uZW50aWF0aW9uXG4vLyAgICBlR0NEXyxpbnZlcnNlTW9kXygpID0gYWxnb3JpdGhtIDE0LjYxLCBCaW5hcnkgZXh0ZW5kZWQgR0NEX1xuLy8gICAgR0NEXygpICAgICAgICAgICAgICA9IGFsZ29yb3RobSAxNC41NywgTGVobWVyJ3MgYWxnb3JpdGhtXG4vLyAgICBtb250XygpICAgICAgICAgICAgID0gYWxnb3JpdGhtIDE0LjM2LCBNb250Z29tZXJ5IG11bHRpcGxpY2F0aW9uXG4vLyAgICBkaXZpZGVfKCkgICAgICAgICAgID0gYWxnb3JpdGhtIDE0LjIwICBNdWx0aXBsZS1wcmVjaXNpb24gZGl2aXNpb25cbi8vICAgIHNxdWFyZU1vZF8oKSAgICAgICAgPSBhbGdvcml0aG0gMTQuMTYgIE11bHRpcGxlLXByZWNpc2lvbiBzcXVhcmluZ1xuLy8gICAgcmFuZFRydWVQcmltZV8oKSAgICA9IGFsZ29yaXRobSAgNC42MiwgTWF1cmVyJ3MgYWxnb3JpdGhtXG4vLyAgICBtaWxsZXJSYWJpbigpICAgICAgID0gYWxnb3JpdGhtICA0LjI0LCBNaWxsZXItUmFiaW4gYWxnb3JpdGhtXG4vL1xuLy8gUHJvZmlsaW5nIHNob3dzOlxuLy8gICAgIHJhbmRUcnVlUHJpbWVfKCkgc3BlbmRzOlxuLy8gICAgICAgICAxMCUgb2YgaXRzIHRpbWUgaW4gY2FsbHMgdG8gcG93TW9kXygpXG4vLyAgICAgICAgIDg1JSBvZiBpdHMgdGltZSBpbiBjYWxscyB0byBtaWxsZXJSYWJpbigpXG4vLyAgICAgbWlsbGVyUmFiaW4oKSBzcGVuZHM6XG4vLyAgICAgICAgIDk5JSBvZiBpdHMgdGltZSBpbiBjYWxscyB0byBwb3dNb2RfKCkgICAoYWx3YXlzIHdpdGggYSBiYXNlIG9mIDIpXG4vLyAgICAgcG93TW9kXygpIHNwZW5kczpcbi8vICAgICAgICAgOTQlIG9mIGl0cyB0aW1lIGluIGNhbGxzIHRvIG1vbnRfKCkgIChhbG1vc3QgYWx3YXlzIHdpdGggeD09eSlcbi8vXG4vLyBUaGlzIHN1Z2dlc3RzIHRoZXJlIGFyZSBzZXZlcmFsIHdheXMgdG8gc3BlZWQgdXAgdGhpcyBsaWJyYXJ5IHNsaWdodGx5OlxuLy8gICAgIC0gY29udmVydCBwb3dNb2RfIHRvIHVzZSBhIE1vbnRnb21lcnkgZm9ybSBvZiBrLWFyeSB3aW5kb3cgKG9yIG1heWJlIGEgTW9udGdvbWVyeSBmb3JtIG9mIHNsaWRpbmcgd2luZG93KVxuLy8gICAgICAgICAtLSB0aGlzIHNob3VsZCBlc3BlY2lhbGx5IGZvY3VzIG9uIGJlaW5nIGZhc3Qgd2hlbiByYWlzaW5nIDIgdG8gYSBwb3dlciBtb2QgblxuLy8gICAgIC0gY29udmVydCByYW5kVHJ1ZVByaW1lXygpIHRvIHVzZSBhIG1pbmltdW0gciBvZiAxLzMgaW5zdGVhZCBvZiAxLzIgd2l0aCB0aGUgYXBwcm9wcmlhdGUgY2hhbmdlIHRvIHRoZSB0ZXN0XG4vLyAgICAgLSB0dW5lIHRoZSBwYXJhbWV0ZXJzIGluIHJhbmRUcnVlUHJpbWVfKCksIGluY2x1ZGluZyBjLCBtLCBhbmQgcmVjTGltaXRcbi8vICAgICAtIHNwZWVkIHVwIHRoZSBzaW5nbGUgbG9vcCBpbiBtb250XygpIHRoYXQgdGFrZXMgOTUlIG9mIHRoZSBydW50aW1lLCBwZXJoYXBzIGJ5IHJlZHVjaW5nIGNoZWNraW5nXG4vLyAgICAgICB3aXRoaW4gdGhlIGxvb3Agd2hlbiBhbGwgdGhlIHBhcmFtZXRlcnMgYXJlIHRoZSBzYW1lIGxlbmd0aC5cbi8vXG4vLyBUaGVyZSBhcmUgc2V2ZXJhbCBpZGVhcyB0aGF0IGxvb2sgbGlrZSB0aGV5IHdvdWxkbid0IGhlbHAgbXVjaCBhdCBhbGw6XG4vLyAgICAgLSByZXBsYWNpbmcgdHJpYWwgZGl2aXNpb24gaW4gcmFuZFRydWVQcmltZV8oKSB3aXRoIGEgc2lldmUgKHRoYXQgc3BlZWRzIHVwIHNvbWV0aGluZyB0YWtpbmcgYWxtb3N0IG5vIHRpbWUgYW55d2F5KVxuLy8gICAgIC0gaW5jcmVhc2UgYnBlIGZyb20gMTUgdG8gMzAgKHRoYXQgd291bGQgaGVscCBpZiB3ZSBoYWQgYSAzMiozMi0+NjQgbXVsdGlwbGllciwgYnV0IG5vdCB3aXRoIEphdmFTY3JpcHQncyAzMiozMi0+MzIpXG4vLyAgICAgLSBzcGVlZGluZyB1cCBtb250Xyh4LHksbixucCkgd2hlbiB4PT15IGJ5IGRvaW5nIGEgbm9uLW1vZHVsYXIsIG5vbi1Nb250Z29tZXJ5IHNxdWFyZVxuLy8gICAgICAgZm9sbG93ZWQgYnkgYSBNb250Z29tZXJ5IHJlZHVjdGlvbi4gIFRoZSBpbnRlcm1lZGlhdGUgYW5zd2VyIHdpbGwgYmUgdHdpY2UgYXMgbG9uZyBhcyB4LCBzbyB0aGF0XG4vLyAgICAgICBtZXRob2Qgd291bGQgYmUgc2xvd2VyLiAgVGhpcyBpcyB1bmZvcnR1bmF0ZSBiZWNhdXNlIHRoZSBjb2RlIGN1cnJlbnRseSBzcGVuZHMgYWxtb3N0IGFsbCBvZiBpdHMgdGltZVxuLy8gICAgICAgZG9pbmcgbW9udF8oeCx4LC4uLiksIGJvdGggZm9yIHJhbmRUcnVlUHJpbWVfKCkgYW5kIHBvd01vZF8oKS4gIEEgZmFzdGVyIG1ldGhvZCBmb3IgTW9udGdvbWVyeSBzcXVhcmluZ1xuLy8gICAgICAgd291bGQgaGF2ZSBhIGxhcmdlIGltcGFjdCBvbiB0aGUgc3BlZWQgb2YgcmFuZFRydWVQcmltZV8oKSBhbmQgcG93TW9kXygpLiAgSEFDIGhhcyBhIGNvdXBsZSBvZiBwb29ybHktd29yZGVkXG4vLyAgICAgICBzZW50ZW5jZXMgdGhhdCBzZWVtIHRvIGltcGx5IGl0J3MgZmFzdGVyIHRvIGRvIGEgbm9uLW1vZHVsYXIgc3F1YXJlIGZvbGxvd2VkIGJ5IGEgc2luZ2xlXG4vLyAgICAgICBNb250Z29tZXJ5IHJlZHVjdGlvbiwgYnV0IHRoYXQncyBvYnZpb3VzbHkgd3JvbmcuXG4vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG5cbihmdW5jdGlvbiAoKSB7XG4vL2dsb2JhbHNcbmJwZT0wOyAgICAgICAgIC8vYml0cyBzdG9yZWQgcGVyIGFycmF5IGVsZW1lbnRcbm1hc2s9MDsgICAgICAgIC8vQU5EIHRoaXMgd2l0aCBhbiBhcnJheSBlbGVtZW50IHRvIGNob3AgaXQgZG93biB0byBicGUgYml0c1xucmFkaXg9bWFzaysxOyAgLy9lcXVhbHMgMl5icGUuICBBIHNpbmdsZSAxIGJpdCB0byB0aGUgbGVmdCBvZiB0aGUgbGFzdCBiaXQgb2YgbWFzay5cblxuLy90aGUgZGlnaXRzIGZvciBjb252ZXJ0aW5nIHRvIGRpZmZlcmVudCBiYXNlc1xuZGlnaXRzU3RyPScwMTIzNDU2Nzg5QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5el89IUAjJCVeJiooKVtde318OzosLjw+Lz9gfiBcXFxcXFwnXFxcIistJztcblxuLy9pbml0aWFsaXplIHRoZSBnbG9iYWwgdmFyaWFibGVzXG5mb3IgKGJwZT0wOyAoMTw8KGJwZSsxKSkgPiAoMTw8YnBlKTsgYnBlKyspOyAgLy9icGU9bnVtYmVyIG9mIGJpdHMgaW4gdGhlIG1hbnRpc3NhIG9uIHRoaXMgcGxhdGZvcm1cbmJwZT4+PTE7ICAgICAgICAgICAgICAgICAgIC8vYnBlPW51bWJlciBvZiBiaXRzIGluIG9uZSBlbGVtZW50IG9mIHRoZSBhcnJheSByZXByZXNlbnRpbmcgdGhlIGJpZ0ludFxubWFzaz0oMTw8YnBlKS0xOyAgICAgICAgICAgLy9BTkQgdGhlIG1hc2sgd2l0aCBhbiBpbnRlZ2VyIHRvIGdldCBpdHMgYnBlIGxlYXN0IHNpZ25pZmljYW50IGJpdHNcbnJhZGl4PW1hc2srMTsgICAgICAgICAgICAgIC8vMl5icGUuICBhIHNpbmdsZSAxIGJpdCB0byB0aGUgbGVmdCBvZiB0aGUgZmlyc3QgYml0IG9mIG1hc2tcbm9uZT1pbnQyYmlnSW50KDEsMSwxKTsgICAgIC8vY29uc3RhbnQgdXNlZCBpbiBwb3dNb2RfKClcblxuLy90aGUgZm9sbG93aW5nIGdsb2JhbCB2YXJpYWJsZXMgYXJlIHNjcmF0Y2hwYWQgbWVtb3J5IHRvXG4vL3JlZHVjZSBkeW5hbWljIG1lbW9yeSBhbGxvY2F0aW9uIGluIHRoZSBpbm5lciBsb29wXG50PW5ldyBBcnJheSgwKTtcbnNzPXQ7ICAgICAgIC8vdXNlZCBpbiBtdWx0XygpXG5zMD10OyAgICAgICAvL3VzZWQgaW4gbXVsdE1vZF8oKSwgc3F1YXJlTW9kXygpXG5zMT10OyAgICAgICAvL3VzZWQgaW4gcG93TW9kXygpLCBtdWx0TW9kXygpLCBzcXVhcmVNb2RfKClcbnMyPXQ7ICAgICAgIC8vdXNlZCBpbiBwb3dNb2RfKCksIG11bHRNb2RfKClcbnMzPXQ7ICAgICAgIC8vdXNlZCBpbiBwb3dNb2RfKClcbnM0PXQ7IHM1PXQ7IC8vdXNlZCBpbiBtb2RfKClcbnM2PXQ7ICAgICAgIC8vdXNlZCBpbiBiaWdJbnQyc3RyKClcbnM3PXQ7ICAgICAgIC8vdXNlZCBpbiBwb3dNb2RfKClcblQ9dDsgICAgICAgIC8vdXNlZCBpbiBHQ0RfKClcbnNhPXQ7ICAgICAgIC8vdXNlZCBpbiBtb250XygpXG5tcl94MT10OyBtcl9yPXQ7IG1yX2E9dDsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vdXNlZCBpbiBtaWxsZXJSYWJpbigpXG5lZ192PXQ7IGVnX3U9dDsgZWdfQT10OyBlZ19CPXQ7IGVnX0M9dDsgZWdfRD10OyAgICAgICAgICAgICAgIC8vdXNlZCBpbiBlR0NEXygpLCBpbnZlcnNlTW9kXygpXG5tZF9xMT10OyBtZF9xMj10OyBtZF9xMz10OyBtZF9yPXQ7IG1kX3IxPXQ7IG1kX3IyPXQ7IG1kX3R0PXQ7IC8vdXNlZCBpbiBtb2RfKClcblxucHJpbWVzPXQ7IHBvd3M9dDsgc19pPXQ7IHNfaTI9dDsgc19SPXQ7IHNfcm09dDsgc19xPXQ7IHNfbjE9dDtcbiAgc19hPXQ7IHNfcjI9dDsgc19uPXQ7IHNfYj10OyBzX2Q9dDsgc194MT10OyBzX3gyPXQsIHNfYWE9dDsgLy91c2VkIGluIHJhbmRUcnVlUHJpbWVfKClcblxucnBwcmI9dDsgLy91c2VkIGluIHJhbmRQcm9iUHJpbWVSb3VuZHMoKSAod2hpY2ggYWxzbyB1c2VzIFwicHJpbWVzXCIpXG5cbi8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cblxuXG4vL3JldHVybiBhcnJheSBvZiBhbGwgcHJpbWVzIGxlc3MgdGhhbiBpbnRlZ2VyIG5cbmZ1bmN0aW9uIGZpbmRQcmltZXMobikge1xuICB2YXIgaSxzLHAsYW5zO1xuICBzPW5ldyBBcnJheShuKTtcbiAgZm9yIChpPTA7aTxuO2krKylcbiAgICBzW2ldPTA7XG4gIHNbMF09MjtcbiAgcD0wOyAgICAvL2ZpcnN0IHAgZWxlbWVudHMgb2YgcyBhcmUgcHJpbWVzLCB0aGUgcmVzdCBhcmUgYSBzaWV2ZVxuICBmb3IoO3NbcF08bjspIHsgICAgICAgICAgICAgICAgICAvL3NbcF0gaXMgdGhlIHB0aCBwcmltZVxuICAgIGZvcihpPXNbcF0qc1twXTsgaTxuOyBpKz1zW3BdKSAvL21hcmsgbXVsdGlwbGVzIG9mIHNbcF1cbiAgICAgIHNbaV09MTtcbiAgICBwKys7XG4gICAgc1twXT1zW3AtMV0rMTtcbiAgICBmb3IoOyBzW3BdPG4gJiYgc1tzW3BdXTsgc1twXSsrKTsgLy9maW5kIG5leHQgcHJpbWUgKHdoZXJlIHNbcF09PTApXG4gIH1cbiAgYW5zPW5ldyBBcnJheShwKTtcbiAgZm9yKGk9MDtpPHA7aSsrKVxuICAgIGFuc1tpXT1zW2ldO1xuICByZXR1cm4gYW5zO1xufVxuXG5cbi8vZG9lcyBhIHNpbmdsZSByb3VuZCBvZiBNaWxsZXItUmFiaW4gYmFzZSBiIGNvbnNpZGVyIHggdG8gYmUgYSBwb3NzaWJsZSBwcmltZT9cbi8veCBpcyBhIGJpZ0ludCwgYW5kIGIgaXMgYW4gaW50ZWdlciwgd2l0aCBiPHhcbmZ1bmN0aW9uIG1pbGxlclJhYmluSW50KHgsYikge1xuICBpZiAobXJfeDEubGVuZ3RoIT14Lmxlbmd0aCkge1xuICAgIG1yX3gxPWR1cCh4KTtcbiAgICBtcl9yPWR1cCh4KTtcbiAgICBtcl9hPWR1cCh4KTtcbiAgfVxuXG4gIGNvcHlJbnRfKG1yX2EsYik7XG4gIHJldHVybiBtaWxsZXJSYWJpbih4LG1yX2EpO1xufVxuXG4vL2RvZXMgYSBzaW5nbGUgcm91bmQgb2YgTWlsbGVyLVJhYmluIGJhc2UgYiBjb25zaWRlciB4IHRvIGJlIGEgcG9zc2libGUgcHJpbWU/XG4vL3ggYW5kIGIgYXJlIGJpZ0ludHMgd2l0aCBiPHhcbmZ1bmN0aW9uIG1pbGxlclJhYmluKHgsYikge1xuICB2YXIgaSxqLGsscztcblxuICBpZiAobXJfeDEubGVuZ3RoIT14Lmxlbmd0aCkge1xuICAgIG1yX3gxPWR1cCh4KTtcbiAgICBtcl9yPWR1cCh4KTtcbiAgICBtcl9hPWR1cCh4KTtcbiAgfVxuXG4gIGNvcHlfKG1yX2EsYik7XG4gIGNvcHlfKG1yX3IseCk7XG4gIGNvcHlfKG1yX3gxLHgpO1xuXG4gIGFkZEludF8obXJfciwtMSk7XG4gIGFkZEludF8obXJfeDEsLTEpO1xuXG4gIC8vcz10aGUgaGlnaGVzdCBwb3dlciBvZiB0d28gdGhhdCBkaXZpZGVzIG1yX3JcbiAgaz0wO1xuICBmb3IgKGk9MDtpPG1yX3IubGVuZ3RoO2krKylcbiAgICBmb3IgKGo9MTtqPG1hc2s7ajw8PTEpXG4gICAgICBpZiAoeFtpXSAmIGopIHtcbiAgICAgICAgcz0oazxtcl9yLmxlbmd0aCticGUgPyBrIDogMCk7XG4gICAgICAgICBpPW1yX3IubGVuZ3RoO1xuICAgICAgICAgaj1tYXNrO1xuICAgICAgfSBlbHNlXG4gICAgICAgIGsrKztcblxuICBpZiAocylcbiAgICByaWdodFNoaWZ0Xyhtcl9yLHMpO1xuXG4gIHBvd01vZF8obXJfYSxtcl9yLHgpO1xuXG4gIGlmICghZXF1YWxzSW50KG1yX2EsMSkgJiYgIWVxdWFscyhtcl9hLG1yX3gxKSkge1xuICAgIGo9MTtcbiAgICB3aGlsZSAoajw9cy0xICYmICFlcXVhbHMobXJfYSxtcl94MSkpIHtcbiAgICAgIHNxdWFyZU1vZF8obXJfYSx4KTtcbiAgICAgIGlmIChlcXVhbHNJbnQobXJfYSwxKSkge1xuICAgICAgICByZXR1cm4gMDtcbiAgICAgIH1cbiAgICAgIGorKztcbiAgICB9XG4gICAgaWYgKCFlcXVhbHMobXJfYSxtcl94MSkpIHtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgfVxuICByZXR1cm4gMTtcbn1cblxuLy9yZXR1cm5zIGhvdyBtYW55IGJpdHMgbG9uZyB0aGUgYmlnSW50IGlzLCBub3QgY291bnRpbmcgbGVhZGluZyB6ZXJvcy5cbmZ1bmN0aW9uIGJpdFNpemUoeCkge1xuICB2YXIgaix6LHc7XG4gIGZvciAoaj14Lmxlbmd0aC0xOyAoeFtqXT09MCkgJiYgKGo+MCk7IGotLSk7XG4gIGZvciAoej0wLHc9eFtqXTsgdzsgKHc+Pj0xKSx6KyspO1xuICB6Kz1icGUqajtcbiAgcmV0dXJuIHo7XG59XG5cbi8vcmV0dXJuIGEgY29weSBvZiB4IHdpdGggYXQgbGVhc3QgbiBlbGVtZW50cywgYWRkaW5nIGxlYWRpbmcgemVyb3MgaWYgbmVlZGVkXG5mdW5jdGlvbiBleHBhbmQoeCxuKSB7XG4gIHZhciBhbnM9aW50MmJpZ0ludCgwLCh4Lmxlbmd0aD5uID8geC5sZW5ndGggOiBuKSpicGUsMCk7XG4gIGNvcHlfKGFucyx4KTtcbiAgcmV0dXJuIGFucztcbn1cblxuLy9yZXR1cm4gYSBrLWJpdCB0cnVlIHJhbmRvbSBwcmltZSB1c2luZyBNYXVyZXIncyBhbGdvcml0aG0uXG5mdW5jdGlvbiByYW5kVHJ1ZVByaW1lKGspIHtcbiAgdmFyIGFucz1pbnQyYmlnSW50KDAsaywwKTtcbiAgcmFuZFRydWVQcmltZV8oYW5zLGspO1xuICByZXR1cm4gdHJpbShhbnMsMSk7XG59XG5cbi8vcmV0dXJuIGEgay1iaXQgcmFuZG9tIHByb2JhYmxlIHByaW1lIHdpdGggcHJvYmFiaWxpdHkgb2YgZXJyb3IgPCAyXi04MFxuZnVuY3Rpb24gcmFuZFByb2JQcmltZShrKSB7XG4gIGlmIChrPj02MDApIHJldHVybiByYW5kUHJvYlByaW1lUm91bmRzKGssMik7IC8vbnVtYmVycyBmcm9tIEhBQyB0YWJsZSA0LjNcbiAgaWYgKGs+PTU1MCkgcmV0dXJuIHJhbmRQcm9iUHJpbWVSb3VuZHMoayw0KTtcbiAgaWYgKGs+PTUwMCkgcmV0dXJuIHJhbmRQcm9iUHJpbWVSb3VuZHMoayw1KTtcbiAgaWYgKGs+PTQwMCkgcmV0dXJuIHJhbmRQcm9iUHJpbWVSb3VuZHMoayw2KTtcbiAgaWYgKGs+PTM1MCkgcmV0dXJuIHJhbmRQcm9iUHJpbWVSb3VuZHMoayw3KTtcbiAgaWYgKGs+PTMwMCkgcmV0dXJuIHJhbmRQcm9iUHJpbWVSb3VuZHMoayw5KTtcbiAgaWYgKGs+PTI1MCkgcmV0dXJuIHJhbmRQcm9iUHJpbWVSb3VuZHMoaywxMik7IC8vbnVtYmVycyBmcm9tIEhBQyB0YWJsZSA0LjRcbiAgaWYgKGs+PTIwMCkgcmV0dXJuIHJhbmRQcm9iUHJpbWVSb3VuZHMoaywxNSk7XG4gIGlmIChrPj0xNTApIHJldHVybiByYW5kUHJvYlByaW1lUm91bmRzKGssMTgpO1xuICBpZiAoaz49MTAwKSByZXR1cm4gcmFuZFByb2JQcmltZVJvdW5kcyhrLDI3KTtcbiAgICAgICAgICAgICAgcmV0dXJuIHJhbmRQcm9iUHJpbWVSb3VuZHMoayw0MCk7IC8vbnVtYmVyIGZyb20gSEFDIHJlbWFyayA0LjI2IChvbmx5IGFuIGVzdGltYXRlKVxufVxuXG4vL3JldHVybiBhIGstYml0IHByb2JhYmxlIHJhbmRvbSBwcmltZSB1c2luZyBuIHJvdW5kcyBvZiBNaWxsZXIgUmFiaW4gKGFmdGVyIHRyaWFsIGRpdmlzaW9uIHdpdGggc21hbGwgcHJpbWVzKVxuZnVuY3Rpb24gcmFuZFByb2JQcmltZVJvdW5kcyhrLG4pIHtcbiAgdmFyIGFucywgaSwgZGl2aXNpYmxlLCBCO1xuICBCPTMwMDAwOyAgLy9CIGlzIGxhcmdlc3QgcHJpbWUgdG8gdXNlIGluIHRyaWFsIGRpdmlzaW9uXG4gIGFucz1pbnQyYmlnSW50KDAsaywwKTtcblxuICAvL29wdGltaXphdGlvbjogdHJ5IGxhcmdlciBhbmQgc21hbGxlciBCIHRvIGZpbmQgdGhlIGJlc3QgbGltaXQuXG5cbiAgaWYgKHByaW1lcy5sZW5ndGg9PTApXG4gICAgcHJpbWVzPWZpbmRQcmltZXMoMzAwMDApOyAgLy9jaGVjayBmb3IgZGl2aXNpYmlsaXR5IGJ5IHByaW1lcyA8PTMwMDAwXG5cbiAgaWYgKHJwcHJiLmxlbmd0aCE9YW5zLmxlbmd0aClcbiAgICBycHByYj1kdXAoYW5zKTtcblxuICBmb3IgKDs7KSB7IC8va2VlcCB0cnlpbmcgcmFuZG9tIHZhbHVlcyBmb3IgYW5zIHVudGlsIG9uZSBhcHBlYXJzIHRvIGJlIHByaW1lXG4gICAgLy9vcHRpbWl6YXRpb246IHBpY2sgYSByYW5kb20gbnVtYmVyIHRpbWVzIEw9MiozKjUqLi4uKnAsIHBsdXMgYVxuICAgIC8vICAgcmFuZG9tIGVsZW1lbnQgb2YgdGhlIGxpc3Qgb2YgYWxsIG51bWJlcnMgaW4gWzAsTCkgbm90IGRpdmlzaWJsZSBieSBhbnkgcHJpbWUgdXAgdG8gcC5cbiAgICAvLyAgIFRoaXMgY2FuIHJlZHVjZSB0aGUgYW1vdW50IG9mIHJhbmRvbSBudW1iZXIgZ2VuZXJhdGlvbi5cblxuICAgIHJhbmRCaWdJbnRfKGFucyxrLDApOyAvL2FucyA9IGEgcmFuZG9tIG9kZCBudW1iZXIgdG8gY2hlY2tcbiAgICBhbnNbMF0gfD0gMTtcbiAgICBkaXZpc2libGU9MDtcblxuICAgIC8vY2hlY2sgYW5zIGZvciBkaXZpc2liaWxpdHkgYnkgc21hbGwgcHJpbWVzIHVwIHRvIEJcbiAgICBmb3IgKGk9MDsgKGk8cHJpbWVzLmxlbmd0aCkgJiYgKHByaW1lc1tpXTw9Qik7IGkrKylcbiAgICAgIGlmIChtb2RJbnQoYW5zLHByaW1lc1tpXSk9PTAgJiYgIWVxdWFsc0ludChhbnMscHJpbWVzW2ldKSkge1xuICAgICAgICBkaXZpc2libGU9MTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAvL29wdGltaXphdGlvbjogY2hhbmdlIG1pbGxlclJhYmluIHNvIHRoZSBiYXNlIGNhbiBiZSBiaWdnZXIgdGhhbiB0aGUgbnVtYmVyIGJlaW5nIGNoZWNrZWQsIHRoZW4gZWxpbWluYXRlIHRoZSB3aGlsZSBoZXJlLlxuXG4gICAgLy9kbyBuIHJvdW5kcyBvZiBNaWxsZXIgUmFiaW4sIHdpdGggcmFuZG9tIGJhc2VzIGxlc3MgdGhhbiBhbnNcbiAgICBmb3IgKGk9MDsgaTxuICYmICFkaXZpc2libGU7IGkrKykge1xuICAgICAgcmFuZEJpZ0ludF8ocnBwcmIsaywwKTtcbiAgICAgIHdoaWxlKCFncmVhdGVyKGFucyxycHByYikpIC8vcGljayBhIHJhbmRvbSBycHByYiB0aGF0J3MgPCBhbnNcbiAgICAgICAgcmFuZEJpZ0ludF8ocnBwcmIsaywwKTtcbiAgICAgIGlmICghbWlsbGVyUmFiaW4oYW5zLHJwcHJiKSlcbiAgICAgICAgZGl2aXNpYmxlPTE7XG4gICAgfVxuXG4gICAgaWYoIWRpdmlzaWJsZSlcbiAgICAgIHJldHVybiBhbnM7XG4gIH1cbn1cblxuLy9yZXR1cm4gYSBuZXcgYmlnSW50IGVxdWFsIHRvICh4IG1vZCBuKSBmb3IgYmlnSW50cyB4IGFuZCBuLlxuZnVuY3Rpb24gbW9kKHgsbikge1xuICB2YXIgYW5zPWR1cCh4KTtcbiAgbW9kXyhhbnMsbik7XG4gIHJldHVybiB0cmltKGFucywxKTtcbn1cblxuLy9yZXR1cm4gKHgrbikgd2hlcmUgeCBpcyBhIGJpZ0ludCBhbmQgbiBpcyBhbiBpbnRlZ2VyLlxuZnVuY3Rpb24gYWRkSW50KHgsbikge1xuICB2YXIgYW5zPWV4cGFuZCh4LHgubGVuZ3RoKzEpO1xuICBhZGRJbnRfKGFucyxuKTtcbiAgcmV0dXJuIHRyaW0oYW5zLDEpO1xufVxuXG4vL3JldHVybiB4KnkgZm9yIGJpZ0ludHMgeCBhbmQgeS4gVGhpcyBpcyBmYXN0ZXIgd2hlbiB5PHguXG5mdW5jdGlvbiBtdWx0KHgseSkge1xuICB2YXIgYW5zPWV4cGFuZCh4LHgubGVuZ3RoK3kubGVuZ3RoKTtcbiAgbXVsdF8oYW5zLHkpO1xuICByZXR1cm4gdHJpbShhbnMsMSk7XG59XG5cbi8vcmV0dXJuICh4Kip5IG1vZCBuKSB3aGVyZSB4LHksbiBhcmUgYmlnSW50cyBhbmQgKiogaXMgZXhwb25lbnRpYXRpb24uICAwKiowPTEuIEZhc3RlciBmb3Igb2RkIG4uXG5mdW5jdGlvbiBwb3dNb2QoeCx5LG4pIHtcbiAgdmFyIGFucz1leHBhbmQoeCxuLmxlbmd0aCk7XG4gIHBvd01vZF8oYW5zLHRyaW0oeSwyKSx0cmltKG4sMiksMCk7ICAvL3RoaXMgc2hvdWxkIHdvcmsgd2l0aG91dCB0aGUgdHJpbSwgYnV0IGRvZXNuJ3RcbiAgcmV0dXJuIHRyaW0oYW5zLDEpO1xufVxuXG4vL3JldHVybiAoeC15KSBmb3IgYmlnSW50cyB4IGFuZCB5LiAgTmVnYXRpdmUgYW5zd2VycyB3aWxsIGJlIDJzIGNvbXBsZW1lbnRcbmZ1bmN0aW9uIHN1Yih4LHkpIHtcbiAgdmFyIGFucz1leHBhbmQoeCwoeC5sZW5ndGg+eS5sZW5ndGggPyB4Lmxlbmd0aCsxIDogeS5sZW5ndGgrMSkpO1xuICBzdWJfKGFucyx5KTtcbiAgcmV0dXJuIHRyaW0oYW5zLDEpO1xufVxuXG4vL3JldHVybiAoeCt5KSBmb3IgYmlnSW50cyB4IGFuZCB5LlxuZnVuY3Rpb24gYWRkKHgseSkge1xuICB2YXIgYW5zPWV4cGFuZCh4LCh4Lmxlbmd0aD55Lmxlbmd0aCA/IHgubGVuZ3RoKzEgOiB5Lmxlbmd0aCsxKSk7XG4gIGFkZF8oYW5zLHkpO1xuICByZXR1cm4gdHJpbShhbnMsMSk7XG59XG5cbi8vcmV0dXJuICh4KiooLTEpIG1vZCBuKSBmb3IgYmlnSW50cyB4IGFuZCBuLiAgSWYgbm8gaW52ZXJzZSBleGlzdHMsIGl0IHJldHVybnMgbnVsbFxuZnVuY3Rpb24gaW52ZXJzZU1vZCh4LG4pIHtcbiAgdmFyIGFucz1leHBhbmQoeCxuLmxlbmd0aCk7XG4gIHZhciBzO1xuICBzPWludmVyc2VNb2RfKGFucyxuKTtcbiAgcmV0dXJuIHMgPyB0cmltKGFucywxKSA6IG51bGw7XG59XG5cbi8vcmV0dXJuICh4KnkgbW9kIG4pIGZvciBiaWdJbnRzIHgseSxuLiAgRm9yIGdyZWF0ZXIgc3BlZWQsIGxldCB5PHguXG5mdW5jdGlvbiBtdWx0TW9kKHgseSxuKSB7XG4gIHZhciBhbnM9ZXhwYW5kKHgsbi5sZW5ndGgpO1xuICBtdWx0TW9kXyhhbnMseSxuKTtcbiAgcmV0dXJuIHRyaW0oYW5zLDEpO1xufVxuXG4vL2dlbmVyYXRlIGEgay1iaXQgdHJ1ZSByYW5kb20gcHJpbWUgdXNpbmcgTWF1cmVyJ3MgYWxnb3JpdGhtLFxuLy9hbmQgcHV0IGl0IGludG8gYW5zLiAgVGhlIGJpZ0ludCBhbnMgbXVzdCBiZSBsYXJnZSBlbm91Z2ggdG8gaG9sZCBpdC5cbmZ1bmN0aW9uIHJhbmRUcnVlUHJpbWVfKGFucyxrKSB7XG4gIHZhciBjLG0scG0sZGQsaixyLEIsZGl2aXNpYmxlLHosenoscmVjU2l6ZTtcblxuICBpZiAocHJpbWVzLmxlbmd0aD09MClcbiAgICBwcmltZXM9ZmluZFByaW1lcygzMDAwMCk7ICAvL2NoZWNrIGZvciBkaXZpc2liaWxpdHkgYnkgcHJpbWVzIDw9MzAwMDBcblxuICBpZiAocG93cy5sZW5ndGg9PTApIHtcbiAgICBwb3dzPW5ldyBBcnJheSg1MTIpO1xuICAgIGZvciAoaj0wO2o8NTEyO2orKykge1xuICAgICAgcG93c1tqXT1NYXRoLnBvdygyLGovNTExLi0xLik7XG4gICAgfVxuICB9XG5cbiAgLy9jIGFuZCBtIHNob3VsZCBiZSB0dW5lZCBmb3IgYSBwYXJ0aWN1bGFyIG1hY2hpbmUgYW5kIHZhbHVlIG9mIGssIHRvIG1heGltaXplIHNwZWVkXG4gIGM9MC4xOyAgLy9jPTAuMSBpbiBIQUNcbiAgbT0yMDsgICAvL2dlbmVyYXRlIHRoaXMgay1iaXQgbnVtYmVyIGJ5IGZpcnN0IHJlY3Vyc2l2ZWx5IGdlbmVyYXRpbmcgYSBudW1iZXIgdGhhdCBoYXMgYmV0d2VlbiBrLzIgYW5kIGstbSBiaXRzXG4gIHJlY0xpbWl0PTIwOyAvL3N0b3AgcmVjdXJzaW9uIHdoZW4gayA8PXJlY0xpbWl0LiAgTXVzdCBoYXZlIHJlY0xpbWl0ID49IDJcblxuICBpZiAoc19pMi5sZW5ndGghPWFucy5sZW5ndGgpIHtcbiAgICBzX2kyPWR1cChhbnMpO1xuICAgIHNfUiA9ZHVwKGFucyk7XG4gICAgc19uMT1kdXAoYW5zKTtcbiAgICBzX3IyPWR1cChhbnMpO1xuICAgIHNfZCA9ZHVwKGFucyk7XG4gICAgc194MT1kdXAoYW5zKTtcbiAgICBzX3gyPWR1cChhbnMpO1xuICAgIHNfYiA9ZHVwKGFucyk7XG4gICAgc19uID1kdXAoYW5zKTtcbiAgICBzX2kgPWR1cChhbnMpO1xuICAgIHNfcm09ZHVwKGFucyk7XG4gICAgc19xID1kdXAoYW5zKTtcbiAgICBzX2EgPWR1cChhbnMpO1xuICAgIHNfYWE9ZHVwKGFucyk7XG4gIH1cblxuICBpZiAoayA8PSByZWNMaW1pdCkgeyAgLy9nZW5lcmF0ZSBzbWFsbCByYW5kb20gcHJpbWVzIGJ5IHRyaWFsIGRpdmlzaW9uIHVwIHRvIGl0cyBzcXVhcmUgcm9vdFxuICAgIHBtPSgxPDwoKGsrMik+PjEpKS0xOyAvL3BtIGlzIGJpbmFyeSBudW1iZXIgd2l0aCBhbGwgb25lcywganVzdCBvdmVyIHNxcnQoMl5rKVxuICAgIGNvcHlJbnRfKGFucywwKTtcbiAgICBmb3IgKGRkPTE7ZGQ7KSB7XG4gICAgICBkZD0wO1xuICAgICAgYW5zWzBdPSAxIHwgKDE8PChrLTEpKSB8IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSooMTw8aykpOyAgLy9yYW5kb20sIGstYml0LCBvZGQgaW50ZWdlciwgd2l0aCBtc2IgMVxuICAgICAgZm9yIChqPTE7KGo8cHJpbWVzLmxlbmd0aCkgJiYgKChwcmltZXNbal0mcG0pPT1wcmltZXNbal0pO2orKykgeyAvL3RyaWFsIGRpdmlzaW9uIGJ5IGFsbCBwcmltZXMgMy4uLnNxcnQoMl5rKVxuICAgICAgICBpZiAoMD09KGFuc1swXSVwcmltZXNbal0pKSB7XG4gICAgICAgICAgZGQ9MTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBjYXJyeV8oYW5zKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBCPWMqayprOyAgICAvL3RyeSBzbWFsbCBwcmltZXMgdXAgdG8gQiAob3IgYWxsIHRoZSBwcmltZXNbXSBhcnJheSBpZiB0aGUgbGFyZ2VzdCBpcyBsZXNzIHRoYW4gQikuXG4gIGlmIChrPjIqbSkgIC8vZ2VuZXJhdGUgdGhpcyBrLWJpdCBudW1iZXIgYnkgZmlyc3QgcmVjdXJzaXZlbHkgZ2VuZXJhdGluZyBhIG51bWJlciB0aGF0IGhhcyBiZXR3ZWVuIGsvMiBhbmQgay1tIGJpdHNcbiAgICBmb3IgKHI9MTsgay1rKnI8PW07IClcbiAgICAgIHI9cG93c1tNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkqNTEyKV07ICAgLy9yPU1hdGgucG93KDIsTWF0aC5yYW5kb20oKS0xKTtcbiAgZWxzZVxuICAgIHI9LjU7XG5cbiAgLy9zaW11bGF0aW9uIHN1Z2dlc3RzIHRoZSBtb3JlIGNvbXBsZXggYWxnb3JpdGhtIHVzaW5nIHI9LjMzMyBpcyBvbmx5IHNsaWdodGx5IGZhc3Rlci5cblxuICByZWNTaXplPU1hdGguZmxvb3IociprKSsxO1xuXG4gIHJhbmRUcnVlUHJpbWVfKHNfcSxyZWNTaXplKTtcbiAgY29weUludF8oc19pMiwwKTtcbiAgc19pMltNYXRoLmZsb29yKChrLTIpL2JwZSldIHw9ICgxPDwoKGstMiklYnBlKSk7ICAgLy9zX2kyPTJeKGstMilcbiAgZGl2aWRlXyhzX2kyLHNfcSxzX2ksc19ybSk7ICAgICAgICAgICAgICAgICAgICAgICAgLy9zX2k9Zmxvb3IoKDJeKGstMSkpLygycSkpXG5cbiAgej1iaXRTaXplKHNfaSk7XG5cbiAgZm9yICg7Oykge1xuICAgIGZvciAoOzspIHsgIC8vZ2VuZXJhdGUgei1iaXQgbnVtYmVycyB1bnRpbCBvbmUgZmFsbHMgaW4gdGhlIHJhbmdlIFswLHNfaS0xXVxuICAgICAgcmFuZEJpZ0ludF8oc19SLHosMCk7XG4gICAgICBpZiAoZ3JlYXRlcihzX2ksc19SKSlcbiAgICAgICAgYnJlYWs7XG4gICAgfSAgICAgICAgICAgICAgICAvL25vdyBzX1IgaXMgaW4gdGhlIHJhbmdlIFswLHNfaS0xXVxuICAgIGFkZEludF8oc19SLDEpOyAgLy9ub3cgc19SIGlzIGluIHRoZSByYW5nZSBbMSxzX2ldXG4gICAgYWRkXyhzX1Isc19pKTsgICAvL25vdyBzX1IgaXMgaW4gdGhlIHJhbmdlIFtzX2krMSwyKnNfaV1cblxuICAgIGNvcHlfKHNfbixzX3EpO1xuICAgIG11bHRfKHNfbixzX1IpO1xuICAgIG11bHRJbnRfKHNfbiwyKTtcbiAgICBhZGRJbnRfKHNfbiwxKTsgICAgLy9zX249MipzX1Iqc19xKzFcblxuICAgIGNvcHlfKHNfcjIsc19SKTtcbiAgICBtdWx0SW50XyhzX3IyLDIpOyAgLy9zX3IyPTIqc19SXG5cbiAgICAvL2NoZWNrIHNfbiBmb3IgZGl2aXNpYmlsaXR5IGJ5IHNtYWxsIHByaW1lcyB1cCB0byBCXG4gICAgZm9yIChkaXZpc2libGU9MCxqPTA7IChqPHByaW1lcy5sZW5ndGgpICYmIChwcmltZXNbal08Qik7IGorKylcbiAgICAgIGlmIChtb2RJbnQoc19uLHByaW1lc1tqXSk9PTAgJiYgIWVxdWFsc0ludChzX24scHJpbWVzW2pdKSkge1xuICAgICAgICBkaXZpc2libGU9MTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICBpZiAoIWRpdmlzaWJsZSkgICAgLy9pZiBpdCBwYXNzZXMgc21hbGwgcHJpbWVzIGNoZWNrLCB0aGVuIHRyeSBhIHNpbmdsZSBNaWxsZXItUmFiaW4gYmFzZSAyXG4gICAgICBpZiAoIW1pbGxlclJhYmluSW50KHNfbiwyKSkgLy90aGlzIGxpbmUgcmVwcmVzZW50cyA3NSUgb2YgdGhlIHRvdGFsIHJ1bnRpbWUgZm9yIHJhbmRUcnVlUHJpbWVfXG4gICAgICAgIGRpdmlzaWJsZT0xO1xuXG4gICAgaWYgKCFkaXZpc2libGUpIHsgIC8vaWYgaXQgcGFzc2VzIHRoYXQgdGVzdCwgY29udGludWUgY2hlY2tpbmcgc19uXG4gICAgICBhZGRJbnRfKHNfbiwtMyk7XG4gICAgICBmb3IgKGo9c19uLmxlbmd0aC0xOyhzX25bal09PTApICYmIChqPjApOyBqLS0pOyAgLy9zdHJpcCBsZWFkaW5nIHplcm9zXG4gICAgICBmb3IgKHp6PTAsdz1zX25bal07IHc7ICh3Pj49MSksenorKyk7XG4gICAgICB6eis9YnBlKmo7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL3p6PW51bWJlciBvZiBiaXRzIGluIHNfbiwgaWdub3JpbmcgbGVhZGluZyB6ZXJvc1xuICAgICAgZm9yICg7OykgeyAgLy9nZW5lcmF0ZSB6LWJpdCBudW1iZXJzIHVudGlsIG9uZSBmYWxscyBpbiB0aGUgcmFuZ2UgWzAsc19uLTFdXG4gICAgICAgIHJhbmRCaWdJbnRfKHNfYSx6eiwwKTtcbiAgICAgICAgaWYgKGdyZWF0ZXIoc19uLHNfYSkpXG4gICAgICAgICAgYnJlYWs7XG4gICAgICB9ICAgICAgICAgICAgICAgIC8vbm93IHNfYSBpcyBpbiB0aGUgcmFuZ2UgWzAsc19uLTFdXG4gICAgICBhZGRJbnRfKHNfbiwzKTsgIC8vbm93IHNfYSBpcyBpbiB0aGUgcmFuZ2UgWzAsc19uLTRdXG4gICAgICBhZGRJbnRfKHNfYSwyKTsgIC8vbm93IHNfYSBpcyBpbiB0aGUgcmFuZ2UgWzIsc19uLTJdXG4gICAgICBjb3B5XyhzX2Isc19hKTtcbiAgICAgIGNvcHlfKHNfbjEsc19uKTtcbiAgICAgIGFkZEludF8oc19uMSwtMSk7XG4gICAgICBwb3dNb2RfKHNfYixzX24xLHNfbik7ICAgLy9zX2I9c19hXihzX24tMSkgbW9kdWxvIHNfblxuICAgICAgYWRkSW50XyhzX2IsLTEpO1xuICAgICAgaWYgKGlzWmVybyhzX2IpKSB7XG4gICAgICAgIGNvcHlfKHNfYixzX2EpO1xuICAgICAgICBwb3dNb2RfKHNfYixzX3IyLHNfbik7XG4gICAgICAgIGFkZEludF8oc19iLC0xKTtcbiAgICAgICAgY29weV8oc19hYSxzX24pO1xuICAgICAgICBjb3B5XyhzX2Qsc19iKTtcbiAgICAgICAgR0NEXyhzX2Qsc19uKTsgIC8vaWYgc19iIGFuZCBzX24gYXJlIHJlbGF0aXZlbHkgcHJpbWUsIHRoZW4gc19uIGlzIGEgcHJpbWVcbiAgICAgICAgaWYgKGVxdWFsc0ludChzX2QsMSkpIHtcbiAgICAgICAgICBjb3B5XyhhbnMsc19hYSk7XG4gICAgICAgICAgcmV0dXJuOyAgICAgLy9pZiB3ZSd2ZSBtYWRlIGl0IHRoaXMgZmFyLCB0aGVuIHNfbiBpcyBhYnNvbHV0ZWx5IGd1YXJhbnRlZWQgdG8gYmUgcHJpbWVcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG4vL1JldHVybiBhbiBuLWJpdCByYW5kb20gQmlnSW50IChuPj0xKS4gIElmIHM9MSwgdGhlbiB0aGUgbW9zdCBzaWduaWZpY2FudCBvZiB0aG9zZSBuIGJpdHMgaXMgc2V0IHRvIDEuXG5mdW5jdGlvbiByYW5kQmlnSW50KG4scykge1xuICB2YXIgYSxiO1xuICBhPU1hdGguZmxvb3IoKG4tMSkvYnBlKSsyOyAvLyMgYXJyYXkgZWxlbWVudHMgdG8gaG9sZCB0aGUgQmlnSW50IHdpdGggYSBsZWFkaW5nIDAgZWxlbWVudFxuICBiPWludDJiaWdJbnQoMCwwLGEpO1xuICByYW5kQmlnSW50XyhiLG4scyk7XG4gIHJldHVybiBiO1xufVxuXG4vL1NldCBiIHRvIGFuIG4tYml0IHJhbmRvbSBCaWdJbnQuICBJZiBzPTEsIHRoZW4gdGhlIG1vc3Qgc2lnbmlmaWNhbnQgb2YgdGhvc2UgbiBiaXRzIGlzIHNldCB0byAxLlxuLy9BcnJheSBiIG11c3QgYmUgYmlnIGVub3VnaCB0byBob2xkIHRoZSByZXN1bHQuIE11c3QgaGF2ZSBuPj0xXG5mdW5jdGlvbiByYW5kQmlnSW50XyhiLG4scykge1xuICB2YXIgaSxhO1xuICBmb3IgKGk9MDtpPGIubGVuZ3RoO2krKylcbiAgICBiW2ldPTA7XG4gIGE9TWF0aC5mbG9vcigobi0xKS9icGUpKzE7IC8vIyBhcnJheSBlbGVtZW50cyB0byBob2xkIHRoZSBCaWdJbnRcbiAgZm9yIChpPTA7aTxhO2krKykge1xuICAgIGJbaV09TWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKigxPDwoYnBlLTEpKSk7XG4gIH1cbiAgYlthLTFdICY9ICgyPDwoKG4tMSklYnBlKSktMTtcbiAgaWYgKHM9PTEpXG4gICAgYlthLTFdIHw9ICgxPDwoKG4tMSklYnBlKSk7XG59XG5cbi8vUmV0dXJuIHRoZSBncmVhdGVzdCBjb21tb24gZGl2aXNvciBvZiBiaWdJbnRzIHggYW5kIHkgKGVhY2ggd2l0aCBzYW1lIG51bWJlciBvZiBlbGVtZW50cykuXG5mdW5jdGlvbiBHQ0QoeCx5KSB7XG4gIHZhciB4Yyx5YztcbiAgeGM9ZHVwKHgpO1xuICB5Yz1kdXAoeSk7XG4gIEdDRF8oeGMseWMpO1xuICByZXR1cm4geGM7XG59XG5cbi8vc2V0IHggdG8gdGhlIGdyZWF0ZXN0IGNvbW1vbiBkaXZpc29yIG9mIGJpZ0ludHMgeCBhbmQgeSAoZWFjaCB3aXRoIHNhbWUgbnVtYmVyIG9mIGVsZW1lbnRzKS5cbi8veSBpcyBkZXN0cm95ZWQuXG5mdW5jdGlvbiBHQ0RfKHgseSkge1xuICB2YXIgaSx4cCx5cCxBLEIsQyxELHEsc2luZztcbiAgaWYgKFQubGVuZ3RoIT14Lmxlbmd0aClcbiAgICBUPWR1cCh4KTtcblxuICBzaW5nPTE7XG4gIHdoaWxlIChzaW5nKSB7IC8vd2hpbGUgeSBoYXMgbm9uemVybyBlbGVtZW50cyBvdGhlciB0aGFuIHlbMF1cbiAgICBzaW5nPTA7XG4gICAgZm9yIChpPTE7aTx5Lmxlbmd0aDtpKyspIC8vY2hlY2sgaWYgeSBoYXMgbm9uemVybyBlbGVtZW50cyBvdGhlciB0aGFuIDBcbiAgICAgIGlmICh5W2ldKSB7XG4gICAgICAgIHNpbmc9MTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgaWYgKCFzaW5nKSBicmVhazsgLy9xdWl0IHdoZW4geSBhbGwgemVybyBlbGVtZW50cyBleGNlcHQgcG9zc2libHkgeVswXVxuXG4gICAgZm9yIChpPXgubGVuZ3RoOyF4W2ldICYmIGk+PTA7aS0tKTsgIC8vZmluZCBtb3N0IHNpZ25pZmljYW50IGVsZW1lbnQgb2YgeFxuICAgIHhwPXhbaV07XG4gICAgeXA9eVtpXTtcbiAgICBBPTE7IEI9MDsgQz0wOyBEPTE7XG4gICAgd2hpbGUgKCh5cCtDKSAmJiAoeXArRCkpIHtcbiAgICAgIHEgPU1hdGguZmxvb3IoKHhwK0EpLyh5cCtDKSk7XG4gICAgICBxcD1NYXRoLmZsb29yKCh4cCtCKS8oeXArRCkpO1xuICAgICAgaWYgKHEhPXFwKVxuICAgICAgICBicmVhaztcbiAgICAgIHQ9IEEtcSpDOyAgIEE9QzsgICBDPXQ7ICAgIC8vICBkbyAoQSxCLHhwLCBDLEQseXApID0gKEMsRCx5cCwgQSxCLHhwKSAtIHEqKDAsMCwwLCBDLEQseXApXG4gICAgICB0PSBCLXEqRDsgICBCPUQ7ICAgRD10O1xuICAgICAgdD14cC1xKnlwOyB4cD15cDsgeXA9dDtcbiAgICB9XG4gICAgaWYgKEIpIHtcbiAgICAgIGNvcHlfKFQseCk7XG4gICAgICBsaW5Db21iXyh4LHksQSxCKTsgLy94PUEqeCtCKnlcbiAgICAgIGxpbkNvbWJfKHksVCxELEMpOyAvL3k9RCp5K0MqVFxuICAgIH0gZWxzZSB7XG4gICAgICBtb2RfKHgseSk7XG4gICAgICBjb3B5XyhULHgpO1xuICAgICAgY29weV8oeCx5KTtcbiAgICAgIGNvcHlfKHksVCk7XG4gICAgfVxuICB9XG4gIGlmICh5WzBdPT0wKVxuICAgIHJldHVybjtcbiAgdD1tb2RJbnQoeCx5WzBdKTtcbiAgY29weUludF8oeCx5WzBdKTtcbiAgeVswXT10O1xuICB3aGlsZSAoeVswXSkge1xuICAgIHhbMF0lPXlbMF07XG4gICAgdD14WzBdOyB4WzBdPXlbMF07IHlbMF09dDtcbiAgfVxufVxuXG4vL2RvIHg9eCoqKC0xKSBtb2QgbiwgZm9yIGJpZ0ludHMgeCBhbmQgbi5cbi8vSWYgbm8gaW52ZXJzZSBleGlzdHMsIGl0IHNldHMgeCB0byB6ZXJvIGFuZCByZXR1cm5zIDAsIGVsc2UgaXQgcmV0dXJucyAxLlxuLy9UaGUgeCBhcnJheSBtdXN0IGJlIGF0IGxlYXN0IGFzIGxhcmdlIGFzIHRoZSBuIGFycmF5LlxuZnVuY3Rpb24gaW52ZXJzZU1vZF8oeCxuKSB7XG4gIHZhciBrPTErMipNYXRoLm1heCh4Lmxlbmd0aCxuLmxlbmd0aCk7XG5cbiAgaWYoISh4WzBdJjEpICAmJiAhKG5bMF0mMSkpIHsgIC8vaWYgYm90aCBpbnB1dHMgYXJlIGV2ZW4sIHRoZW4gaW52ZXJzZSBkb2Vzbid0IGV4aXN0XG4gICAgY29weUludF8oeCwwKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIGlmIChlZ191Lmxlbmd0aCE9aykge1xuICAgIGVnX3U9bmV3IEFycmF5KGspO1xuICAgIGVnX3Y9bmV3IEFycmF5KGspO1xuICAgIGVnX0E9bmV3IEFycmF5KGspO1xuICAgIGVnX0I9bmV3IEFycmF5KGspO1xuICAgIGVnX0M9bmV3IEFycmF5KGspO1xuICAgIGVnX0Q9bmV3IEFycmF5KGspO1xuICB9XG5cbiAgY29weV8oZWdfdSx4KTtcbiAgY29weV8oZWdfdixuKTtcbiAgY29weUludF8oZWdfQSwxKTtcbiAgY29weUludF8oZWdfQiwwKTtcbiAgY29weUludF8oZWdfQywwKTtcbiAgY29weUludF8oZWdfRCwxKTtcbiAgZm9yICg7Oykge1xuICAgIHdoaWxlKCEoZWdfdVswXSYxKSkgeyAgLy93aGlsZSBlZ191IGlzIGV2ZW5cbiAgICAgIGhhbHZlXyhlZ191KTtcbiAgICAgIGlmICghKGVnX0FbMF0mMSkgJiYgIShlZ19CWzBdJjEpKSB7IC8vaWYgZWdfQT09ZWdfQj09MCBtb2QgMlxuICAgICAgICBoYWx2ZV8oZWdfQSk7XG4gICAgICAgIGhhbHZlXyhlZ19CKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGFkZF8oZWdfQSxuKTsgIGhhbHZlXyhlZ19BKTtcbiAgICAgICAgc3ViXyhlZ19CLHgpOyAgaGFsdmVfKGVnX0IpO1xuICAgICAgfVxuICAgIH1cblxuICAgIHdoaWxlICghKGVnX3ZbMF0mMSkpIHsgIC8vd2hpbGUgZWdfdiBpcyBldmVuXG4gICAgICBoYWx2ZV8oZWdfdik7XG4gICAgICBpZiAoIShlZ19DWzBdJjEpICYmICEoZWdfRFswXSYxKSkgeyAvL2lmIGVnX0M9PWVnX0Q9PTAgbW9kIDJcbiAgICAgICAgaGFsdmVfKGVnX0MpO1xuICAgICAgICBoYWx2ZV8oZWdfRCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhZGRfKGVnX0Msbik7ICBoYWx2ZV8oZWdfQyk7XG4gICAgICAgIHN1Yl8oZWdfRCx4KTsgIGhhbHZlXyhlZ19EKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoIWdyZWF0ZXIoZWdfdixlZ191KSkgeyAvL2VnX3YgPD0gZWdfdVxuICAgICAgc3ViXyhlZ191LGVnX3YpO1xuICAgICAgc3ViXyhlZ19BLGVnX0MpO1xuICAgICAgc3ViXyhlZ19CLGVnX0QpO1xuICAgIH0gZWxzZSB7ICAgICAgICAgICAgICAgICAgIC8vZWdfdiA+IGVnX3VcbiAgICAgIHN1Yl8oZWdfdixlZ191KTtcbiAgICAgIHN1Yl8oZWdfQyxlZ19BKTtcbiAgICAgIHN1Yl8oZWdfRCxlZ19CKTtcbiAgICB9XG5cbiAgICBpZiAoZXF1YWxzSW50KGVnX3UsMCkpIHtcbiAgICAgIGlmIChuZWdhdGl2ZShlZ19DKSkgLy9tYWtlIHN1cmUgYW5zd2VyIGlzIG5vbm5lZ2F0aXZlXG4gICAgICAgIGFkZF8oZWdfQyxuKTtcbiAgICAgIGNvcHlfKHgsZWdfQyk7XG5cbiAgICAgIGlmICghZXF1YWxzSW50KGVnX3YsMSkpIHsgLy9pZiBHQ0RfKHgsbikhPTEsIHRoZW4gdGhlcmUgaXMgbm8gaW52ZXJzZVxuICAgICAgICBjb3B5SW50Xyh4LDApO1xuICAgICAgICByZXR1cm4gMDtcbiAgICAgIH1cbiAgICAgIHJldHVybiAxO1xuICAgIH1cbiAgfVxufVxuXG4vL3JldHVybiB4KiooLTEpIG1vZCBuLCBmb3IgaW50ZWdlcnMgeCBhbmQgbi4gIFJldHVybiAwIGlmIHRoZXJlIGlzIG5vIGludmVyc2VcbmZ1bmN0aW9uIGludmVyc2VNb2RJbnQoeCxuKSB7XG4gIHZhciBhPTEsYj0wLHQ7XG4gIGZvciAoOzspIHtcbiAgICBpZiAoeD09MSkgcmV0dXJuIGE7XG4gICAgaWYgKHg9PTApIHJldHVybiAwO1xuICAgIGItPWEqTWF0aC5mbG9vcihuL3gpO1xuICAgIG4lPXg7XG5cbiAgICBpZiAobj09MSkgcmV0dXJuIGI7IC8vdG8gYXZvaWQgbmVnYXRpdmVzLCBjaGFuZ2UgdGhpcyBiIHRvIG4tYiwgYW5kIGVhY2ggLT0gdG8gKz1cbiAgICBpZiAobj09MCkgcmV0dXJuIDA7XG4gICAgYS09YipNYXRoLmZsb29yKHgvbik7XG4gICAgeCU9bjtcbiAgfVxufVxuXG4vL3RoaXMgZGVwcmVjYXRlZCBmdW5jdGlvbiBpcyBmb3IgYmFja3dhcmQgY29tcGF0aWJpbGl0eSBvbmx5LlxuZnVuY3Rpb24gaW52ZXJzZU1vZEludF8oeCxuKSB7XG4gICByZXR1cm4gaW52ZXJzZU1vZEludCh4LG4pO1xufVxuXG5cbi8vR2l2ZW4gcG9zaXRpdmUgYmlnSW50cyB4IGFuZCB5LCBjaGFuZ2UgdGhlIGJpZ2ludHMgdiwgYSwgYW5kIGIgdG8gcG9zaXRpdmUgYmlnSW50cyBzdWNoIHRoYXQ6XG4vLyAgICAgdiA9IEdDRF8oeCx5KSA9IGEqeC1iKnlcbi8vVGhlIGJpZ0ludHMgdiwgYSwgYiwgbXVzdCBoYXZlIGV4YWN0bHkgYXMgbWFueSBlbGVtZW50cyBhcyB0aGUgbGFyZ2VyIG9mIHggYW5kIHkuXG5mdW5jdGlvbiBlR0NEXyh4LHksdixhLGIpIHtcbiAgdmFyIGc9MDtcbiAgdmFyIGs9TWF0aC5tYXgoeC5sZW5ndGgseS5sZW5ndGgpO1xuICBpZiAoZWdfdS5sZW5ndGghPWspIHtcbiAgICBlZ191PW5ldyBBcnJheShrKTtcbiAgICBlZ19BPW5ldyBBcnJheShrKTtcbiAgICBlZ19CPW5ldyBBcnJheShrKTtcbiAgICBlZ19DPW5ldyBBcnJheShrKTtcbiAgICBlZ19EPW5ldyBBcnJheShrKTtcbiAgfVxuICB3aGlsZSghKHhbMF0mMSkgICYmICEoeVswXSYxKSkgeyAgLy93aGlsZSB4IGFuZCB5IGJvdGggZXZlblxuICAgIGhhbHZlXyh4KTtcbiAgICBoYWx2ZV8oeSk7XG4gICAgZysrO1xuICB9XG4gIGNvcHlfKGVnX3UseCk7XG4gIGNvcHlfKHYseSk7XG4gIGNvcHlJbnRfKGVnX0EsMSk7XG4gIGNvcHlJbnRfKGVnX0IsMCk7XG4gIGNvcHlJbnRfKGVnX0MsMCk7XG4gIGNvcHlJbnRfKGVnX0QsMSk7XG4gIGZvciAoOzspIHtcbiAgICB3aGlsZSghKGVnX3VbMF0mMSkpIHsgIC8vd2hpbGUgdSBpcyBldmVuXG4gICAgICBoYWx2ZV8oZWdfdSk7XG4gICAgICBpZiAoIShlZ19BWzBdJjEpICYmICEoZWdfQlswXSYxKSkgeyAvL2lmIEE9PUI9PTAgbW9kIDJcbiAgICAgICAgaGFsdmVfKGVnX0EpO1xuICAgICAgICBoYWx2ZV8oZWdfQik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhZGRfKGVnX0EseSk7ICBoYWx2ZV8oZWdfQSk7XG4gICAgICAgIHN1Yl8oZWdfQix4KTsgIGhhbHZlXyhlZ19CKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB3aGlsZSAoISh2WzBdJjEpKSB7ICAvL3doaWxlIHYgaXMgZXZlblxuICAgICAgaGFsdmVfKHYpO1xuICAgICAgaWYgKCEoZWdfQ1swXSYxKSAmJiAhKGVnX0RbMF0mMSkpIHsgLy9pZiBDPT1EPT0wIG1vZCAyXG4gICAgICAgIGhhbHZlXyhlZ19DKTtcbiAgICAgICAgaGFsdmVfKGVnX0QpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYWRkXyhlZ19DLHkpOyAgaGFsdmVfKGVnX0MpO1xuICAgICAgICBzdWJfKGVnX0QseCk7ICBoYWx2ZV8oZWdfRCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCFncmVhdGVyKHYsZWdfdSkpIHsgLy92PD11XG4gICAgICBzdWJfKGVnX3Usdik7XG4gICAgICBzdWJfKGVnX0EsZWdfQyk7XG4gICAgICBzdWJfKGVnX0IsZWdfRCk7XG4gICAgfSBlbHNlIHsgICAgICAgICAgICAgICAgLy92PnVcbiAgICAgIHN1Yl8odixlZ191KTtcbiAgICAgIHN1Yl8oZWdfQyxlZ19BKTtcbiAgICAgIHN1Yl8oZWdfRCxlZ19CKTtcbiAgICB9XG4gICAgaWYgKGVxdWFsc0ludChlZ191LDApKSB7XG4gICAgICBpZiAobmVnYXRpdmUoZWdfQykpIHsgICAvL21ha2Ugc3VyZSBhIChDKWlzIG5vbm5lZ2F0aXZlXG4gICAgICAgIGFkZF8oZWdfQyx5KTtcbiAgICAgICAgc3ViXyhlZ19ELHgpO1xuICAgICAgfVxuICAgICAgbXVsdEludF8oZWdfRCwtMSk7ICAvLy9tYWtlIHN1cmUgYiAoRCkgaXMgbm9ubmVnYXRpdmVcbiAgICAgIGNvcHlfKGEsZWdfQyk7XG4gICAgICBjb3B5XyhiLGVnX0QpO1xuICAgICAgbGVmdFNoaWZ0Xyh2LGcpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxufVxuXG5cbi8vaXMgYmlnSW50IHggbmVnYXRpdmU/XG5mdW5jdGlvbiBuZWdhdGl2ZSh4KSB7XG4gIHJldHVybiAoKHhbeC5sZW5ndGgtMV0+PihicGUtMSkpJjEpO1xufVxuXG5cbi8vaXMgKHggPDwgKHNoaWZ0KmJwZSkpID4geT9cbi8veCBhbmQgeSBhcmUgbm9ubmVnYXRpdmUgYmlnSW50c1xuLy9zaGlmdCBpcyBhIG5vbm5lZ2F0aXZlIGludGVnZXJcbmZ1bmN0aW9uIGdyZWF0ZXJTaGlmdCh4LHksc2hpZnQpIHtcbiAgdmFyIGksIGt4PXgubGVuZ3RoLCBreT15Lmxlbmd0aDtcbiAgaz0oKGt4K3NoaWZ0KTxreSkgPyAoa3grc2hpZnQpIDoga3k7XG4gIGZvciAoaT1reS0xLXNoaWZ0OyBpPGt4ICYmIGk+PTA7IGkrKylcbiAgICBpZiAoeFtpXT4wKVxuICAgICAgcmV0dXJuIDE7IC8vaWYgdGhlcmUgYXJlIG5vbnplcm9zIGluIHggdG8gdGhlIGxlZnQgb2YgdGhlIGZpcnN0IGNvbHVtbiBvZiB5LCB0aGVuIHggaXMgYmlnZ2VyXG4gIGZvciAoaT1reC0xK3NoaWZ0OyBpPGt5OyBpKyspXG4gICAgaWYgKHlbaV0+MClcbiAgICAgIHJldHVybiAwOyAvL2lmIHRoZXJlIGFyZSBub256ZXJvcyBpbiB5IHRvIHRoZSBsZWZ0IG9mIHRoZSBmaXJzdCBjb2x1bW4gb2YgeCwgdGhlbiB4IGlzIG5vdCBiaWdnZXJcbiAgZm9yIChpPWstMTsgaT49c2hpZnQ7IGktLSlcbiAgICBpZiAgICAgICh4W2ktc2hpZnRdPnlbaV0pIHJldHVybiAxO1xuICAgIGVsc2UgaWYgKHhbaS1zaGlmdF08eVtpXSkgcmV0dXJuIDA7XG4gIHJldHVybiAwO1xufVxuXG4vL2lzIHggPiB5PyAoeCBhbmQgeSBib3RoIG5vbm5lZ2F0aXZlKVxuZnVuY3Rpb24gZ3JlYXRlcih4LHkpIHtcbiAgdmFyIGk7XG4gIHZhciBrPSh4Lmxlbmd0aDx5Lmxlbmd0aCkgPyB4Lmxlbmd0aCA6IHkubGVuZ3RoO1xuXG4gIGZvciAoaT14Lmxlbmd0aDtpPHkubGVuZ3RoO2krKylcbiAgICBpZiAoeVtpXSlcbiAgICAgIHJldHVybiAwOyAgLy95IGhhcyBtb3JlIGRpZ2l0c1xuXG4gIGZvciAoaT15Lmxlbmd0aDtpPHgubGVuZ3RoO2krKylcbiAgICBpZiAoeFtpXSlcbiAgICAgIHJldHVybiAxOyAgLy94IGhhcyBtb3JlIGRpZ2l0c1xuXG4gIGZvciAoaT1rLTE7aT49MDtpLS0pXG4gICAgaWYgKHhbaV0+eVtpXSlcbiAgICAgIHJldHVybiAxO1xuICAgIGVsc2UgaWYgKHhbaV08eVtpXSlcbiAgICAgIHJldHVybiAwO1xuICByZXR1cm4gMDtcbn1cblxuLy9kaXZpZGUgeCBieSB5IGdpdmluZyBxdW90aWVudCBxIGFuZCByZW1haW5kZXIgci4gIChxPWZsb29yKHgveSksICByPXggbW9kIHkpLiAgQWxsIDQgYXJlIGJpZ2ludHMuXG4vL3ggbXVzdCBoYXZlIGF0IGxlYXN0IG9uZSBsZWFkaW5nIHplcm8gZWxlbWVudC5cbi8veSBtdXN0IGJlIG5vbnplcm8uXG4vL3EgYW5kIHIgbXVzdCBiZSBhcnJheXMgdGhhdCBhcmUgZXhhY3RseSB0aGUgc2FtZSBsZW5ndGggYXMgeC4gKE9yIHEgY2FuIGhhdmUgbW9yZSkuXG4vL011c3QgaGF2ZSB4Lmxlbmd0aCA+PSB5Lmxlbmd0aCA+PSAyLlxuZnVuY3Rpb24gZGl2aWRlXyh4LHkscSxyKSB7XG4gIHZhciBreCwga3k7XG4gIHZhciBpLGoseTEseTIsYyxhLGI7XG4gIGNvcHlfKHIseCk7XG4gIGZvciAoa3k9eS5sZW5ndGg7eVtreS0xXT09MDtreS0tKTsgLy9reSBpcyBudW1iZXIgb2YgZWxlbWVudHMgaW4geSwgbm90IGluY2x1ZGluZyBsZWFkaW5nIHplcm9zXG5cbiAgLy9ub3JtYWxpemU6IGVuc3VyZSB0aGUgbW9zdCBzaWduaWZpY2FudCBlbGVtZW50IG9mIHkgaGFzIGl0cyBoaWdoZXN0IGJpdCBzZXRcbiAgYj15W2t5LTFdO1xuICBmb3IgKGE9MDsgYjsgYSsrKVxuICAgIGI+Pj0xO1xuICBhPWJwZS1hOyAgLy9hIGlzIGhvdyBtYW55IGJpdHMgdG8gc2hpZnQgc28gdGhhdCB0aGUgaGlnaCBvcmRlciBiaXQgb2YgeSBpcyBsZWZ0bW9zdCBpbiBpdHMgYXJyYXkgZWxlbWVudFxuICBsZWZ0U2hpZnRfKHksYSk7ICAvL211bHRpcGx5IGJvdGggYnkgMTw8YSBub3csIHRoZW4gZGl2aWRlIGJvdGggYnkgdGhhdCBhdCB0aGUgZW5kXG4gIGxlZnRTaGlmdF8ocixhKTtcblxuICAvL1JvYiBWaXNzZXIgZGlzY292ZXJlZCBhIGJ1ZzogdGhlIGZvbGxvd2luZyBsaW5lIHdhcyBvcmlnaW5hbGx5IGp1c3QgYmVmb3JlIHRoZSBub3JtYWxpemF0aW9uLlxuICBmb3IgKGt4PXIubGVuZ3RoO3Jba3gtMV09PTAgJiYga3g+a3k7a3gtLSk7IC8va3ggaXMgbnVtYmVyIG9mIGVsZW1lbnRzIGluIG5vcm1hbGl6ZWQgeCwgbm90IGluY2x1ZGluZyBsZWFkaW5nIHplcm9zXG5cbiAgY29weUludF8ocSwwKTsgICAgICAgICAgICAgICAgICAgICAgLy8gcT0wXG4gIHdoaWxlICghZ3JlYXRlclNoaWZ0KHkscixreC1reSkpIHsgIC8vIHdoaWxlIChsZWZ0U2hpZnRfKHksa3gta3kpIDw9IHIpIHtcbiAgICBzdWJTaGlmdF8ocix5LGt4LWt5KTsgICAgICAgICAgICAgLy8gICByPXItbGVmdFNoaWZ0Xyh5LGt4LWt5KVxuICAgIHFba3gta3ldKys7ICAgICAgICAgICAgICAgICAgICAgICAvLyAgIHFba3gta3ldKys7XG4gIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIH1cblxuICBmb3IgKGk9a3gtMTsgaT49a3k7IGktLSkge1xuICAgIGlmIChyW2ldPT15W2t5LTFdKVxuICAgICAgcVtpLWt5XT1tYXNrO1xuICAgIGVsc2VcbiAgICAgIHFbaS1reV09TWF0aC5mbG9vcigocltpXSpyYWRpeCtyW2ktMV0pL3lba3ktMV0pO1xuXG4gICAgLy9UaGUgZm9sbG93aW5nIGZvcig7OykgbG9vcCBpcyBlcXVpdmFsZW50IHRvIHRoZSBjb21tZW50ZWQgd2hpbGUgbG9vcCxcbiAgICAvL2V4Y2VwdCB0aGF0IHRoZSB1bmNvbW1lbnRlZCB2ZXJzaW9uIGF2b2lkcyBvdmVyZmxvdy5cbiAgICAvL1RoZSBjb21tZW50ZWQgbG9vcCBjb21lcyBmcm9tIEhBQywgd2hpY2ggYXNzdW1lcyByWy0xXT09eVstMV09PTBcbiAgICAvLyAgd2hpbGUgKHFbaS1reV0qKHlba3ktMV0qcmFkaXgreVtreS0yXSkgPiByW2ldKnJhZGl4KnJhZGl4K3JbaS0xXSpyYWRpeCtyW2ktMl0pXG4gICAgLy8gICAgcVtpLWt5XS0tO1xuICAgIGZvciAoOzspIHtcbiAgICAgIHkyPShreT4xID8geVtreS0yXSA6IDApKnFbaS1reV07XG4gICAgICBjPXkyPj5icGU7XG4gICAgICB5Mj15MiAmIG1hc2s7XG4gICAgICB5MT1jK3FbaS1reV0qeVtreS0xXTtcbiAgICAgIGM9eTE+PmJwZTtcbiAgICAgIHkxPXkxICYgbWFzaztcblxuICAgICAgaWYgKGM9PXJbaV0gPyB5MT09cltpLTFdID8geTI+KGk+MSA/IHJbaS0yXSA6IDApIDogeTE+cltpLTFdIDogYz5yW2ldKVxuICAgICAgICBxW2kta3ldLS07XG4gICAgICBlbHNlXG4gICAgICAgIGJyZWFrO1xuICAgIH1cblxuICAgIGxpbkNvbWJTaGlmdF8ocix5LC1xW2kta3ldLGkta3kpOyAgICAvL3I9ci1xW2kta3ldKmxlZnRTaGlmdF8oeSxpLWt5KVxuICAgIGlmIChuZWdhdGl2ZShyKSkge1xuICAgICAgYWRkU2hpZnRfKHIseSxpLWt5KTsgICAgICAgICAvL3I9citsZWZ0U2hpZnRfKHksaS1reSlcbiAgICAgIHFbaS1reV0tLTtcbiAgICB9XG4gIH1cblxuICByaWdodFNoaWZ0Xyh5LGEpOyAgLy91bmRvIHRoZSBub3JtYWxpemF0aW9uIHN0ZXBcbiAgcmlnaHRTaGlmdF8ocixhKTsgIC8vdW5kbyB0aGUgbm9ybWFsaXphdGlvbiBzdGVwXG59XG5cbi8vZG8gY2FycmllcyBhbmQgYm9ycm93cyBzbyBlYWNoIGVsZW1lbnQgb2YgdGhlIGJpZ0ludCB4IGZpdHMgaW4gYnBlIGJpdHMuXG5mdW5jdGlvbiBjYXJyeV8oeCkge1xuICB2YXIgaSxrLGMsYjtcbiAgaz14Lmxlbmd0aDtcbiAgYz0wO1xuICBmb3IgKGk9MDtpPGs7aSsrKSB7XG4gICAgYys9eFtpXTtcbiAgICBiPTA7XG4gICAgaWYgKGM8MCkge1xuICAgICAgYj0tKGM+PmJwZSk7XG4gICAgICBjKz1iKnJhZGl4O1xuICAgIH1cbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM9KGM+PmJwZSktYjtcbiAgfVxufVxuXG4vL3JldHVybiB4IG1vZCBuIGZvciBiaWdJbnQgeCBhbmQgaW50ZWdlciBuLlxuZnVuY3Rpb24gbW9kSW50KHgsbikge1xuICB2YXIgaSxjPTA7XG4gIGZvciAoaT14Lmxlbmd0aC0xOyBpPj0wOyBpLS0pXG4gICAgYz0oYypyYWRpeCt4W2ldKSVuO1xuICByZXR1cm4gYztcbn1cblxuLy9jb252ZXJ0IHRoZSBpbnRlZ2VyIHQgaW50byBhIGJpZ0ludCB3aXRoIGF0IGxlYXN0IHRoZSBnaXZlbiBudW1iZXIgb2YgYml0cy5cbi8vdGhlIHJldHVybmVkIGFycmF5IHN0b3JlcyB0aGUgYmlnSW50IGluIGJwZS1iaXQgY2h1bmtzLCBsaXR0bGUgZW5kaWFuIChidWZmWzBdIGlzIGxlYXN0IHNpZ25pZmljYW50IHdvcmQpXG4vL1BhZCB0aGUgYXJyYXkgd2l0aCBsZWFkaW5nIHplcm9zIHNvIHRoYXQgaXQgaGFzIGF0IGxlYXN0IG1pblNpemUgZWxlbWVudHMuXG4vL1RoZXJlIHdpbGwgYWx3YXlzIGJlIGF0IGxlYXN0IG9uZSBsZWFkaW5nIDAgZWxlbWVudC5cbmZ1bmN0aW9uIGludDJiaWdJbnQodCxiaXRzLG1pblNpemUpIHtcbiAgdmFyIGksaztcbiAgaz1NYXRoLmNlaWwoYml0cy9icGUpKzE7XG4gIGs9bWluU2l6ZT5rID8gbWluU2l6ZSA6IGs7XG4gIGJ1ZmY9bmV3IEFycmF5KGspO1xuICBjb3B5SW50XyhidWZmLHQpO1xuICByZXR1cm4gYnVmZjtcbn1cblxuLy9yZXR1cm4gdGhlIGJpZ0ludCBnaXZlbiBhIHN0cmluZyByZXByZXNlbnRhdGlvbiBpbiBhIGdpdmVuIGJhc2UuXG4vL1BhZCB0aGUgYXJyYXkgd2l0aCBsZWFkaW5nIHplcm9zIHNvIHRoYXQgaXQgaGFzIGF0IGxlYXN0IG1pblNpemUgZWxlbWVudHMuXG4vL0lmIGJhc2U9LTEsIHRoZW4gaXQgcmVhZHMgaW4gYSBzcGFjZS1zZXBhcmF0ZWQgbGlzdCBvZiBhcnJheSBlbGVtZW50cyBpbiBkZWNpbWFsLlxuLy9UaGUgYXJyYXkgd2lsbCBhbHdheXMgaGF2ZSBhdCBsZWFzdCBvbmUgbGVhZGluZyB6ZXJvLCB1bmxlc3MgYmFzZT0tMS5cbmZ1bmN0aW9uIHN0cjJiaWdJbnQocyxiLG1pblNpemUpIHtcbiAgdmFyIGQsIGksIGosIGJhc2UsIHN0ciwgeCwgeSwga2s7XG4gIGlmICh0eXBlb2YgYiA9PT0gJ3N0cmluZycpIHtcblx0ICBiYXNlID0gYi5sZW5ndGg7XG5cdCAgc3RyID0gYjtcbiAgfSBlbHNlIHtcblx0ICBiYXNlID0gYjtcblx0ICBzdHIgPSBkaWdpdHNTdHI7XG4gIH1cbiAgdmFyIGs9cy5sZW5ndGg7XG4gIGlmIChiYXNlPT0tMSkgeyAvL2NvbW1hLXNlcGFyYXRlZCBsaXN0IG9mIGFycmF5IGVsZW1lbnRzIGluIGRlY2ltYWxcbiAgICB4PW5ldyBBcnJheSgwKTtcbiAgICBmb3IgKDs7KSB7XG4gICAgICB5PW5ldyBBcnJheSh4Lmxlbmd0aCsxKTtcbiAgICAgIGZvciAoaT0wO2k8eC5sZW5ndGg7aSsrKVxuICAgICAgICB5W2krMV09eFtpXTtcbiAgICAgIHlbMF09cGFyc2VJbnQocywxMCk7XG4gICAgICB4PXk7XG4gICAgICBkPXMuaW5kZXhPZignLCcsMCk7XG4gICAgICBpZiAoZDwxKVxuICAgICAgICBicmVhaztcbiAgICAgIHM9cy5zdWJzdHJpbmcoZCsxKTtcbiAgICAgIGlmIChzLmxlbmd0aD09MClcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGlmICh4Lmxlbmd0aDxtaW5TaXplKSB7XG4gICAgICB5PW5ldyBBcnJheShtaW5TaXplKTtcbiAgICAgIGNvcHlfKHkseCk7XG4gICAgICByZXR1cm4geTtcbiAgICB9XG4gICAgcmV0dXJuIHg7XG4gIH1cblxuICB4PWludDJiaWdJbnQoMCxiYXNlKmssMCk7XG4gIGZvciAoaT0wO2k8aztpKyspIHtcbiAgICBkPXN0ci5pbmRleE9mKHMuc3Vic3RyaW5nKGksaSsxKSwwKTtcbi8vICAgIGlmIChiYXNlPD0zNiAmJiBkPj0zNikgIC8vY29udmVydCBsb3dlcmNhc2UgdG8gdXBwZXJjYXNlIGlmIGJhc2U8PTM2XG4vLyAgICAgIGQtPTI2O1xuICAgIGlmIChkPj1iYXNlIHx8IGQ8MCkgeyAgIC8vaWdub3JlIGlsbGVnYWwgY2hhcmFjdGVyc1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIG11bHRJbnRfKHgsYmFzZSk7XG4gICAgYWRkSW50Xyh4LGQpO1xuICB9XG5cbiAgZm9yIChrPXgubGVuZ3RoO2s+MCAmJiAheFtrLTFdO2stLSk7IC8vc3RyaXAgb2ZmIGxlYWRpbmcgemVyb3NcbiAgaz1taW5TaXplPmsrMSA/IG1pblNpemUgOiBrKzE7XG4gIHk9bmV3IEFycmF5KGspO1xuICBraz1rPHgubGVuZ3RoID8gayA6IHgubGVuZ3RoO1xuICBmb3IgKGk9MDtpPGtrO2krKylcbiAgICB5W2ldPXhbaV07XG4gIGZvciAoO2k8aztpKyspXG4gICAgeVtpXT0wO1xuICByZXR1cm4geTtcbn1cblxuLy9pcyBiaWdpbnQgeCBlcXVhbCB0byBpbnRlZ2VyIHk/XG4vL3kgbXVzdCBoYXZlIGxlc3MgdGhhbiBicGUgYml0c1xuZnVuY3Rpb24gZXF1YWxzSW50KHgseSkge1xuICB2YXIgaTtcbiAgaWYgKHhbMF0hPXkpXG4gICAgcmV0dXJuIDA7XG4gIGZvciAoaT0xO2k8eC5sZW5ndGg7aSsrKVxuICAgIGlmICh4W2ldKVxuICAgICAgcmV0dXJuIDA7XG4gIHJldHVybiAxO1xufVxuXG4vL2FyZSBiaWdpbnRzIHggYW5kIHkgZXF1YWw/XG4vL3RoaXMgd29ya3MgZXZlbiBpZiB4IGFuZCB5IGFyZSBkaWZmZXJlbnQgbGVuZ3RocyBhbmQgaGF2ZSBhcmJpdHJhcmlseSBtYW55IGxlYWRpbmcgemVyb3NcbmZ1bmN0aW9uIGVxdWFscyh4LHkpIHtcbiAgdmFyIGk7XG4gIHZhciBrPXgubGVuZ3RoPHkubGVuZ3RoID8geC5sZW5ndGggOiB5Lmxlbmd0aDtcbiAgZm9yIChpPTA7aTxrO2krKylcbiAgICBpZiAoeFtpXSE9eVtpXSlcbiAgICAgIHJldHVybiAwO1xuICBpZiAoeC5sZW5ndGg+eS5sZW5ndGgpIHtcbiAgICBmb3IgKDtpPHgubGVuZ3RoO2krKylcbiAgICAgIGlmICh4W2ldKVxuICAgICAgICByZXR1cm4gMDtcbiAgfSBlbHNlIHtcbiAgICBmb3IgKDtpPHkubGVuZ3RoO2krKylcbiAgICAgIGlmICh5W2ldKVxuICAgICAgICByZXR1cm4gMDtcbiAgfVxuICByZXR1cm4gMTtcbn1cblxuLy9pcyB0aGUgYmlnSW50IHggZXF1YWwgdG8gemVybz9cbmZ1bmN0aW9uIGlzWmVybyh4KSB7XG4gIHZhciBpO1xuICBmb3IgKGk9MDtpPHgubGVuZ3RoO2krKylcbiAgICBpZiAoeFtpXSlcbiAgICAgIHJldHVybiAwO1xuICByZXR1cm4gMTtcbn1cblxuLy9jb252ZXJ0IGEgYmlnSW50IGludG8gYSBzdHJpbmcgaW4gYSBnaXZlbiBiYXNlLCBmcm9tIGJhc2UgMiB1cCB0byBiYXNlIDk1LlxuLy9CYXNlIC0xIHByaW50cyB0aGUgY29udGVudHMgb2YgdGhlIGFycmF5IHJlcHJlc2VudGluZyB0aGUgbnVtYmVyLlxuZnVuY3Rpb24gYmlnSW50MnN0cih4LGIpIHtcbiAgdmFyIGksdCxiYXNlLHN0cixzPVwiXCI7XG4gIGlmICh0eXBlb2YgYiA9PT0gJ3N0cmluZycpIHtcblx0ICBiYXNlID0gYi5sZW5ndGg7XG5cdCAgc3RyID0gYjtcbiAgfSBlbHNlIHtcblx0ICBiYXNlID0gYjtcblx0ICBzdHIgPSBkaWdpdHNTdHI7XG4gIH1cblxuICBpZiAoczYubGVuZ3RoIT14Lmxlbmd0aClcbiAgICBzNj1kdXAoeCk7XG4gIGVsc2VcbiAgICBjb3B5XyhzNix4KTtcblxuICBpZiAoYmFzZT09LTEpIHsgLy9yZXR1cm4gdGhlIGxpc3Qgb2YgYXJyYXkgY29udGVudHNcbiAgICBmb3IgKGk9eC5sZW5ndGgtMTtpPjA7aS0tKVxuICAgICAgcys9eFtpXSsnLCc7XG4gICAgcys9eFswXTtcbiAgfVxuICBlbHNlIHsgLy9yZXR1cm4gaXQgaW4gdGhlIGdpdmVuIGJhc2VcbiAgICB3aGlsZSAoIWlzWmVybyhzNikpIHtcbiAgICAgIHQ9ZGl2SW50XyhzNixiYXNlKTsgIC8vdD1zNiAlIGJhc2U7IHM2PWZsb29yKHM2L2Jhc2UpO1xuICAgICAgcz1zdHIuc3Vic3RyaW5nKHQsdCsxKStzO1xuICAgIH1cbiAgfVxuICBpZiAocy5sZW5ndGg9PTApXG4gICAgcz1zdHJbMF07XG4gIHJldHVybiBzO1xufVxuXG4vL3JldHVybnMgYSBkdXBsaWNhdGUgb2YgYmlnSW50IHhcbmZ1bmN0aW9uIGR1cCh4KSB7XG4gIHZhciBpO1xuICBidWZmPW5ldyBBcnJheSh4Lmxlbmd0aCk7XG4gIGNvcHlfKGJ1ZmYseCk7XG4gIHJldHVybiBidWZmO1xufVxuXG4vL2RvIHg9eSBvbiBiaWdJbnRzIHggYW5kIHkuICB4IG11c3QgYmUgYW4gYXJyYXkgYXQgbGVhc3QgYXMgYmlnIGFzIHkgKG5vdCBjb3VudGluZyB0aGUgbGVhZGluZyB6ZXJvcyBpbiB5KS5cbmZ1bmN0aW9uIGNvcHlfKHgseSkge1xuICB2YXIgaTtcbiAgdmFyIGs9eC5sZW5ndGg8eS5sZW5ndGggPyB4Lmxlbmd0aCA6IHkubGVuZ3RoO1xuICBmb3IgKGk9MDtpPGs7aSsrKVxuICAgIHhbaV09eVtpXTtcbiAgZm9yIChpPWs7aTx4Lmxlbmd0aDtpKyspXG4gICAgeFtpXT0wO1xufVxuXG4vL2RvIHg9eSBvbiBiaWdJbnQgeCBhbmQgaW50ZWdlciB5LlxuZnVuY3Rpb24gY29weUludF8oeCxuKSB7XG4gIHZhciBpLGM7XG4gIGZvciAoYz1uLGk9MDtpPHgubGVuZ3RoO2krKykge1xuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz4+PWJwZTtcbiAgfVxufVxuXG4vL2RvIHg9eCtuIHdoZXJlIHggaXMgYSBiaWdJbnQgYW5kIG4gaXMgYW4gaW50ZWdlci5cbi8veCBtdXN0IGJlIGxhcmdlIGVub3VnaCB0byBob2xkIHRoZSByZXN1bHQuXG5mdW5jdGlvbiBhZGRJbnRfKHgsbikge1xuICB2YXIgaSxrLGMsYjtcbiAgeFswXSs9bjtcbiAgaz14Lmxlbmd0aDtcbiAgYz0wO1xuICBmb3IgKGk9MDtpPGs7aSsrKSB7XG4gICAgYys9eFtpXTtcbiAgICBiPTA7XG4gICAgaWYgKGM8MCkge1xuICAgICAgYj0tKGM+PmJwZSk7XG4gICAgICBjKz1iKnJhZGl4O1xuICAgIH1cbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM9KGM+PmJwZSktYjtcbiAgICBpZiAoIWMpIHJldHVybjsgLy9zdG9wIGNhcnJ5aW5nIGFzIHNvb24gYXMgdGhlIGNhcnJ5IGlzIHplcm9cbiAgfVxufVxuXG4vL3JpZ2h0IHNoaWZ0IGJpZ0ludCB4IGJ5IG4gYml0cy4gIDAgPD0gbiA8IGJwZS5cbmZ1bmN0aW9uIHJpZ2h0U2hpZnRfKHgsbikge1xuICB2YXIgaTtcbiAgdmFyIGs9TWF0aC5mbG9vcihuL2JwZSk7XG4gIGlmIChrKSB7XG4gICAgZm9yIChpPTA7aTx4Lmxlbmd0aC1rO2krKykgLy9yaWdodCBzaGlmdCB4IGJ5IGsgZWxlbWVudHNcbiAgICAgIHhbaV09eFtpK2tdO1xuICAgIGZvciAoO2k8eC5sZW5ndGg7aSsrKVxuICAgICAgeFtpXT0wO1xuICAgIG4lPWJwZTtcbiAgfVxuICBmb3IgKGk9MDtpPHgubGVuZ3RoLTE7aSsrKSB7XG4gICAgeFtpXT1tYXNrICYgKCh4W2krMV08PChicGUtbikpIHwgKHhbaV0+Pm4pKTtcbiAgfVxuICB4W2ldPj49bjtcbn1cblxuLy9kbyB4PWZsb29yKHx4fC8yKSpzZ24oeCkgZm9yIGJpZ0ludCB4IGluIDIncyBjb21wbGVtZW50XG5mdW5jdGlvbiBoYWx2ZV8oeCkge1xuICB2YXIgaTtcbiAgZm9yIChpPTA7aTx4Lmxlbmd0aC0xO2krKykge1xuICAgIHhbaV09bWFzayAmICgoeFtpKzFdPDwoYnBlLTEpKSB8ICh4W2ldPj4xKSk7XG4gIH1cbiAgeFtpXT0oeFtpXT4+MSkgfCAoeFtpXSAmIChyYWRpeD4+MSkpOyAgLy9tb3N0IHNpZ25pZmljYW50IGJpdCBzdGF5cyB0aGUgc2FtZVxufVxuXG4vL2xlZnQgc2hpZnQgYmlnSW50IHggYnkgbiBiaXRzLlxuZnVuY3Rpb24gbGVmdFNoaWZ0Xyh4LG4pIHtcbiAgdmFyIGk7XG4gIHZhciBrPU1hdGguZmxvb3Iobi9icGUpO1xuICBpZiAoaykge1xuICAgIGZvciAoaT14Lmxlbmd0aDsgaT49azsgaS0tKSAvL2xlZnQgc2hpZnQgeCBieSBrIGVsZW1lbnRzXG4gICAgICB4W2ldPXhbaS1rXTtcbiAgICBmb3IgKDtpPj0wO2ktLSlcbiAgICAgIHhbaV09MDtcbiAgICBuJT1icGU7XG4gIH1cbiAgaWYgKCFuKVxuICAgIHJldHVybjtcbiAgZm9yIChpPXgubGVuZ3RoLTE7aT4wO2ktLSkge1xuICAgIHhbaV09bWFzayAmICgoeFtpXTw8bikgfCAoeFtpLTFdPj4oYnBlLW4pKSk7XG4gIH1cbiAgeFtpXT1tYXNrICYgKHhbaV08PG4pO1xufVxuXG4vL2RvIHg9eCpuIHdoZXJlIHggaXMgYSBiaWdJbnQgYW5kIG4gaXMgYW4gaW50ZWdlci5cbi8veCBtdXN0IGJlIGxhcmdlIGVub3VnaCB0byBob2xkIHRoZSByZXN1bHQuXG5mdW5jdGlvbiBtdWx0SW50Xyh4LG4pIHtcbiAgdmFyIGksayxjLGI7XG4gIGlmICghbilcbiAgICByZXR1cm47XG4gIGs9eC5sZW5ndGg7XG4gIGM9MDtcbiAgZm9yIChpPTA7aTxrO2krKykge1xuICAgIGMrPXhbaV0qbjtcbiAgICBiPTA7XG4gICAgaWYgKGM8MCkge1xuICAgICAgYj0tKGM+PmJwZSk7XG4gICAgICBjKz1iKnJhZGl4O1xuICAgIH1cbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM9KGM+PmJwZSktYjtcbiAgfVxufVxuXG4vL2RvIHg9Zmxvb3IoeC9uKSBmb3IgYmlnSW50IHggYW5kIGludGVnZXIgbiwgYW5kIHJldHVybiB0aGUgcmVtYWluZGVyXG5mdW5jdGlvbiBkaXZJbnRfKHgsbikge1xuICB2YXIgaSxyPTAscztcbiAgZm9yIChpPXgubGVuZ3RoLTE7aT49MDtpLS0pIHtcbiAgICBzPXIqcmFkaXgreFtpXTtcbiAgICB4W2ldPU1hdGguZmxvb3Iocy9uKTtcbiAgICByPXMlbjtcbiAgfVxuICByZXR1cm4gcjtcbn1cblxuLy9kbyB0aGUgbGluZWFyIGNvbWJpbmF0aW9uIHg9YSp4K2IqeSBmb3IgYmlnSW50cyB4IGFuZCB5LCBhbmQgaW50ZWdlcnMgYSBhbmQgYi5cbi8veCBtdXN0IGJlIGxhcmdlIGVub3VnaCB0byBob2xkIHRoZSBhbnN3ZXIuXG5mdW5jdGlvbiBsaW5Db21iXyh4LHksYSxiKSB7XG4gIHZhciBpLGMsayxraztcbiAgaz14Lmxlbmd0aDx5Lmxlbmd0aCA/IHgubGVuZ3RoIDogeS5sZW5ndGg7XG4gIGtrPXgubGVuZ3RoO1xuICBmb3IgKGM9MCxpPTA7aTxrO2krKykge1xuICAgIGMrPWEqeFtpXStiKnlbaV07XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPj49YnBlO1xuICB9XG4gIGZvciAoaT1rO2k8a2s7aSsrKSB7XG4gICAgYys9YSp4W2ldO1xuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz4+PWJwZTtcbiAgfVxufVxuXG4vL2RvIHRoZSBsaW5lYXIgY29tYmluYXRpb24geD1hKngrYiooeTw8KHlzKmJwZSkpIGZvciBiaWdJbnRzIHggYW5kIHksIGFuZCBpbnRlZ2VycyBhLCBiIGFuZCB5cy5cbi8veCBtdXN0IGJlIGxhcmdlIGVub3VnaCB0byBob2xkIHRoZSBhbnN3ZXIuXG5mdW5jdGlvbiBsaW5Db21iU2hpZnRfKHgseSxiLHlzKSB7XG4gIHZhciBpLGMsayxraztcbiAgaz14Lmxlbmd0aDx5cyt5Lmxlbmd0aCA/IHgubGVuZ3RoIDogeXMreS5sZW5ndGg7XG4gIGtrPXgubGVuZ3RoO1xuICBmb3IgKGM9MCxpPXlzO2k8aztpKyspIHtcbiAgICBjKz14W2ldK2IqeVtpLXlzXTtcbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM+Pj1icGU7XG4gIH1cbiAgZm9yIChpPWs7YyAmJiBpPGtrO2krKykge1xuICAgIGMrPXhbaV07XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPj49YnBlO1xuICB9XG59XG5cbi8vZG8geD14Kyh5PDwoeXMqYnBlKSkgZm9yIGJpZ0ludHMgeCBhbmQgeSwgYW5kIGludGVnZXJzIGEsYiBhbmQgeXMuXG4vL3ggbXVzdCBiZSBsYXJnZSBlbm91Z2ggdG8gaG9sZCB0aGUgYW5zd2VyLlxuZnVuY3Rpb24gYWRkU2hpZnRfKHgseSx5cykge1xuICB2YXIgaSxjLGssa2s7XG4gIGs9eC5sZW5ndGg8eXMreS5sZW5ndGggPyB4Lmxlbmd0aCA6IHlzK3kubGVuZ3RoO1xuICBraz14Lmxlbmd0aDtcbiAgZm9yIChjPTAsaT15cztpPGs7aSsrKSB7XG4gICAgYys9eFtpXSt5W2kteXNdO1xuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz4+PWJwZTtcbiAgfVxuICBmb3IgKGk9aztjICYmIGk8a2s7aSsrKSB7XG4gICAgYys9eFtpXTtcbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM+Pj1icGU7XG4gIH1cbn1cblxuLy9kbyB4PXgtKHk8PCh5cypicGUpKSBmb3IgYmlnSW50cyB4IGFuZCB5LCBhbmQgaW50ZWdlcnMgYSxiIGFuZCB5cy5cbi8veCBtdXN0IGJlIGxhcmdlIGVub3VnaCB0byBob2xkIHRoZSBhbnN3ZXIuXG5mdW5jdGlvbiBzdWJTaGlmdF8oeCx5LHlzKSB7XG4gIHZhciBpLGMsayxraztcbiAgaz14Lmxlbmd0aDx5cyt5Lmxlbmd0aCA/IHgubGVuZ3RoIDogeXMreS5sZW5ndGg7XG4gIGtrPXgubGVuZ3RoO1xuICBmb3IgKGM9MCxpPXlzO2k8aztpKyspIHtcbiAgICBjKz14W2ldLXlbaS15c107XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPj49YnBlO1xuICB9XG4gIGZvciAoaT1rO2MgJiYgaTxraztpKyspIHtcbiAgICBjKz14W2ldO1xuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz4+PWJwZTtcbiAgfVxufVxuXG4vL2RvIHg9eC15IGZvciBiaWdJbnRzIHggYW5kIHkuXG4vL3ggbXVzdCBiZSBsYXJnZSBlbm91Z2ggdG8gaG9sZCB0aGUgYW5zd2VyLlxuLy9uZWdhdGl2ZSBhbnN3ZXJzIHdpbGwgYmUgMnMgY29tcGxlbWVudFxuZnVuY3Rpb24gc3ViXyh4LHkpIHtcbiAgdmFyIGksYyxrLGtrO1xuICBrPXgubGVuZ3RoPHkubGVuZ3RoID8geC5sZW5ndGggOiB5Lmxlbmd0aDtcbiAgZm9yIChjPTAsaT0wO2k8aztpKyspIHtcbiAgICBjKz14W2ldLXlbaV07XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPj49YnBlO1xuICB9XG4gIGZvciAoaT1rO2MgJiYgaTx4Lmxlbmd0aDtpKyspIHtcbiAgICBjKz14W2ldO1xuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz4+PWJwZTtcbiAgfVxufVxuXG4vL2RvIHg9eCt5IGZvciBiaWdJbnRzIHggYW5kIHkuXG4vL3ggbXVzdCBiZSBsYXJnZSBlbm91Z2ggdG8gaG9sZCB0aGUgYW5zd2VyLlxuZnVuY3Rpb24gYWRkXyh4LHkpIHtcbiAgdmFyIGksYyxrLGtrO1xuICBrPXgubGVuZ3RoPHkubGVuZ3RoID8geC5sZW5ndGggOiB5Lmxlbmd0aDtcbiAgZm9yIChjPTAsaT0wO2k8aztpKyspIHtcbiAgICBjKz14W2ldK3lbaV07XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPj49YnBlO1xuICB9XG4gIGZvciAoaT1rO2MgJiYgaTx4Lmxlbmd0aDtpKyspIHtcbiAgICBjKz14W2ldO1xuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz4+PWJwZTtcbiAgfVxufVxuXG4vL2RvIHg9eCp5IGZvciBiaWdJbnRzIHggYW5kIHkuICBUaGlzIGlzIGZhc3RlciB3aGVuIHk8eC5cbmZ1bmN0aW9uIG11bHRfKHgseSkge1xuICB2YXIgaTtcbiAgaWYgKHNzLmxlbmd0aCE9Mip4Lmxlbmd0aClcbiAgICBzcz1uZXcgQXJyYXkoMip4Lmxlbmd0aCk7XG4gIGNvcHlJbnRfKHNzLDApO1xuICBmb3IgKGk9MDtpPHkubGVuZ3RoO2krKylcbiAgICBpZiAoeVtpXSlcbiAgICAgIGxpbkNvbWJTaGlmdF8oc3MseCx5W2ldLGkpOyAgIC8vc3M9MSpzcyt5W2ldKih4PDwoaSpicGUpKVxuICBjb3B5Xyh4LHNzKTtcbn1cblxuLy9kbyB4PXggbW9kIG4gZm9yIGJpZ0ludHMgeCBhbmQgbi5cbmZ1bmN0aW9uIG1vZF8oeCxuKSB7XG4gIGlmIChzNC5sZW5ndGghPXgubGVuZ3RoKVxuICAgIHM0PWR1cCh4KTtcbiAgZWxzZVxuICAgIGNvcHlfKHM0LHgpO1xuICBpZiAoczUubGVuZ3RoIT14Lmxlbmd0aClcbiAgICBzNT1kdXAoeCk7XG4gIGRpdmlkZV8oczQsbixzNSx4KTsgIC8veCA9IHJlbWFpbmRlciBvZiBzNCAvIG5cbn1cblxuLy9kbyB4PXgqeSBtb2QgbiBmb3IgYmlnSW50cyB4LHksbi5cbi8vZm9yIGdyZWF0ZXIgc3BlZWQsIGxldCB5PHguXG5mdW5jdGlvbiBtdWx0TW9kXyh4LHksbikge1xuICB2YXIgaTtcbiAgaWYgKHMwLmxlbmd0aCE9Mip4Lmxlbmd0aClcbiAgICBzMD1uZXcgQXJyYXkoMip4Lmxlbmd0aCk7XG4gIGNvcHlJbnRfKHMwLDApO1xuICBmb3IgKGk9MDtpPHkubGVuZ3RoO2krKylcbiAgICBpZiAoeVtpXSlcbiAgICAgIGxpbkNvbWJTaGlmdF8oczAseCx5W2ldLGkpOyAgIC8vczA9MSpzMCt5W2ldKih4PDwoaSpicGUpKVxuICBtb2RfKHMwLG4pO1xuICBjb3B5Xyh4LHMwKTtcbn1cblxuLy9kbyB4PXgqeCBtb2QgbiBmb3IgYmlnSW50cyB4LG4uXG5mdW5jdGlvbiBzcXVhcmVNb2RfKHgsbikge1xuICB2YXIgaSxqLGQsYyxreCxrbixrO1xuICBmb3IgKGt4PXgubGVuZ3RoOyBreD4wICYmICF4W2t4LTFdOyBreC0tKTsgIC8vaWdub3JlIGxlYWRpbmcgemVyb3MgaW4geFxuICBrPWt4Pm4ubGVuZ3RoID8gMipreCA6IDIqbi5sZW5ndGg7IC8vaz0jIGVsZW1lbnRzIGluIHRoZSBwcm9kdWN0LCB3aGljaCBpcyB0d2ljZSB0aGUgZWxlbWVudHMgaW4gdGhlIGxhcmdlciBvZiB4IGFuZCBuXG4gIGlmIChzMC5sZW5ndGghPWspXG4gICAgczA9bmV3IEFycmF5KGspO1xuICBjb3B5SW50XyhzMCwwKTtcbiAgZm9yIChpPTA7aTxreDtpKyspIHtcbiAgICBjPXMwWzIqaV0reFtpXSp4W2ldO1xuICAgIHMwWzIqaV09YyAmIG1hc2s7XG4gICAgYz4+PWJwZTtcbiAgICBmb3IgKGo9aSsxO2o8a3g7aisrKSB7XG4gICAgICBjPXMwW2kral0rMip4W2ldKnhbal0rYztcbiAgICAgIHMwW2kral09KGMgJiBtYXNrKTtcbiAgICAgIGM+Pj1icGU7XG4gICAgfVxuICAgIHMwW2kra3hdPWM7XG4gIH1cbiAgbW9kXyhzMCxuKTtcbiAgY29weV8oeCxzMCk7XG59XG5cbi8vcmV0dXJuIHggd2l0aCBleGFjdGx5IGsgbGVhZGluZyB6ZXJvIGVsZW1lbnRzXG5mdW5jdGlvbiB0cmltKHgsaykge1xuICB2YXIgaSx5O1xuICBmb3IgKGk9eC5sZW5ndGg7IGk+MCAmJiAheFtpLTFdOyBpLS0pO1xuICB5PW5ldyBBcnJheShpK2spO1xuICBjb3B5Xyh5LHgpO1xuICByZXR1cm4geTtcbn1cblxuLy9kbyB4PXgqKnkgbW9kIG4sIHdoZXJlIHgseSxuIGFyZSBiaWdJbnRzIGFuZCAqKiBpcyBleHBvbmVudGlhdGlvbi4gIDAqKjA9MS5cbi8vdGhpcyBpcyBmYXN0ZXIgd2hlbiBuIGlzIG9kZC4gIHggdXN1YWxseSBuZWVkcyB0byBoYXZlIGFzIG1hbnkgZWxlbWVudHMgYXMgbi5cbmZ1bmN0aW9uIHBvd01vZF8oeCx5LG4pIHtcbiAgdmFyIGsxLGsyLGtuLG5wO1xuICBpZihzNy5sZW5ndGghPW4ubGVuZ3RoKVxuICAgIHM3PWR1cChuKTtcblxuICAvL2ZvciBldmVuIG1vZHVsdXMsIHVzZSBhIHNpbXBsZSBzcXVhcmUtYW5kLW11bHRpcGx5IGFsZ29yaXRobSxcbiAgLy9yYXRoZXIgdGhhbiB1c2luZyB0aGUgbW9yZSBjb21wbGV4IE1vbnRnb21lcnkgYWxnb3JpdGhtLlxuICBpZiAoKG5bMF0mMSk9PTApIHtcbiAgICBjb3B5XyhzNyx4KTtcbiAgICBjb3B5SW50Xyh4LDEpO1xuICAgIHdoaWxlKCFlcXVhbHNJbnQoeSwwKSkge1xuICAgICAgaWYgKHlbMF0mMSlcbiAgICAgICAgbXVsdE1vZF8oeCxzNyxuKTtcbiAgICAgIGRpdkludF8oeSwyKTtcbiAgICAgIHNxdWFyZU1vZF8oczcsbik7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vY2FsY3VsYXRlIG5wIGZyb20gbiBmb3IgdGhlIE1vbnRnb21lcnkgbXVsdGlwbGljYXRpb25zXG4gIGNvcHlJbnRfKHM3LDApO1xuICBmb3IgKGtuPW4ubGVuZ3RoO2tuPjAgJiYgIW5ba24tMV07a24tLSk7XG4gIG5wPXJhZGl4LWludmVyc2VNb2RJbnQobW9kSW50KG4scmFkaXgpLHJhZGl4KTtcbiAgczdba25dPTE7XG4gIG11bHRNb2RfKHggLHM3LG4pOyAgIC8vIHggPSB4ICogMioqKGtuKmJwKSBtb2QgblxuXG4gIGlmIChzMy5sZW5ndGghPXgubGVuZ3RoKVxuICAgIHMzPWR1cCh4KTtcbiAgZWxzZVxuICAgIGNvcHlfKHMzLHgpO1xuXG4gIGZvciAoazE9eS5sZW5ndGgtMTtrMT4wICYgIXlbazFdOyBrMS0tKTsgIC8vazE9Zmlyc3Qgbm9uemVybyBlbGVtZW50IG9mIHlcbiAgaWYgKHlbazFdPT0wKSB7ICAvL2FueXRoaW5nIHRvIHRoZSAwdGggcG93ZXIgaXMgMVxuICAgIGNvcHlJbnRfKHgsMSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGZvciAoazI9MTw8KGJwZS0xKTtrMiAmJiAhKHlbazFdICYgazIpOyBrMj4+PTEpOyAgLy9rMj1wb3NpdGlvbiBvZiBmaXJzdCAxIGJpdCBpbiB5W2sxXVxuICBmb3IgKDs7KSB7XG4gICAgaWYgKCEoazI+Pj0xKSkgeyAgLy9sb29rIGF0IG5leHQgYml0IG9mIHlcbiAgICAgIGsxLS07XG4gICAgICBpZiAoazE8MCkge1xuICAgICAgICBtb250Xyh4LG9uZSxuLG5wKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgazI9MTw8KGJwZS0xKTtcbiAgICB9XG4gICAgbW9udF8oeCx4LG4sbnApO1xuXG4gICAgaWYgKGsyICYgeVtrMV0pIC8vaWYgbmV4dCBiaXQgaXMgYSAxXG4gICAgICBtb250Xyh4LHMzLG4sbnApO1xuICB9XG59XG5cblxuLy9kbyB4PXgqeSpSaSBtb2QgbiBmb3IgYmlnSW50cyB4LHksbixcbi8vICB3aGVyZSBSaSA9IDIqKigta24qYnBlKSBtb2QgbiwgYW5kIGtuIGlzIHRoZVxuLy8gIG51bWJlciBvZiBlbGVtZW50cyBpbiB0aGUgbiBhcnJheSwgbm90XG4vLyAgY291bnRpbmcgbGVhZGluZyB6ZXJvcy5cbi8veCBhcnJheSBtdXN0IGhhdmUgYXQgbGVhc3QgYXMgbWFueSBlbGVtbnRzIGFzIHRoZSBuIGFycmF5XG4vL0l0J3MgT0sgaWYgeCBhbmQgeSBhcmUgdGhlIHNhbWUgdmFyaWFibGUuXG4vL211c3QgaGF2ZTpcbi8vICB4LHkgPCBuXG4vLyAgbiBpcyBvZGRcbi8vICBucCA9IC0obl4oLTEpKSBtb2QgcmFkaXhcbmZ1bmN0aW9uIG1vbnRfKHgseSxuLG5wKSB7XG4gIHZhciBpLGosYyx1aSx0LGtzO1xuICB2YXIga249bi5sZW5ndGg7XG4gIHZhciBreT15Lmxlbmd0aDtcblxuICBpZiAoc2EubGVuZ3RoIT1rbilcbiAgICBzYT1uZXcgQXJyYXkoa24pO1xuXG4gIGNvcHlJbnRfKHNhLDApO1xuXG4gIGZvciAoO2tuPjAgJiYgbltrbi0xXT09MDtrbi0tKTsgLy9pZ25vcmUgbGVhZGluZyB6ZXJvcyBvZiBuXG4gIGZvciAoO2t5PjAgJiYgeVtreS0xXT09MDtreS0tKTsgLy9pZ25vcmUgbGVhZGluZyB6ZXJvcyBvZiB5XG4gIGtzPXNhLmxlbmd0aC0xOyAvL3NhIHdpbGwgbmV2ZXIgaGF2ZSBtb3JlIHRoYW4gdGhpcyBtYW55IG5vbnplcm8gZWxlbWVudHMuXG5cbiAgLy90aGUgZm9sbG93aW5nIGxvb3AgY29uc3VtZXMgOTUlIG9mIHRoZSBydW50aW1lIGZvciByYW5kVHJ1ZVByaW1lXygpIGFuZCBwb3dNb2RfKCkgZm9yIGxhcmdlIG51bWJlcnNcbiAgZm9yIChpPTA7IGk8a247IGkrKykge1xuICAgIHQ9c2FbMF0reFtpXSp5WzBdO1xuICAgIHVpPSgodCAmIG1hc2spICogbnApICYgbWFzazsgIC8vdGhlIGlubmVyIFwiJiBtYXNrXCIgd2FzIG5lZWRlZCBvbiBTYWZhcmkgKGJ1dCBub3QgTVNJRSkgYXQgb25lIHRpbWVcbiAgICBjPSh0K3VpKm5bMF0pID4+IGJwZTtcbiAgICB0PXhbaV07XG5cbiAgICAvL2RvIHNhPShzYSt4W2ldKnkrdWkqbikvYiAgIHdoZXJlIGI9MioqYnBlLiAgTG9vcCBpcyB1bnJvbGxlZCA1LWZvbGQgZm9yIHNwZWVkXG4gICAgaj0xO1xuICAgIGZvciAoO2o8a3ktNDspIHsgYys9c2Fbal0rdWkqbltqXSt0Knlbal07ICAgc2Fbai0xXT1jICYgbWFzazsgICBjPj49YnBlOyAgIGorKztcbiAgICAgICAgICAgICAgICAgICAgIGMrPXNhW2pdK3VpKm5bal0rdCp5W2pdOyAgIHNhW2otMV09YyAmIG1hc2s7ICAgYz4+PWJwZTsgICBqKys7XG4gICAgICAgICAgICAgICAgICAgICBjKz1zYVtqXSt1aSpuW2pdK3QqeVtqXTsgICBzYVtqLTFdPWMgJiBtYXNrOyAgIGM+Pj1icGU7ICAgaisrO1xuICAgICAgICAgICAgICAgICAgICAgYys9c2Fbal0rdWkqbltqXSt0Knlbal07ICAgc2Fbai0xXT1jICYgbWFzazsgICBjPj49YnBlOyAgIGorKztcbiAgICAgICAgICAgICAgICAgICAgIGMrPXNhW2pdK3VpKm5bal0rdCp5W2pdOyAgIHNhW2otMV09YyAmIG1hc2s7ICAgYz4+PWJwZTsgICBqKys7IH1cbiAgICBmb3IgKDtqPGt5OykgICB7IGMrPXNhW2pdK3VpKm5bal0rdCp5W2pdOyAgIHNhW2otMV09YyAmIG1hc2s7ICAgYz4+PWJwZTsgICBqKys7IH1cbiAgICBmb3IgKDtqPGtuLTQ7KSB7IGMrPXNhW2pdK3VpKm5bal07ICAgICAgICAgIHNhW2otMV09YyAmIG1hc2s7ICAgYz4+PWJwZTsgICBqKys7XG4gICAgICAgICAgICAgICAgICAgICBjKz1zYVtqXSt1aSpuW2pdOyAgICAgICAgICBzYVtqLTFdPWMgJiBtYXNrOyAgIGM+Pj1icGU7ICAgaisrO1xuICAgICAgICAgICAgICAgICAgICAgYys9c2Fbal0rdWkqbltqXTsgICAgICAgICAgc2Fbai0xXT1jICYgbWFzazsgICBjPj49YnBlOyAgIGorKztcbiAgICAgICAgICAgICAgICAgICAgIGMrPXNhW2pdK3VpKm5bal07ICAgICAgICAgIHNhW2otMV09YyAmIG1hc2s7ICAgYz4+PWJwZTsgICBqKys7XG4gICAgICAgICAgICAgICAgICAgICBjKz1zYVtqXSt1aSpuW2pdOyAgICAgICAgICBzYVtqLTFdPWMgJiBtYXNrOyAgIGM+Pj1icGU7ICAgaisrOyB9XG4gICAgZm9yICg7ajxrbjspICAgeyBjKz1zYVtqXSt1aSpuW2pdOyAgICAgICAgICBzYVtqLTFdPWMgJiBtYXNrOyAgIGM+Pj1icGU7ICAgaisrOyB9XG4gICAgZm9yICg7ajxrczspICAgeyBjKz1zYVtqXTsgICAgICAgICAgICAgICAgICBzYVtqLTFdPWMgJiBtYXNrOyAgIGM+Pj1icGU7ICAgaisrOyB9XG4gICAgc2Fbai0xXT1jICYgbWFzaztcbiAgfVxuXG4gIGlmICghZ3JlYXRlcihuLHNhKSlcbiAgICBzdWJfKHNhLG4pO1xuICBjb3B5Xyh4LHNhKTtcbn1cblxuaWYgKHR5cGVvZiBtb2R1bGUgPT09ICd1bmRlZmluZWQnKSB7XG5cdG1vZHVsZSA9IHt9O1xufVxuQmlnSW50ID0gbW9kdWxlLmV4cG9ydHMgPSB7XG5cdCdhZGQnOiBhZGQsICdhZGRJbnQnOiBhZGRJbnQsICdiaWdJbnQyc3RyJzogYmlnSW50MnN0ciwgJ2JpdFNpemUnOiBiaXRTaXplLFxuXHQnZHVwJzogZHVwLCAnZXF1YWxzJzogZXF1YWxzLCAnZXF1YWxzSW50JzogZXF1YWxzSW50LCAnZXhwYW5kJzogZXhwYW5kLFxuXHQnZmluZFByaW1lcyc6IGZpbmRQcmltZXMsICdHQ0QnOiBHQ0QsICdncmVhdGVyJzogZ3JlYXRlcixcblx0J2dyZWF0ZXJTaGlmdCc6IGdyZWF0ZXJTaGlmdCwgJ2ludDJiaWdJbnQnOiBpbnQyYmlnSW50LFxuXHQnaW52ZXJzZU1vZCc6IGludmVyc2VNb2QsICdpbnZlcnNlTW9kSW50JzogaW52ZXJzZU1vZEludCwgJ2lzWmVybyc6IGlzWmVybyxcblx0J21pbGxlclJhYmluJzogbWlsbGVyUmFiaW4sICdtaWxsZXJSYWJpbkludCc6IG1pbGxlclJhYmluSW50LCAnbW9kJzogbW9kLFxuXHQnbW9kSW50JzogbW9kSW50LCAnbXVsdCc6IG11bHQsICdtdWx0TW9kJzogbXVsdE1vZCwgJ25lZ2F0aXZlJzogbmVnYXRpdmUsXG5cdCdwb3dNb2QnOiBwb3dNb2QsICdyYW5kQmlnSW50JzogcmFuZEJpZ0ludCwgJ3JhbmRUcnVlUHJpbWUnOiByYW5kVHJ1ZVByaW1lLFxuXHQncmFuZFByb2JQcmltZSc6IHJhbmRQcm9iUHJpbWUsICdzdHIyYmlnSW50Jzogc3RyMmJpZ0ludCwgJ3N1Yic6IHN1Yixcblx0J3RyaW0nOiB0cmltLCAnYWRkSW50Xyc6IGFkZEludF8sICdhZGRfJzogYWRkXywgJ2NvcHlfJzogY29weV8sXG5cdCdjb3B5SW50Xyc6IGNvcHlJbnRfLCAnR0NEXyc6IEdDRF8sICdpbnZlcnNlTW9kXyc6IGludmVyc2VNb2RfLCAnbW9kXyc6IG1vZF8sXG5cdCdtdWx0Xyc6IG11bHRfLCAnbXVsdE1vZF8nOiBtdWx0TW9kXywgJ3Bvd01vZF8nOiBwb3dNb2RfLFxuXHQncmFuZEJpZ0ludF8nOiByYW5kQmlnSW50XywgJ3JhbmRUcnVlUHJpbWVfJzogcmFuZFRydWVQcmltZV8sICdzdWJfJzogc3ViXyxcblx0J2FkZFNoaWZ0Xyc6IGFkZFNoaWZ0XywgJ2NhcnJ5Xyc6IGNhcnJ5XywgJ2RpdmlkZV8nOiBkaXZpZGVfLFxuXHQnZGl2SW50Xyc6IGRpdkludF8sICdlR0NEXyc6IGVHQ0RfLCAnaGFsdmVfJzogaGFsdmVfLCAnbGVmdFNoaWZ0Xyc6IGxlZnRTaGlmdF8sXG5cdCdsaW5Db21iXyc6IGxpbkNvbWJfLCAnbGluQ29tYlNoaWZ0Xyc6IGxpbkNvbWJTaGlmdF8sICdtb250Xyc6IG1vbnRfLFxuXHQnbXVsdEludF8nOiBtdWx0SW50XywgJ3JpZ2h0U2hpZnRfJzogcmlnaHRTaGlmdF8sICdzcXVhcmVNb2RfJzogc3F1YXJlTW9kXyxcblx0J3N1YlNoaWZ0Xyc6IHN1YlNoaWZ0XywgJ3Bvd01vZF8nOiBwb3dNb2RfLCAnZUdDRF8nOiBlR0NEXyxcblx0J2ludmVyc2VNb2RfJzogaW52ZXJzZU1vZF8sICdHQ0RfJzogR0NEXywgJ21vbnRfJzogbW9udF8sICdkaXZpZGVfJzogZGl2aWRlXyxcblx0J3NxdWFyZU1vZF8nOiBzcXVhcmVNb2RfLCAncmFuZFRydWVQcmltZV8nOiByYW5kVHJ1ZVByaW1lXyxcblx0J21pbGxlclJhYmluJzogbWlsbGVyUmFiaW5cbn07XG5cbn0pKCk7XG4iLCJ2YXIgU29ydGVkQXJyYXkgPSByZXF1aXJlKCdzb3J0ZWQtY21wLWFycmF5Jyk7XG5cbi8qIVxuICogXFxicmllZiBhcnJheSBjb250YWluaW5nIHRoZSBsaXN0IG9mIHNvY2tldHMgdGFyZ2V0aW5nIHRoaXMgcGVlclxuICovXG5mdW5jdGlvbiBJblZpZXcoKXtcbiAgICB0aGlzLnNvY2tldHMgPSBuZXcgU29ydGVkQXJyYXkoZnVuY3Rpb24oYSxiKXtcbiAgICAgICAgdmFyIGZpcnN0ID0gYS5pZCB8fCBhO1xuICAgICAgICB2YXIgc2Vjb25kID0gYi5pZCB8fCBiO1xuICAgICAgICBpZiAoZmlyc3QgPCBzZWNvbmQpIHsgcmV0dXJuIC0xfTtcbiAgICAgICAgaWYgKGZpcnN0ID4gc2Vjb25kKSB7IHJldHVybiAgMX07XG4gICAgICAgIHJldHVybiAwO1xuICAgIH0pO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGFkZCBhbiBlbGVtZW50IHRvIHRoZSBpbnZpZXdcbiAqIFxccGFyYW0gc29ja2V0IHRoZSBzb2NrZXQgdG8gYWRkIGluIHRoZSBpbnZpZXdcbiAqIFxccGFyYW0gaWQgYSB1bmlxdWUgaWRlbnRpZmllciBvZiB0aGUgc29ja2V0XG4gKi9cbkluVmlldy5wcm90b3R5cGUuYWRkID0gZnVuY3Rpb24oc29ja2V0LCBpZCl7XG4gICAgdGhpcy5zb2NrZXRzLmluc2VydCh7aWQ6aWQsIHNvY2tldDpzb2NrZXR9KTtcbn07XG5cbi8qIVxuICogXFxicmllZiByZW1vdmUgdGhlIHRhcmdldGVkIHNvY2tldCBmcm9tIHRoZSBpbnZpZXdcbiAqIFxccGFyYW0gaWQgdGhlIGlkZW50aWZpZXIgb2YgdGhlIGludmlld1xuICogXFxyZXR1cm4gdGhlIHNvY2tldCByZW1vdmVkIGZyb20gdGhlIGludmlldywgbnVsbCBpZiBub3QgZm91bmRcbiAqL1xuSW5WaWV3LnByb3RvdHlwZS5yZW1vdmUgPSBmdW5jdGlvbihpZCl7XG4gICAgdmFyIGluZGV4ID0gdGhpcy5zb2NrZXRzLmluZGV4T2YoaWQpLFxuICAgICAgICBzb2NrZXQgPSBudWxsO1xuICAgIGlmIChpbmRleCA+PSAwKXtcbiAgICAgICAgc29ja2V0ID0gdGhpcy5zb2NrZXRzLmFycltpbmRleF07XG4gICAgICAgIHRoaXMuc29ja2V0cy5hcnIuc3BsaWNlKGluZGV4LCAxKTtcbiAgICB9O1xuICAgIHJldHVybiBzb2NrZXQ7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0IHRoZSBsZW5ndGggb2YgdGhlIGFycmF5XG4gKi9cbkluVmlldy5wcm90b3R5cGUubGVuZ3RoID0gZnVuY3Rpb24oKXtcbiAgICByZXR1cm4gdGhpcy5zb2NrZXRzLmFyci5sZW5ndGg7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgY2xlYXIgdGhlIHdob2xlIGludmlldyBhbmQgY2xvc2UgdGhlIHNvY2tldHNcbiAqL1xuSW5WaWV3LnByb3RvdHlwZS5jbGVhciA9IGZ1bmN0aW9uKCl7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLnNvY2tldHMuYXJyLmxlbmd0aDsgKytpKXtcbiAgICAgICAgdGhpcy5zb2NrZXRzLmFycltpXS5zb2NrZXQuZGVzdHJveSgpO1xuICAgIH07XG4gICAgdGhpcy5zb2NrZXRzLmFyci5zcGxpY2UoMCwgdGhpcy5zb2NrZXRzLmFyci5sZW5ndGgpO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBJblZpZXc7XG4iLCIvKiFcbiAqIE1Kb2luKGlkKVxuICogTVJlcXVlc3RUaWNrZXQoaWQpXG4gKiBNT2ZmZXJUaWNrZXQoaWQsIHRpY2tldCwgcGVlcilcbiAqIE1TdGFtcGVkVGlja2V0KGlkLCB0aWNrZXQsIHBlZXIpXG4gKiBNRXhjaGFuZ2UoaWQsIHBlZXIpXG4gKi9cblxuLyohXG4gKiBcXGJyaWVmIG1lc3NhZ2UgcmVxdWVzdGluZyB0byBqb2luIHRoZSBuZXR3b3JrXG4gKiBcXHBhcmFtIGlkIHRoZSBpZGVudGlmaWVyIG9mIHRoZSBqb2luIG1lc3NhZ2VcbiAqL1xuZnVuY3Rpb24gTUpvaW4oaWQpe1xuICAgIHRoaXMucHJvdG9jb2wgPSAnc3ByYXknO1xuICAgIHRoaXMudHlwZSA9ICdNSm9pbic7XG4gICAgdGhpcy5pZCA9IGlkO1xufTtcbm1vZHVsZS5leHBvcnRzLk1Kb2luID0gTUpvaW47XG5cbi8qIVxuICogXFxicmllZiBtZXNzYWdlIHJlcXVlc3RpbmcgYW4gb2ZmZXIgdGlja2V0XG4gKiBcXHBhcmFtIGlkIHRoZSBpZGVudGlmaWVyIG9mIHRoZSByZXF1ZXN0IG1lc3NhZ2VcbiAqL1xuZnVuY3Rpb24gTVJlcXVlc3RUaWNrZXQoaWQpe1xuICAgIHRoaXMucHJvdG9jb2wgPSAnc3ByYXknO1xuICAgIHRoaXMudHlwZSA9ICdNUmVxdWVzdFRpY2tldCc7XG4gICAgdGhpcy5pZCA9IGlkO1xufTtcbm1vZHVsZS5leHBvcnRzLk1SZXF1ZXN0VGlja2V0ID0gTVJlcXVlc3RUaWNrZXQ7XG5cbi8qIVxuICogXFxicmllZiBhbiBvZmZlciB0aWNrZXQgY29udGFpbmluZyB0aGUgZmlyc3QgcGFydCBvZiB0aGUgd2VicnRjIGNvbm5lY3Rpb25cbiAqIGVzdGFibGlzaG1lbnRcbiAqIFxccGFyYW0gaWQgdGhlIHVuaXF1ZSBpZGVudGlmaWVyIG9mIHRoZSByZXF1ZXN0IG1lc3NhZ2VcbiAqIFxccGFyYW0gdGlja2V0IHRoZSBmaXJzdCBzdGVwIG9mIHRoZSBjb25uZWN0aW9uIGVzdGFibGlzaGVtZW50IGRhdGFcbiAqIFxccGFyYW0gcGVlciB0aGUgcGVlciB0aGF0IGVtaXQgdGhlIG9mZmVyIHRpY2tldFxuICovXG5mdW5jdGlvbiBNT2ZmZXJUaWNrZXQoaWQsIHRpY2tldCwgcGVlcil7XG4gICAgdGhpcy5wcm90b2NvbCA9ICdzcHJheSc7XG4gICAgdGhpcy50eXBlID0gJ01PZmZlclRpY2tldCc7XG4gICAgdGhpcy5pZCA9IGlkO1xuICAgIHRoaXMudGlja2V0ID0gdGlja2V0O1xuICAgIHRoaXMucGVlciA9IHBlZXI7XG59O1xubW9kdWxlLmV4cG9ydHMuTU9mZmVyVGlja2V0ID0gTU9mZmVyVGlja2V0O1xuXG4vKiFcbiAqIFxcYnJpZWYgYW4gc3RhbXBlZCB0aWNrZXQgY29udGFpbmluZyB0aGUgc2Vjb25kIHBhcnQgb2YgdGhlIHdlYnJ0YyBjb25uZWN0aW9uXG4gKiBlc3RhYmxpc2hlbWVudFxuICogXFxwYXJhbSBpZCB0aGUgdW5pcXVlIGlkZW50aWZpZXIgb2YgdGhlIHJlcXVlc3QgdGlja2V0XG4gKiBcXHBhcmFtIHRpY2tldCB0aGUgc2Vjb25kIHN0ZXAgb2YgdGhlIGNvbm5lY3Rpb24gZXN0YWJsaXNoZW1lbnQgZGF0YVxuICogXFxwYXJhbSBwZWVyIHRoZSBwZWVyIHRoYXQgZW1pdCB0aGUgc3RhbXBlZCB0aWNrZXRcbiAqL1xuZnVuY3Rpb24gTVN0YW1wZWRUaWNrZXQoaWQsIHRpY2tldCwgcGVlcil7XG4gICAgdGhpcy5wcm90b2NvbCA9ICdzcHJheSc7XG4gICAgdGhpcy50eXBlID0gJ01TdGFtcGVkVGlja2V0JztcbiAgICB0aGlzLmlkID0gaWQ7XG4gICAgdGhpcy50aWNrZXQgPSB0aWNrZXQ7XG4gICAgdGhpcy5wZWVyID0gcGVlcjtcbn07XG5tb2R1bGUuZXhwb3J0cy5NU3RhbXBlZFRpY2tldCA9IE1TdGFtcGVkVGlja2V0O1xuXG4vKiFcbiAqIFxcYnJpZWYgbWVzc2FnZSByZXF1ZXN0aW5nIGFuIGV4Y2hhbmdlIG9mIG5laWdoYm9yaG9vZFxuICogXFxwYXJhbSBpZCB0aGUgaWRlbnRpZmllciBvZiB0aGUgcmVxdWVzdCBtZXNzYWdlXG4gKiBcXHBhcmFtIHBlZXIgdGhlIGlkZW50aXR5IG9mIHRoZSBpbml0aWF0b3Igb2YgdGhlIGV4Y2hhbmdlXG4gKi9cbmZ1bmN0aW9uIE1FeGNoYW5nZShpZCwgcGVlcil7XG4gICAgdGhpcy5wcm90b2NvbCA9ICdzcHJheSc7XG4gICAgdGhpcy50eXBlID0gJ01FeGNoYW5nZSc7XG4gICAgdGhpcy5pZCA9IGlkO1xuICAgIHRoaXMucGVlciA9IHBlZXI7XG59O1xubW9kdWxlLmV4cG9ydHMuTUV4Y2hhbmdlID0gTUV4Y2hhbmdlO1xuIiwidmFyIFNvcnRlZEFycmF5ID0gcmVxdWlyZShcInNvcnRlZC1jbXAtYXJyYXlcIik7XG5cbi8qIVxuICogXFxicmllZiBjb21wYXJhdG9yXG4gKiBcXHBhcmFtIGEgdGhlIGZpcnN0IG9iamVjdCBpbmNsdWRpbmcgYW4gJ2FnZScgcHJvcGVydHlcbiAqIFxccGFyYW0gYiB0aGUgc2Vjb25kIG9iamVjdCBpbmNsdWRpbmcgYW4gJ2FnZScgcHJvcGVydHlcbiAqIFxccmV0dXJuIDEgaWYgYS5hZ2UgPiBiLmFnZSwgLTEgaWYgYS5hZ2UgPCBiLmFnZSwgMCBvdGhlcndpc2VcbiAqL1xuZnVuY3Rpb24gY29tcChhLCBiKXtcbiAgICBpZiAoYS5hZ2UgPCBiLmFnZSl7IHJldHVybiAtMTt9O1xuICAgIGlmIChhLmFnZSA+IGIuYWdlKXsgcmV0dXJuICAxO307XG4gICAgcmV0dXJuIDA7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgc3RydWN0dXJlIGNvbnRhaW5pbmcgdGhlIG5laWdoYm9yaG9vZCBvZiBhIHBlZXIuXG4gKi9cbmZ1bmN0aW9uIFBhcnRpYWxWaWV3KCl7XG4gICAgLy8gIzEgaW5pdGlhbGl6ZSB0aGUgcGFydGlhbCB2aWV3IGFzIGFuIGFycmF5IHNvcnRlZCBieSBhZ2VcbiAgICB0aGlzLmFycmF5ID0gbmV3IFNvcnRlZEFycmF5KGNvbXApO1xufTtcblxuLyohXG4gKiBcXHJldHVybiB0aGUgb2xkZXN0IHBlZXIgaW4gdGhlIGFycmF5XG4gKi9cblBhcnRpYWxWaWV3LnByb3RvdHlwZS5nZXRPbGRlc3QgPSBmdW5jdGlvbigpe1xuICAgIHJldHVybiB0aGlzLmFycmF5LmFyclswXTtcbn07XG5cbi8qIVxuICogXFxicmllZiBpbmNyZW1lbnQgdGhlIGFnZSBvZiB0aGUgd2hvbGUgcGFydGlhbCB2aWV3XG4gKi9cblBhcnRpYWxWaWV3LnByb3RvdHlwZS5pbmNyZW1lbnRBZ2UgPSBmdW5jdGlvbigpe1xuICAgIGZvciAodmFyIGk9MDsgaTx0aGlzLmFycmF5LmFyci5sZW5ndGg7ICsraSl7XG4gICAgICAgIHRoaXMuYXJyYXkuYXJyW2ldLmFnZSArPSAxO1xuICAgIH07XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0IGEgc2FtcGxlIG9mIHRoZSBwYXJ0aWFsIHRvIHNlbmQgdG8gdGhlIG5laWdoYm9yXG4gKiBcXHBhcmFtIG5laWdoYm9yIHRoZSBuZWlnaGJvciB3aGljaCBwZXJmb3JtcyB0aGUgZXhjaGFuZ2Ugd2l0aCB1c1xuICogXFxwYXJhbSBpc0luaXRpYXRvciB3aGV0aGVyIG9yIG5vdCB0aGUgY2FsbGVyIGlzIHRoZSBpbml0aWF0b3Igb2YgdGhlXG4gKiBleGNoYW5nZVxuICogXFxyZXR1cm4gYW4gYXJyYXkgY29udGFpbmluZyBuZWlnaGJvcnMgZnJvbSB0aGlzIHBhcnRpYWwgdmlld1xuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUuZ2V0U2FtcGxlID0gZnVuY3Rpb24obmVpZ2hib3IsIGlzSW5pdGlhdG9yKXtcbiAgICB2YXIgc2FtcGxlID0gW107XG4gICAgLy8gIzEgY29weSB0aGUgcGFydGlhbCB2aWV3XG4gICAgdmFyIGNsb25lID0gbmV3IFNvcnRlZEFycmF5KGNvbXApO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdGhpcy5hcnJheS5hcnIubGVuZ3RoOyArK2kpe1xuICAgICAgICBjbG9uZS5hcnIucHVzaCh0aGlzLmFycmF5LmFycltpXSk7XG4gICAgfTtcblxuICAgIC8vICMyIHByb2Nlc3MgdGhlIHNpemUgb2YgdGhlIHNhbXBsZVxuICAgIHZhciBzYW1wbGVTaXplID0gTWF0aC5jZWlsKHRoaXMuYXJyYXkuYXJyLmxlbmd0aC8yKTtcbiAgICBcbiAgICBpZiAoaXNJbml0aWF0b3Ipe1xuICAgICAgICAvLyAjQSByZW1vdmUgYW4gb2NjdXJyZW5jZSBvZiB0aGUgY2hvc2VuIG5laWdoYm9yXG4gICAgICAgIHZhciBpbmRleCA9IGNsb25lLmluZGV4T2YobmVpZ2hib3IpO1xuICAgICAgICBzYW1wbGUucHVzaChjbG9uZS5hcnJbaW5kZXhdKTsgXG4gICAgICAgIGNsb25lLmFyci5zcGxpY2UoaW5kZXgsIDEpO1xuICAgIH07XG4gICAgXG4gICAgLy8gIzMgcmFuZG9tbHkgYWRkIG5laWdoYm9ycyB0byB0aGUgc2FtcGxlXG4gICAgd2hpbGUgKHNhbXBsZS5sZW5ndGggPCBzYW1wbGVTaXplKXtcbiAgICAgICAgdmFyIHJuID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKmNsb25lLmFyci5sZW5ndGgpO1xuICAgICAgICBzYW1wbGUucHVzaChjbG9uZS5hcnJbcm5dKTtcbiAgICAgICAgY2xvbmUuYXJyLnNwbGljZShybiwgMSk7XG4gICAgfTtcbiAgICBcbiAgICByZXR1cm4gc2FtcGxlO1xufTtcblxuXG5cbi8qIVxuICogXFxicmllZiByZXBsYWNlIHRoZSBvY2N1cnJlbmNlcyBvZiB0aGUgb2xkIHBlZXIgYnkgdGhlIGZyZXNoIG9uZVxuICogXFxwYXJhbSBzYW1wbGUgdGhlIHNhbXBsZSB0byBtb2RpZnlcbiAqIFxccGFyYW0gb2xkIHRoZSBvbGQgcmVmZXJlbmNlIHRvIHJlcGxhY2VcbiAqIFxccGFyYW0gZnJlc2ggdGhlIG5ldyByZWZlcmVuY2UgdG8gaW5zZXJ0XG4gKiBcXHJldHVybiBhbiBhcnJheSB3aXRoIHRoZSByZXBsYWNlZCBvY2N1cmVuY2VzXG4gKi9cblBhcnRpYWxWaWV3LnByb3RvdHlwZS5yZXBsYWNlID0gZnVuY3Rpb24oc2FtcGxlLCBvbGQsIGZyZXNoKXtcbiAgICB2YXIgcmVzdWx0ID0gW107XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzYW1wbGUubGVuZ3RoOyArK2kpe1xuICAgICAgICBpZiAoc2FtcGxlW2ldLmlkID09PSBvbGQuaWQpe1xuICAgICAgICAgICAgcmVzdWx0LnB1c2goZnJlc2gpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmVzdWx0LnB1c2goc2FtcGxlW2ldKTtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIHJldHVybiByZXN1bHQ7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgYWRkIHRoZSBuZWlnYmhvciB0byB0aGUgcGFydGlhbCB2aWV3IHdpdGggYW4gYWdlIG9mIDBcbiAqIFxccGFyYW0gcGVlciB0aGUgcGVlciB0byBhZGQgdG8gdGhlIHBhcnRpYWwgdmlld1xuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUuYWRkTmVpZ2hib3IgPSBmdW5jdGlvbihwZWVyKXtcbiAgICBwZWVyLmFnZSA9IDA7XG4gICAgdGhpcy5hcnJheS5hcnIucHVzaChwZWVyKTtcbn07XG5cblxuLyohXG4gKiBcXGJyaWVmIGdldCB0aGUgaW5kZXggb2YgdGhlIHBlZXIgaW4gdGhlIHBhcnRpYWx2aWV3XG4gKiBcXHJldHVybiB0aGUgaW5kZXggb2YgdGhlIHBlZXIgaW4gdGhlIGFycmF5LCAtMSBpZiBub3QgZm91bmRcbiAqL1xuUGFydGlhbFZpZXcucHJvdG90eXBlLmdldEluZGV4ID0gZnVuY3Rpb24ocGVlcil7XG4gICAgdmFyIGkgPSAwLFxuICAgICAgICBpbmRleCA9IC0xO1xuICAgICAgICBmb3VuZCA9IGZhbHNlO1xuICAgIHdoaWxlICghZm91bmQgJiYgaSA8IHRoaXMuYXJyYXkuYXJyLmxlbmd0aCl7XG4gICAgICAgIGlmIChwZWVyLmlkID09PSB0aGlzLmFycmF5LmFycltpXS5pZCl7XG4gICAgICAgICAgICBmb3VuZCA9IHRydWU7XG4gICAgICAgICAgICBpbmRleCA9IGk7XG4gICAgICAgIH07XG4gICAgICAgICsraTtcbiAgICB9O1xuICAgIHJldHVybiBpbmRleDtcbn07XG5cbi8qIVxuICogXFxicmllZiByZW1vdmUgdGhlIHBlZXIgZnJvbSB0aGUgcGFydGlhbCB2aWV3XG4gKiBcXHBhcmFtIHBlZXIgdGhlIHBlZXIgdG8gcmVtb3ZlXG4gKiBcXHJldHVybiB0aGUgcmVtb3ZlZCBlbnRyeSBpZiBpdCBleGlzdHMsIG51bGwgb3RoZXJ3aXNlXG4gKi9cblBhcnRpYWxWaWV3LnByb3RvdHlwZS5yZW1vdmVQZWVyID0gZnVuY3Rpb24ocGVlcil7XG4gICAgdmFyIGluZGV4ID0gdGhpcy5nZXRJbmRleChwZWVyKSxcbiAgICAgICAgcmVtb3ZlZEVudHJ5ID0gbnVsbDtcbiAgICBpZiAoaW5kZXggPiAtMSl7XG4gICAgICAgIHJlbW92ZWRFbnRyeSA9IHRoaXMuYXJyYXkuYXJyW2luZGV4XTtcbiAgICAgICAgdGhpcy5hcnJheS5hcnIuc3BsaWNlKGluZGV4LCAxKTtcbiAgICB9O1xuICAgIHJldHVybiByZW1vdmVkRW50cnk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgcmVtb3ZlIHRoZSBwZWVyIHdpdGggdGhlIGFzc29jaWF0ZWQgYWdlIGZyb20gdGhlIHBhcnRpYWwgdmlld1xuICogXFxwYXJhbSBwZWVyIHRoZSBwZWVyIHRvIHJlbW92ZVxuICogXFxwYXJhbSBhZ2UgdGhlIGFnZSBvZiB0aGUgcGVlciB0byByZW1vdmVcbiAqIFxccmV0dXJuIHRoZSByZW1vdmVkIGVudHJ5IGlmIGl0IGV4aXN0cywgbnVsbCBvdGhlcndpc2VcbiAqL1xuUGFydGlhbFZpZXcucHJvdG90eXBlLnJlbW92ZVBlZXJBZ2UgPSBmdW5jdGlvbihwZWVyLCBhZ2Upe1xuICAgIHZhciBmb3VuZCA9IGZhbHNlLFxuICAgICAgICBpID0gMCxcbiAgICAgICAgcmVtb3ZlZEVudHJ5ID0gbnVsbDtcbiAgICB3aGlsZSghZm91bmQgJiYgaSA8IHRoaXMuYXJyYXkuYXJyLmxlbmd0aCl7XG4gICAgICAgIGlmIChwZWVyLmlkID09PSB0aGlzLmFycmF5LmFycltpXS5pZCAmJiBhZ2UgPT09IHRoaXMuYXJyYXkuYXJyW2ldLmFnZSl7XG4gICAgICAgICAgICBmb3VuZCA9IHRydWU7XG4gICAgICAgICAgICByZW1vdmVkRW50cnkgPSB0aGlzLmFycmF5LmFycltpXTtcbiAgICAgICAgICAgIHRoaXMuYXJyYXkuYXJyLnNwbGljZShpLCAxKTtcbiAgICAgICAgfTtcbiAgICAgICAgKytpO1xuICAgIH07XG4gICAgcmV0dXJuIHJlbW92ZWRFbnRyeTtcbn07XG5cbi8qIVxuICogXFxicmllZiByZW1vdmUgYWxsIG9jY3VycmVuY2VzIG9mIHRoZSBwZWVyIGFuZCByZXR1cm4gdGhlIG51bWJlciBvZiByZW1vdmFsc1xuICogXFxwYXJhbSBwZWVyIHRoZSBwZWVyIHRvIHJlbW92ZVxuICogXFxyZXR1cm4gdGhlIG51bWJlciBvZiBvY2N1cnJlbmNlcyBvZiB0aGUgcmVtb3ZlZCBwZWVyXG4gKi9cblBhcnRpYWxWaWV3LnByb3RvdHlwZS5yZW1vdmVBbGwgPSBmdW5jdGlvbihwZWVyKXtcbiAgICB2YXIgb2NjID0gMCxcbiAgICAgICAgaSA9IDA7XG4gICAgd2hpbGUgKGkgPCB0aGlzLmFycmF5LmFyci5sZW5ndGgpe1xuICAgICAgICBpZiAodGhpcy5hcnJheS5hcnJbaV0uaWQgPT09IHBlZXIuaWQpe1xuICAgICAgICAgICAgdGhpcy5hcnJheS5hcnIuc3BsaWNlKGksIDEpO1xuICAgICAgICAgICAgb2NjICs9IDE7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICArK2k7XG4gICAgICAgIH07XG4gICAgfTtcbiAgICByZXR1cm4gb2NjO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHJlbW92ZSBhbGwgdGhlIGVsZW1lbnRzIGNvbnRhaW5lZCBpbiB0aGUgc2FtcGxlIGluIGFyZ3VtZW50XG4gKiBcXHBhcmFtIHNhbXBsZSB0aGUgZWxlbWVudHMgdG8gcmVtb3ZlXG4gKi9cblBhcnRpYWxWaWV3LnByb3RvdHlwZS5yZW1vdmVTYW1wbGUgPSBmdW5jdGlvbihzYW1wbGUpe1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc2FtcGxlLmxlbmd0aDsgKytpKXtcbiAgICAgICAgdGhpcy5yZW1vdmVQZWVyQWdlKHNhbXBsZVtpXSwgc2FtcGxlW2ldLmFnZSk7XG4gICAgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiBnZXQgdGhlIHNpemUgb2YgdGhlIHBhcnRpYWwgdmlld1xuICogXFxyZXR1cm4gdGhlIHNpemUgb2YgdGhlIHBhcnRpYWwgdmlld1xuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUubGVuZ3RoID0gZnVuY3Rpb24oKXtcbiAgICByZXR1cm4gdGhpcy5hcnJheS5hcnIubGVuZ3RoO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNoZWNrIGlmIHRoZSBwYXJ0aWFsIHZpZXcgY29udGFpbnMgdGhlIHJlZmVyZW5jZVxuICogXFxwYXJhbSBwZWVyIHRoZSBwZWVyIHRvIGNoZWNrXG4gKiBcXHJldHVybiB0cnVlIGlmIHRoZSBwZWVyIGlzIGluIHRoZSBwYXJ0aWFsIHZpZXcsIGZhbHNlIG90aGVyd2lzZVxuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUuY29udGFpbnMgPSBmdW5jdGlvbihwZWVyKXtcbiAgICByZXR1cm4gdGhpcy5nZXRJbmRleChwZWVyKT49MDtcbn07XG5cbi8qIVxuICogXFxicmllZiByZW1vdmUgYWxsIGVsZW1lbnRzIGZyb20gdGhlIHBhcnRpYWwgdmlld1xuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUuY2xlYXIgPSBmdW5jdGlvbigpe1xuICAgIHRoaXMuYXJyYXkuYXJyLnNwbGljZSgwLCB0aGlzLmFycmF5LmFyci5sZW5ndGgpO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBQYXJ0aWFsVmlldztcbiIsInZhciBTb3J0ZWRBcnJheSA9IHJlcXVpcmUoXCJzb3J0ZWQtY21wLWFycmF5XCIpO1xuXG4vKiFcbiAqIFxcYnJpZWYgcmVwcmVzZW50IHRoZSBhcnJheSBjb250YWluaW5nIHRoZSBzb2NrZXRzIGFzc29jaWF0ZWQgd2l0aFxuICogYSB1bmlxdWUgaWRlbnRpZmllciBpZFxuICovXG5mdW5jdGlvbiBTb2NrZXRzKCl7XG4gICAgdGhpcy5hcnJheSA9IG5ldyBTb3J0ZWRBcnJheShcbiAgICAgICAgZnVuY3Rpb24oYSwgYil7XG4gICAgICAgICAgICBpZiAoYS5pZCA8IGIuaWQpeyByZXR1cm4gLTE7IH07XG4gICAgICAgICAgICBpZiAoYS5pZCA+IGIuaWQpeyByZXR1cm4gIDE7IH07XG4gICAgICAgICAgICByZXR1cm4gMDtcbiAgICAgICAgfVxuICAgICk7XG4gICAgdGhpcy5sYXN0Q2hhbmNlID0gbnVsbDsgLy8gbGFzdCBjaGFuY2Ugc29ja2V0LlxufTtcblxuLyohXG4gKiBcXGJyaWVmIGFkZCB0aGUgc29ja2V0IHdpdGggYW4gb2JqZWN0IGNvbnRhaW5pbmcgYW4gaWRlbnRpZmllciBcbiAqIFxccGFyYW0gc29ja2V0IHRoZSBzb2NrZXQgdG8gY29tbXVuaWNhdGUgd2l0aCBwZWVyXG4gKiBcXHBhcmFtIG9iamVjdCB0aGUgb2JqZWN0IGNvbnRhaW5pbmcgdGhlIGlkZW50aWZpZXJcbiAqIFxccmV0dXJuIHRydWUgaWYgdGhlIHNvY2tldCBhcyBiZWVuIGFkZGVkLCBmYWxzZSBvdGhlcndpc2VcbiAqLyBcblNvY2tldHMucHJvdG90eXBlLmFkZFNvY2tldCA9IGZ1bmN0aW9uKHNvY2tldCwgb2JqZWN0KXtcbiAgICB2YXIgY29udGFpbnMgPSB0aGlzLmNvbnRhaW5zKG9iamVjdCk7XG4gICAgaWYgKCFjb250YWlucyl7XG4gICAgICAgIHRoaXMuYXJyYXkuaW5zZXJ0KHtpZDpvYmplY3QuaWQsIHNvY2tldDpzb2NrZXR9KTtcbiAgICB9O1xuICAgIHJldHVybiAhY29udGFpbnM7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgcmVtb3ZlIHRoZSBvYmplY3QgYW5kIGl0cyBhc3NvY2lhdGVkIHNvY2tldCBmcm9tIHRoZSBhcnJheVxuICogXFxwYXJhbSBvYmplY3QgdGhlIG9iamVjdCBjb250YWluaW5nIHRoZSBpZGVudGlmaWVyIHRvIHJlbW92ZVxuICogXFxyZXR1cm4gdGhlIHNvY2tldCB0YXJnZXRlZCBieSB0aGUgcmVtb3ZhbCwgbnVsbCBpZiBpdCBkb2VzIG5vdCBleGlzdFxuICovXG5Tb2NrZXRzLnByb3RvdHlwZS5yZW1vdmVTb2NrZXQgPSBmdW5jdGlvbihvYmplY3Qpe1xuICAgIHZhciBzb2NrZXQgPSB0aGlzLmdldFNvY2tldChvYmplY3QpO1xuICAgIGlmIChzb2NrZXQgIT09IG51bGwpe1xuICAgICAgICB0aGlzLmFycmF5LnJlbW92ZShvYmplY3QpO1xuICAgICAgICB0aGlzLmxhc3RDaGFuY2UgPSBzb2NrZXQ7XG4gICAgfTtcbiAgICByZXR1cm4gc29ja2V0O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGdldCB0aGUgc29ja2V0IGF0dGFjaGVkIHRvIHRoZSBvYmplY3QgaWRlbnRpdHlcbiAqIFxccGFyYW0gb2JqZWN0IHRoZSBvYmplY3QgY29udGFpbmluZyB0aGUgaWRlbnRpZmllciB0byBzZWFyY2hcbiAqIFxccmV0dXJuIHRoZSBzb2NrZXQgaWYgdGhlIG9iamVjdCBleGlzdHMsIG51bGwgb3RoZXJ3aXNlXG4gKi9cblNvY2tldHMucHJvdG90eXBlLmdldFNvY2tldCA9IGZ1bmN0aW9uKG9iamVjdCl7XG4gICAgdmFyIGluZGV4ID0gdGhpcy5hcnJheS5pbmRleE9mKG9iamVjdCksXG4gICAgICAgIHNvY2tldCA9IG51bGw7XG4gICAgaWYgKGluZGV4ICE9PSAtMSl7XG4gICAgICAgIHNvY2tldCA9IHRoaXMuYXJyYXkuYXJyW2luZGV4XS5zb2NrZXQ7XG4gICAgfTtcbiAgICByZXR1cm4gc29ja2V0O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNoZWNrIGlmIHRoZXJlIGlzIGEgc29ja2V0IGFzc29jaWF0ZWQgdG8gdGhlIG9iamVjdFxuICogXFxwYXJhbSBvYmplY3QgdGhlIG9iamVjdCBjb250YWluaW5nIHRoZSBpZGVudGlmaWVyIHRvIGNoZWNrXG4gKiBcXHJldHVybiB0cnVlIGlmIGEgc29ja2V0IGFzc29jaWF0ZWQgdG8gdGhlIG9iamVjdCBleGlzdHMsIGZhbHNlIG90aGVyd2lzZVxuICovXG5Tb2NrZXRzLnByb3RvdHlwZS5jb250YWlucyA9IGZ1bmN0aW9uKG9iamVjdCl7XG4gICAgcmV0dXJuICh0aGlzLmFycmF5LmluZGV4T2Yob2JqZWN0KSAhPT0gLTEpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGdldCB0aGUgbGVuZ3RoIG9mIHRoZSB1bmRlcmx5aW5nIGFycmF5XG4gKiBcXHJldHVybiB0aGUgbGVuZ3RoIG9mIHRoZSBhcnJheVxuICovXG5Tb2NrZXRzLnByb3RvdHlwZS5sZW5ndGggPSBmdW5jdGlvbigpe1xuICAgIHJldHVybiB0aGlzLmFycmF5LmFyci5sZW5ndGg7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgcmVtb3ZlIGFsbCB0aGUgc29ja2V0cyBmcm9tIHRoaXMgcmVnaXN0ZXIsIGFuZCBjbG9zZSB0aGVtXG4gKi9cblNvY2tldHMucHJvdG90eXBlLmNsZWFyID0gZnVuY3Rpb24oKXtcbiAgICBmb3IgKHZhciBpPTA7IGk8dGhpcy5hcnJheS5hcnIubGVuZ3RoOyArK2kpe1xuICAgICAgICB0aGlzLmFycmF5LmFycltpXS5zb2NrZXQuZGVzdHJveSgpOyAgICAgICAgXG4gICAgfTtcbiAgICB0aGlzLmFycmF5LmFyci5zcGxpY2UoMCwgdGhpcy5hcnJheS5hcnIubGVuZ3RoKTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gU29ja2V0cztcbiIsInZhciBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKS5FdmVudEVtaXR0ZXI7XG52YXIgU29ja2V0ID0gcmVxdWlyZSgnc2ltcGxlLXBlZXInKTtcbnZhciB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuXG52YXIgUGFydGlhbFZpZXcgPSByZXF1aXJlKCcuL3BhcnRpYWx2aWV3LmpzJyk7XG52YXIgSW5WaWV3ID0gcmVxdWlyZSgnLi9pbnZpZXcuanMnKTtcbnZhciBTb2NrZXRzID0gcmVxdWlyZSgnLi9zb2NrZXRzLmpzJyk7XG52YXIgR1VJRCA9IHJlcXVpcmUoJy4vZ3VpZC5qcycpO1xuXG52YXIgTWVzc2FnZXMgPSByZXF1aXJlKCcuL21lc3NhZ2VzLmpzJyk7XG52YXIgTUpvaW4gPSBNZXNzYWdlcy5NSm9pbjtcbnZhciBNUmVxdWVzdFRpY2tldCA9IE1lc3NhZ2VzLk1SZXF1ZXN0VGlja2V0O1xudmFyIE1PZmZlclRpY2tldCA9IE1lc3NhZ2VzLk1PZmZlclRpY2tldDtcbnZhciBNU3RhbXBlZFRpY2tldCA9IE1lc3NhZ2VzLk1TdGFtcGVkVGlja2V0O1xudmFyIE1FeGNoYW5nZSA9IE1lc3NhZ2VzLk1FeGNoYW5nZTtcblxudXRpbC5pbmhlcml0cyhTcHJheSwgRXZlbnRFbWl0dGVyKTtcblxuLyohXG4gKiBcXGJyaWVmIEltcGxlbWVudGF0aW9uIG9mIHRoZSByYW5kb20gcGVlciBzYW1wbGluZyBjYWxsZWQgU3ByYXkgb24gdG9wIG9mXG4gKiBzb2NrZXQuaW9cbiAqIFxccGFyYW0gaWQgdGhlIHVuaXF1ZSBpZGVudGlmaWVyIG9mIG91ciBwZWVyXG4gKiBcXHBhcmFtIG9wdGlvbnMgdGhlIFdlYlJUQyBvcHRpb25zLCBmb3IgbW9yZSBpbmZvcm1hdGlvbnM6IFxuICogXFx1cmwgaHR0cHM6Ly9naXRodWIuY29tL2Zlcm9zcy9zaW1wbGUtcGVlclxuICovXG5mdW5jdGlvbiBTcHJheShpZCwgb3B0aW9ucyl7XG4gICAgRXZlbnRFbWl0dGVyLmNhbGwodGhpcyk7XG4gICAgLy8gI0EgY29uc3RhbnRzXG4gICAgdGhpcy5ERUxUQVRJTUUgPSAob3B0aW9ucyAmJiBvcHRpb25zLmRlbHRhdGltZSkgfHwgMTAwMCAqIDYwICogMjsgLy8gMm1pblxuICAgIHRoaXMuVElNRU9VVCA9IChvcHRpb25zICYmIG9wdGlvbnMudGltZW91dCkgfHwgMTAwMCAqIDYwICogMTsgLy8gMW1pblxuICAgIHRoaXMuSUQgPSAoaWQgJiYgJycraWQrJycpIHx8IEdVSUQoKTtcbiAgICB0aGlzLk9QVElPTlMgPSBvcHRpb25zIHx8IHt9O1xuICAgIFxuICAgIC8vICNCIHByb3RvY29sIHZhcmlhYmxlc1xuICAgIHRoaXMucGFydGlhbFZpZXcgPSBuZXcgUGFydGlhbFZpZXcoKTtcbiAgICB0aGlzLmluVmlldyA9IG5ldyBJblZpZXcoKTtcbiAgICBcbiAgICB0aGlzLnNvY2tldHMgPSBuZXcgU29ja2V0cygpO1xuICAgIHRoaXMucGVuZGluZyA9IG5ldyBTb2NrZXRzKCk7XG4gICAgdGhpcy5mb3J3YXJkcyA9IG5ldyBTb2NrZXRzKCk7XG4gICAgdGhpcy5zdGF0ZSA9ICdkaXNjb25uZWN0JztcbiAgICBcbiAgICAvLyAjQyB3ZWJydGMgc3BlY2lmaWNzXG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHNldEludGVydmFsKGZ1bmN0aW9uKCl7XG4gICAgICAgIGlmIChzZWxmLnBhcnRpYWxWaWV3Lmxlbmd0aCgpPjApe1xuICAgICAgICAgICAgc2VsZi5leGNoYW5nZSgpO1xuICAgICAgICB9O1xuICAgIH0sIHRoaXMuREVMVEFUSU1FKTtcblxuICAgIC8vICNEIGV2ZW50c1xuICAgIHRoaXMub24oJ3NwcmF5LXJlY2VpdmUnLCBmdW5jdGlvbihzb2NrZXQsIG1lc3NhZ2Upe1xuICAgICAgICBzZWxmLm9uU3ByYXlSZWNlaXZlKHNvY2tldCwgbWVzc2FnZSk7XG4gICAgfSk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgY2hlY2sgaWYgdGhlIG5ldHdvcmsgaXMgcmVhZHkgYW5kIGNhbGxiYWNrLCBub3RoaW5nIG90aGVyd2lzZVxuICogXFxwYXJhbSBjYWxsYmFjayB0aGUgZnVuY3Rpb24gdG8gY2FsbCBpZiB0aGUgbmV0d29yayBpcyByZWFkeVxuICovXG5TcHJheS5wcm90b3R5cGUucmVhZHkgPSBmdW5jdGlvbihjYWxsYmFjayl7XG4gICAgaWYgKHRoaXMucGFydGlhbFZpZXcubGVuZ3RoKCkgPiAwKXsgY2FsbGJhY2soKTsgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiBnZXQgYSBzZXQgb2YgbmVpZ2hib3JzLiAoVE9ETykgaW5jbHVkZSB0aGUgc29ja2V0cyBmcm9tIHRoZSBpblZpZXdcbiAqIFxccGFyYW0gayB0aGUgbnVtYmVyIG9mIG5laWdoYm9ycyByZXF1ZXN0ZWRcbiAqIFxccmV0dXJuIGEgbGlzdCBvZiBzb2NrZXRzXG4gKi9cblNwcmF5LnByb3RvdHlwZS5nZXRQZWVycyA9IGZ1bmN0aW9uKGspe1xuICAgIHZhciByZXN1bHQgPSBbXTtcbiAgICAvLyAjQSBjb3B5IHRoZSBzb2NrZXRzIG9mIHRoZSBwYXJ0aWFsIHZpZXdcbiAgICB2YXIgY2xvbmVTb2NrZXRzID0gW107XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLnNvY2tldHMubGVuZ3RoKCk7ICsraSl7XG4gICAgICAgIGNsb25lU29ja2V0c1tpXSA9IHRoaXMuc29ja2V0cy5hcnJheS5hcnJbaV07XG4gICAgfTtcbiAgICAvLyAjQiBnZXQgYXMgbXVjaCBuZWlnaGJvcnMgYXMgcG9zc2libGVcbiAgICB3aGlsZSAoMCA8IGNsb25lU29ja2V0cy5sZW5ndGggJiYgcmVzdWx0Lmxlbmd0aCA8IGspe1xuICAgICAgICB2YXIgcm4gPSBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkqY2xvbmVTb2NrZXRzLmxlbmd0aCk7XG4gICAgICAgIHJlc3VsdC5wdXNoKGNsb25lU29ja2V0c1tybl0uc29ja2V0KTtcbiAgICAgICAgY2xvbmVTb2NrZXRzLnNwbGljZShybiwgMSk7XG4gICAgfTtcbiAgICAvLyAjQyBsYXN0IGNoYW5jZSBzb2NrZXRcbiAgICBpZiAoaz4wICYmIHJlc3VsdC5sZW5ndGg9PT0wICYmIHRoaXMuc29ja2V0cy5sYXN0Q2hhbmNlIT09bnVsbCl7XG4gICAgICAgIHJlc3VsdC5wdXNoKHRoaXMuc29ja2V0cy5sYXN0Q2hhbmNlKTtcbiAgICB9O1xuICAgIHJldHVybiByZXN1bHQ7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgdXBkYXRlIHRoZSBsb2NhbCBjb25uZWN0aW9uIHN0YXRlIG9mIHRoZSBwZWVyIGFuZCBlbWl0IGFuIGV2ZW50XG4gKiBpZiB0aGUgc3RhdGUgaXMgZGlmZmVyZW50IHRoYW4gYXQgdGhlIHByZXZpb3VzIGNhbGwgb2YgdGhpcyBmdW5jdGlvbi5cbiAqIFRoZSBlbWl0dGVkIGV2ZW50IGlzICdzdGF0ZWNoYW5nZScgd2l0aCB0aGUgXG4gKiBhcmd1bWVudHMgJ2Nvbm5lY3QnIHwgJ3BhcnRpYWwnIHwgJ2Rpc2Nvbm5lY3QnXG4gKi9cblNwcmF5LnByb3RvdHlwZS51cGRhdGVTdGF0ZSA9IGZ1bmN0aW9uKCl7XG4gICAgaWYgKHRoaXMucGFydGlhbFZpZXcubGVuZ3RoKCkgPiAwICYmIHRoaXMuc3RhdGUgIT09ICdjb25uZWN0Jyl7XG4gICAgICAgIHRoaXMuc3RhdGUgPSAnY29ubmVjdCc7XG4gICAgICAgIHRoaXMuZW1pdCgnc3RhdGVjaGFuZ2UnLCAnY29ubmVjdCcpO1xuICAgIH0gZWxzZSBpZiAoKHRoaXMucGFydGlhbFZpZXcubGVuZ3RoKCkgPT09IDAgJiYgdGhpcy5pblZpZXcubGVuZ3RoKCkgPiAwIHx8XG4gICAgICAgICAgICAgICAgdGhpcy5wYXJ0aWFsVmlldy5sZW5ndGgoKSA+IDAgJiYgdGhpcy5pblZpZXcubGVuZ3RoKCkgPT09IDAgKSAmJlxuICAgICAgICAgICAgICAgdGhpcy5zdGF0ZSAhPT0gJ3BhcnRpYWwnKXtcbiAgICAgICAgdGhpcy5zdGF0ZSA9ICdwYXJ0aWFsJztcbiAgICAgICAgdGhpcy5lbWl0KCdzdGF0ZWNoYW5nZScsICdwYXJ0aWFsJyk7XG4gICAgfSBlbHNlIGlmICh0aGlzLnBhcnRpYWxWaWV3Lmxlbmd0aCgpID09PSAwICYmIHRoaXMucGVuZGluZy5sZW5ndGgoKSA9PT0gMCAmJlxuICAgICAgICAgICAgICAgdGhpcy5zdGF0ZSAhPT0gJ2Rpc2Nvbm5lY3QnKXtcbiAgICAgICAgdGhpcy5zdGF0ZSA9ICdkaXNjb25uZWN0JztcbiAgICAgICAgdGhpcy5lbWl0KCdzdGF0ZWNoYW5nZScsICdkaXNjb25uZWN0Jyk7XG4gICAgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiBsZWF2ZSB0aGUgbmV0d29yayBieSBjbG9zaW5nIHRoZSBpbnZpZXcgYW5kIHBhcnRpYWx2aWV3XG4gKi9cblNwcmF5LnByb3RvdHlwZS5sZWF2ZSA9IGZ1bmN0aW9uKCl7XG4gICAgdGhpcy5wYXJ0aWFsVmlldy5jbGVhcigpO1xuICAgIHRoaXMuaW5WaWV3LmNsZWFyKCk7XG4gICAgXG4gICAgdGhpcy5zb2NrZXRzLmNsZWFyKCk7XG4gICAgdGhpcy5wZW5kaW5nLmNsZWFyKCk7XG4gICAgdGhpcy5mb3J3YXJkcy5jbGVhcigpO1xufTtcblxuLyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcbiAqIEJvb3RzdHJhcCB0aGUgZmlyc3QgV2ViUlRDIGNvbm5lY3Rpb25cbiAqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiovXG5cbi8qIVxuICogXFxicmllZiB0aGUgdmVyeSBmaXJzdCBwYXJ0IG9mIGEgY29ubmVjdGlvbiBlc3RhYmxpc2htZW50IHRvIGpvaW4gdGhlIG5ldHdvcmsuXG4gKiBUaGlzIHBhcnQgY29ycmVzcG9uZHMgdG8gdGhlIGZpcnN0IHBhcnQgb2YgdGhlICdvblN0YW1wZWRUaWNrZXRSZXF1ZXN0JyBvZlxuICogdGhlIHNwcmF5IHByb3RvY29sLlxuICogXFxwYXJhbSBjYWxsYmFjayBhIGNhbGxiYWNrIGZ1bmN0aW9uIHRha2luZyBhICdtZXNzYWdlJyBpbiBhcmd1bWVudCBhbmRcbiAqIGNhbGxlZCB3aGVuIHdlIHJlY2VpdmUgdGhlIGRhdGEgZnJvbSB0aGUgc3R1biBzZXJ2ZXJcbiAqL1xuU3ByYXkucHJvdG90eXBlLmxhdW5jaCA9IGZ1bmN0aW9uKGNhbGxiYWNrKXtcbiAgICB2YXIgb3B0aW9ucz10aGlzLk9QVElPTlM7IG9wdGlvbnMuaW5pdGlhdG9yPXRydWU7IG9wdGlvbnMudHJpY2tsZT1mYWxzZTtcbiAgICB2YXIgc29ja2V0ID0gbmV3IFNvY2tldChvcHRpb25zKSxcbiAgICAgICAgaWQgPSBHVUlEKCksXG4gICAgICAgIHNlbGYgPSB0aGlzO1xuICAgIHNvY2tldC5vbignc2lnbmFsJywgZnVuY3Rpb24oZGF0YSl7XG4gICAgICAgIHZhciBtZXNzYWdlID0gbmV3IE1PZmZlclRpY2tldChpZCwgZGF0YSwge2lkOiBzZWxmLklEfSk7XG4gICAgICAgIHNlbGYucGVuZGluZy5hZGRTb2NrZXQoc29ja2V0LCBtZXNzYWdlKTtcbiAgICAgICAgY2FsbGJhY2sobWVzc2FnZSk7XG4gICAgfSk7XG4gICAgc2V0VGltZW91dChmdW5jdGlvbigpe1xuICAgICAgICBpZiAoc2VsZi5wZW5kaW5nLmNvbnRhaW5zKHtpZDppZH0pKXtcbiAgICAgICAgICAgIHNlbGYucGVuZGluZy5yZW1vdmVTb2NrZXQoe2lkOmlkfSk7XG4gICAgICAgICAgICBzb2NrZXQuZGVzdHJveSgpO1xuICAgICAgICB9O1xuICAgIH0sIHRoaXMuVElNRU9VVCk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgdGhlIHNlY29uZCBwYXJ0IG9mIHRoZSBjb25uZWN0aW9uIGVzdGFibGlzaG1lbnQuIFRoaXMgZnVuY3Rpb24gaXNcbiAqIGNhbGxlZCBhdCB0aGUgcGVlciBhbHJlYWR5IGluc2lkZSB0aGUgbmV0d29yay4gSXQgY29ycmVzcG9uZHMgdG8gdGhlIGZ1bmN0aW9uXG4gKiAnb25UaWNrZXRSZXF1ZXN0JyBvZiB0aGUgU3ByYXkgcHJvdG9jb2xcbiAqIFxccGFyYW0gbWVzc2FnZSB0aGUgbWVzc2FnZSBnZW5lcmF0ZWQgYnkgdGhlIGxhdW5jaCBmdW5jdGlvbiBhdCB0aGUgam9pbmluZ1xuICogcGVlclxuICogXFxwYXJhbSBjYWxsYmFjayB0aGUgZnVuY3Rpb24gY2FsbGVkIHdoZW4gd2UgcmVjZWl2ZSB0aGUgc3RhbXBlZCB0aWNrZXQgZnJvbVxuICogdGhlIHN0dW4gc2VydmVyLiBJdCBoYXMgYSAnbWVzc2FnZScgYXJndW1lbnQuXG4gKi9cblNwcmF5LnByb3RvdHlwZS5hbnN3ZXIgPSBmdW5jdGlvbihtZXNzYWdlLCBjYWxsYmFjayl7XG4gICAgdmFyIG9wdGlvbnM9dGhpcy5PUFRJT05TOyBvcHRpb25zLmluaXRpYXRvcj1mYWxzZTsgb3B0aW9ucy50cmlja2xlPWZhbHNlO1xuICAgIHZhciBzb2NrZXQgPSBuZXcgU29ja2V0KG9wdGlvbnMpLFxuICAgICAgICBpZCA9IG1lc3NhZ2UuaWQsXG4gICAgICAgIHRpY2tldCA9IG1lc3NhZ2UudGlja2V0LFxuICAgICAgICBwZWVyID0gbWVzc2FnZS5wZWVyLFxuICAgICAgICBzZWxmID0gdGhpcztcbiAgICBzb2NrZXQub24oJ3NpZ25hbCcsIGZ1bmN0aW9uKGRhdGEpe1xuICAgICAgICB2YXIgc3RhbXBlZFRpY2tldCA9IG5ldyBNU3RhbXBlZFRpY2tldChpZCwgZGF0YSwge2lkOnNlbGYuSUR9KTtcbiAgICAgICAgc2VsZi5wZW5kaW5nLmFkZFNvY2tldChzb2NrZXQsIHN0YW1wZWRUaWNrZXQpO1xuICAgICAgICBjYWxsYmFjayhzdGFtcGVkVGlja2V0KTtcbiAgICB9KTtcbiAgICBzb2NrZXQub24oJ2Nvbm5lY3QnLCBmdW5jdGlvbigpe1xuICAgICAgICBjb25zb2xlLmxvZygnd3J0Yzogc3VjY2Vzc2Z1bCBjb25uZWN0aW9uIGVzdGFibGlzaG1lbnQnKTtcbiAgICAgICAgc2VsZi5wZW5kaW5nLnJlbW92ZVNvY2tldChtZXNzYWdlKTtcbiAgICAgICAgc2VsZi5pblZpZXcuYWRkKHNvY2tldCwgaWQpO1xuICAgICAgICBzZWxmLnVwZGF0ZVN0YXRlKCk7XG4gICAgfSk7XG4gICAgc29ja2V0Lm9uKCdkYXRhJywgZnVuY3Rpb24ocmVjZWl2ZWRNZXNzYWdlKXtcbiAgICAgICAgc2VsZi5yZWNlaXZlKHNvY2tldCwgcmVjZWl2ZWRNZXNzYWdlKTtcbiAgICB9KTtcbiAgICBzb2NrZXQub24oJ3N0cmVhbScsIGZ1bmN0aW9uKHN0cmVhbSl7XG4gICAgICAgIHNlbGYuZW1pdCgnc3RyZWFtJywgc29ja2V0LCBzdHJlYW0pO1xuICAgIH0pO1xuICAgIHNvY2tldC5vbignY2xvc2UnLCBmdW5jdGlvbigpe1xuICAgICAgICBjb25zb2xlLmxvZygnd3J0YzogYSBjb25uZWN0aW9uIGhhcyBiZWVuIGNsb3NlZCcpO1xuICAgICAgICBzZWxmLmluVmlldy5yZW1vdmUoaWQpO1xuICAgICAgICBzZWxmLnVwZGF0ZVN0YXRlKCk7XG4gICAgfSk7XG4gICAgc29ja2V0LnNpZ25hbCh0aWNrZXQpO1xuICAgIHNldFRpbWVvdXQoZnVuY3Rpb24oKXtcbiAgICAgICAgaWYgKHNlbGYucGVuZGluZy5jb250YWlucyh7aWQ6aWR9KSl7XG4gICAgICAgICAgICB2YXIgc29ja2V0ID0gc2VsZi5wZW5kaW5nLnJlbW92ZVNvY2tldCh7aWQ6aWR9KTtcbiAgICAgICAgICAgIHNvY2tldC5kZXN0cm95KCk7XG4gICAgICAgIH07XG4gICAgfSwgdGhpcy5USU1FT1VUKTtcbn07XG5cbi8qIVxuICogXFxicmllZiB0aGUgdGhpcmQgcGFydCBvZiB0aGUgdmVyeSBmaXJzdCBjb25uZWN0aW9uIGVzdGFibGlzaG1lbnQgdG8gam9pbiB0aGVcbiAqIG5ldHdvcmsuIEl0IGNvcnJlc3BvbmRzIHRvIHRoZSBsYXN0IHBhcnQgb2YgdGhlIGZ1bmN0aW9uIG9mXG4gKiAnb25TdGFtcGVkVGlja2V0UmVxdWVzdCcgb2YgdGhlIFNwcmF5IHByb3RvY29sLlxuICogXFxwYXJhbSBtZXNzYWdlIHRoZSBtZXNzYWdlIGNvbnRhaW5pbmcgdGhlIHN0YW1wZWQgdGlja2V0IGZyb20gdGhlIGNvbnRhY3RcbiAqIHBlZXJcbiAqL1xuU3ByYXkucHJvdG90eXBlLmhhbmRzaGFrZSA9IGZ1bmN0aW9uKG1lc3NhZ2Upe1xuICAgIHZhciBzb2NrZXQgPSB0aGlzLnBlbmRpbmcucmVtb3ZlU29ja2V0KG1lc3NhZ2UpLFxuICAgICAgICBpZCA9IG1lc3NhZ2UuaWQsXG4gICAgICAgIHRpY2tldCA9IG1lc3NhZ2UudGlja2V0LFxuICAgICAgICBwZWVyID0gbWVzc2FnZS5wZWVyLFxuICAgICAgICBzZWxmID0gdGhpcztcbiAgICBzb2NrZXQub24oJ2Nvbm5lY3QnLCBmdW5jdGlvbigpe1xuICAgICAgICBjb25zb2xlLmxvZygnd3J0Yzogc3VjY2Vzc2Z1bCBjb25uZWN0aW9uIGVzdGFibGlzaG1lbnQnKTtcbiAgICAgICAgc2VsZi5wYXJ0aWFsVmlldy5hZGROZWlnaGJvcihwZWVyKTtcbiAgICAgICAgc2VsZi5zb2NrZXRzLmFkZFNvY2tldChzb2NrZXQsIHBlZXIpO1xuICAgICAgICBzZWxmLmpvaW4ocGVlcik7XG4gICAgICAgIHNlbGYudXBkYXRlU3RhdGUoKTtcbiAgICB9KTtcbiAgICBzb2NrZXQub24oJ2RhdGEnLCBmdW5jdGlvbihyZWNlaXZlZE1lc3NhZ2Upe1xuICAgICAgICBzZWxmLnJlY2VpdmUoc29ja2V0LCByZWNlaXZlZE1lc3NhZ2UpO1xuICAgIH0pO1xuICAgIHNvY2tldC5vbignc3RyZWFtJywgZnVuY3Rpb24oc3RyZWFtKXtcbiAgICAgICAgc2VsZi5lbWl0KCdzdHJlYW0nLCBzb2NrZXQsIHN0cmVhbSk7XG4gICAgfSk7XG4gICAgc29ja2V0Lm9uKCdjbG9zZScsIGZ1bmN0aW9uKCl7XG4gICAgICAgIGNvbnNvbGUubG9nKCd3cnRjOiBhIGNvbm5lY3Rpb24gaGFzIGJlZW4gY2xvc2VkJyk7XG4gICAgICAgIHNlbGYudXBkYXRlU3RhdGUoKTtcbiAgICB9KTtcbiAgICBzb2NrZXQuc2lnbmFsKHRpY2tldCk7XG59O1xuXG5cbi8qKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqXG4gKiBTcHJheSdzIHByb3RvY29sIGltcGxlbWVudGF0aW9uXG4gKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqL1xuXG4vKiFcbiAqIFxcYnJpZWYgam9pbiB0aGUgbmV0d29yayB1c2luZyB0aGUga3dub24gY29udGFjdCBwZWVyIFxuICogXFxwYXJhbSBjb250YWN0IHRoZSBrbm93biBwZWVyIHRoYXQgd2lsbCBpbnRyb2R1Y2UgdXMgdG8gdGhlIG5ldHdvcmtcbiAqL1xuU3ByYXkucHJvdG90eXBlLmpvaW4gPSBmdW5jdGlvbihjb250YWN0KXtcbiAgICAvLyAjQSBhc2sgdG8gdGhlIGNvbnRhY3QgcGVlciB0byBhZHZlcnRpc2UgeW91ciBwcmVzZW5jZSBpbiB0aGUgbmV0d29ya1xuICAgIHZhciBtZXNzYWdlID0gbmV3IE1Kb2luKEdVSUQoKSk7XG4gICAgdGhpcy5zZW5kKG1lc3NhZ2UsIGNvbnRhY3QpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGV2ZW50IGV4ZWN1dGVyIHdoZW4gXCJ0aGlzXCIgcmVjZWl2ZXMgYSBqb2luIG1lc3NhZ2VcbiAqIFxccGFyYW0gaWQgdGhlIGlkZW50aWZpZXIgb2YgdGhlIHJlcXVlc3RcbiAqL1xuU3ByYXkucHJvdG90eXBlLm9uSm9pbiA9IGZ1bmN0aW9uKGlkKXtcbiAgICAvLyAjQSBpZiBpdCBpcyB0aGUgdmVyeSBmaXJzdCBjb25uZWN0aW9uLCBlc3RhYmxpc2ggYSBjb25uZWN0aW9uIGZyb21cbiAgICAvLyB1cyB0byB0aGUgbmV3Y29tZXJcbiAgICBpZiAodGhpcy5wYXJ0aWFsVmlldy5sZW5ndGgoKT09PTApe1xuICAgICAgICB2YXIgbVJlcXVlc3RUaWNrZXQgPSBuZXcgTVJlcXVlc3RUaWNrZXQoR1VJRCgpKTtcbiAgICAgICAgdGhpcy5zZW5kKG1SZXF1ZXN0VGlja2V0LCB7aWQ6aWR9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgICAvLyAjQiBpZiB0aGVyZSBpcyBhbiBhbHJlYWR5IGVzdGFibGlzaGVkIG5ldHdvcmssIHdlIHJlcXVlc3QgdGhhdFxuICAgICAgICAvLyB0aGUgbmV3Y29tZXIgc2VuZHMgdXMgYW4gb2ZmZXIgdGlja2V0IGZvciBlYWNoIG9mIG91ciBuZWlnaGJvcnNcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLnBhcnRpYWxWaWV3Lmxlbmd0aCgpOyArK2kpe1xuICAgICAgICAgICAgLy8gIzEgY3JlYXRlIHRoZSB0aWNrZXQgd2l0aCBhbiBvcmlnaW5hbCBpZGVudGlmaWVyXG4gICAgICAgICAgICB2YXIgbVJlcXVlc3RUaWNrZXQgPSBuZXcgTVJlcXVlc3RUaWNrZXQoR1VJRCgpKTtcbiAgICAgICAgICAgIC8vICMyIHJlZ2lzdGVyIHRoZSBmb3J3YXJkaW5nIHJvdXRlIGZvciB0aGUgYW5zd2Vyc1xuICAgICAgICAgICAgdGhpcy5mb3J3YXJkcy5hZGRTb2NrZXQoXG4gICAgICAgICAgICAgICAgdGhpcy5zb2NrZXRzLmdldFNvY2tldCh0aGlzLnBhcnRpYWxWaWV3LmFycmF5LmFycltpXSksXG4gICAgICAgICAgICAgICAgbVJlcXVlc3RUaWNrZXQpO1xuICAgICAgICAgICAgLy8gIzMgc2VuZCB0aGUgcmVxdWVzdCB0byB0aGUgbmV3IGNvbWVyXG4gICAgICAgICAgICB0aGlzLnNlbmQobVJlcXVlc3RUaWNrZXQsIHtpZDppZH0pO1xuICAgICAgICB9O1xuICAgIH07XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgcGVyaW9kaWNhbGx5IGNhbGxlZCBmdW5jdGlvbiB0aGF0IGFpbXMgdG8gYmFsYW5jZSB0aGUgcGFydGlhbCB2aWV3XG4gKiBhbmQgdG8gbWl4IHRoZSBuZWlnaGJvcnMgaW5zaWRlIHRoZW1cbiAqL1xuU3ByYXkucHJvdG90eXBlLmV4Y2hhbmdlID0gZnVuY3Rpb24oKXtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgdmFyIHNvY2tldE9sZGVzdCA9IG51bGw7XG4gICAgLy8gIzEgZ2V0IHRoZSBvbGRlc3QgbmVpZ2hib3IgcmVhY2hhYmxlXG4gICAgd2hpbGUgKChzb2NrZXRPbGRlc3Q9PT1udWxsKSB8fFxuICAgICAgICAgICAoc29ja2V0T2xkZXN0IT09bnVsbCAmJiAhc29ja2V0T2xkZXN0LmNvbm5lY3RlZCkgJiZcbiAgICAgICAgICAgdGhpcy5wYXJ0aWFsVmlldy5sZW5ndGgoKT4wKXtcbiAgICAgICAgdmFyIG9sZGVzdCA9IHRoaXMucGFydGlhbFZpZXcuZ2V0T2xkZXN0KCk7XG4gICAgICAgIHNvY2tldE9sZGVzdCA9IHRoaXMuc29ja2V0cy5nZXRTb2NrZXQob2xkZXN0KTtcbiAgICAgICAgaWYgKHNvY2tldE9sZGVzdD09PW51bGwgfHxcbiAgICAgICAgICAgIChzb2NrZXRPbGRlc3QhPT1udWxsICYmICFzb2NrZXRPbGRlc3QuY29ubmVjdGVkKSkge1xuICAgICAgICAgICAgdGhpcy5vblBlZXJEb3duKG9sZGVzdCk7XG4gICAgICAgIH07XG4gICAgfTtcbiAgICBpZiAodGhpcy5wYXJ0aWFsVmlldy5sZW5ndGgoKT09PTApe3JldHVybjt9OyAvLyB1Z2x5IHJldHVyblxuICAgIC8vICMyIG5vdGlmeSB0aGUgb2xkZXN0IG5laWdoYm9yIHRoYXQgaXQgaXMgdGhlIGNob3NlbiBvbmVcbiAgICB2YXIgbUV4Y2hhbmdlID0gbmV3IE1FeGNoYW5nZShHVUlEKCksIHtpZDp0aGlzLklEfSk7XG4gICAgdGhpcy5zZW5kKG1FeGNoYW5nZSwgb2xkZXN0KTtcbiAgICAvLyAjMyBnZXQgYSBzYW1wbGUgZnJvbSBvdXIgcGFydGlhbCB2aWV3XG4gICAgdmFyIHNhbXBsZSA9IHRoaXMucGFydGlhbFZpZXcuZ2V0U2FtcGxlKG9sZGVzdCwgdHJ1ZSk7XG4gICAgLy8gIzQgYXNrIHRvIHRoZSBuZWlnaGJvcnMgaW4gdGhlIHNhbXBsZSB0byBjcmVhdGUgdGhlIG9mZmVyIHRpY2tldHMgaW5cbiAgICAvLyBvcmRlciB0byBmb3J3YXJkIHRoZW0gdG8gdGhlIG9sZGVzdCBuZWlnaGJvclxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc2FtcGxlLmxlbmd0aDsgKytpKXtcbiAgICAgICAgaWYgKHNhbXBsZVtpXS5pZCAhPT0gb2xkZXN0LmlkKXtcbiAgICAgICAgICAgIC8vICM1IGlmIHRoZSBuZWlnaGJvciBpcyBub3QgdGhlIG9sZGVzdCBuZWlnaGJvclxuICAgICAgICAgICAgLy8gIzVBIHJlZ2lzdGVyIHRoZSBmb3J3YXJkaW5nIGRlc3RpbmF0aW9uXG4gICAgICAgICAgICB2YXIgbWVzc2FnZSA9IG5ldyBNUmVxdWVzdFRpY2tldChHVUlEKCkpO1xuICAgICAgICAgICAgdGhpcy5mb3J3YXJkcy5hZGRTb2NrZXQodGhpcy5zb2NrZXRzLmdldFNvY2tldChvbGRlc3QpLG1lc3NhZ2UpO1xuICAgICAgICAgICAgLy8gIzVCIHNlbmQgYSB0aWNrZXQgcmVxdWVzdCB0byB0aGUgbmVpZ2hib3IgaW4gdGhlIHNhbXBsZVxuICAgICAgICAgICAgdGhpcy5zZW5kKG1lc3NhZ2UsIHNhbXBsZVtpXSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyAjNiBvdGhlcndpc2UsIGNyZWF0ZSBhbiBvZmZlciB0aWNrZXQgb3Vyc2VsZiBhbmQgc2VuZCBpdCB0byB0aGVcbiAgICAgICAgICAgIC8vIG9sZGVzdCBuZWlnYmhvclxuICAgICAgICAgICAgdmFyIGlkVGlja2V0ID0gR1VJRCgpO1xuICAgICAgICAgICAgdGhpcy5mb3J3YXJkcy5hZGRTb2NrZXQodGhpcy5zb2NrZXRzLmdldFNvY2tldChvbGRlc3QpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge2lkOmlkVGlja2V0fSk7XG4gICAgICAgICAgICB0aGlzLm9uVGlja2V0UmVxdWVzdChpZFRpY2tldCk7XG4gICAgICAgIH07XG4gICAgfTtcbiAgICAvLyAjNyByZW1vdmUgdGhlIHNlbnQgc2FtcGxlIGZyb20gb3VyIHBhcnRpYWwgdmlld1xuICAgIHRoaXMucGFydGlhbFZpZXcucmVtb3ZlU2FtcGxlKHNhbXBsZSk7XG4gICAgLy8gIzggcmVtb3ZlIGZyb20gdGhlIHNvY2tldHMgZGljdGlvbm5hcnlcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHNhbXBsZS5sZW5ndGg7ICsraSl7XG4gICAgICAgIC8vICM4QSBjaGVjayBpZiB0aGUgcGFydGlhbCB2aWV3IHN0aWxsIGNvbnRhaW5zIHJlZmVyZW5jZXMgdG8gdGhlIHNvY2tldFxuICAgICAgICBpZiAoIXRoaXMucGFydGlhbFZpZXcuY29udGFpbnMoc2FtcGxlW2ldKSl7XG4gICAgICAgICAgICAvLyAjOEIgb3RoZXJ3aXNlIHJlbW92ZSB0aGUgc29ja2V0IGZyb20gdGhlIGRpY3Rpb25uYXJ5XG4gICAgICAgICAgICB2YXIgc29ja2V0ID0gdGhpcy5zb2NrZXRzLnJlbW92ZVNvY2tldChzYW1wbGVbaV0pO1xuICAgICAgICAgICAgLy8gIzhDIGNsb3NlIHRoZSBzb2NrZXQgYWZ0ZXIgYSB3aGlsZVxuICAgICAgICAgICAgaWYgKHNvY2tldCE9PW51bGwpe1xuICAgICAgICAgICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24ocyl7XG4gICAgICAgICAgICAgICAgICAgIHMuZGVzdHJveSgpO1xuICAgICAgICAgICAgICAgIH0sIHRoaXMuVElNRU9VVCwgc29ja2V0KTtcbiAgICAgICAgICAgIH07XG4gICAgICAgIH07XG4gICAgfTsgICAgXG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZXZlbnQgZXhlY3V0ZWQgd2hlbiB3ZSByZWNlaXZlIGFuIGV4Y2hhbmdlIHJlcXVlc3RcbiAqIFxccGFyYW0gaWQgdGhlIGlkZW50aWZpZXIgb2YgdGhlIHJlcXVlc3QgbWVzc2FnZVxuICogXFxwYXJhbSBpbml0aWF0b3IgdGhlIHBlZXIgdGhhdCByZXF1ZXN0ZWQgdGhlIGV4Y2hhbmdlXG4gKi9cblNwcmF5LnByb3RvdHlwZS5vbkV4Y2hhbmdlID0gZnVuY3Rpb24oaWQsIGluaXRpYXRvcil7XG4gICAgLy8gIzEgZ2V0IGEgc2FtcGxlIG9mIG5laWdoYm9ycyBmcm9tIG91ciBwYXJ0aWFsIHZpZXdcbiAgICB2YXIgc2FtcGxlID0gdGhpcy5wYXJ0aWFsVmlldy5nZXRTYW1wbGUoaW5pdGlhdG9yLCBmYWxzZSk7XG4gICAgLy8gIzIgYXNrIHRvIGVhY2ggbmVpZ2hib3IgaW4gdGhlIHNhbXBsZSB0byBjcmVhdGUgYW4gb2ZmZXIgdGlja2V0IHRvXG4gICAgLy8gZ2l2ZSB0byB0aGUgaW5pdGlhdG9yIHBlZXJcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHNhbXBsZS5sZW5ndGg7ICsraSl7XG4gICAgICAgIGlmIChzYW1wbGVbaV0uaWQgIT09IGluaXRpYXRvci5pZCl7XG4gICAgICAgICAgICAvLyAjMkEgaWYgdGhlIG5laWdiaG9yIGlzIG5vdCB0aGUgaW5pdGlhdG9yLCByZXF1ZXN0IGFuIG9mZmVyIHRpY2tldFxuICAgICAgICAgICAgLy8gZnJvbSBpdFxuICAgICAgICAgICAgdmFyIG1lc3NhZ2UgPSBuZXcgTVJlcXVlc3RUaWNrZXQoR1VJRCgpKTtcbiAgICAgICAgICAgIC8vICMyQiByZWdpc3RlciB0aGUgZm9yd2FyZGluZyByb3V0ZVxuICAgICAgICAgICAgdGhpcy5mb3J3YXJkcy5hZGRTb2NrZXQodGhpcy5mb3J3YXJkcy5nZXRTb2NrZXQoe2lkOmlkfSksIG1lc3NhZ2UpO1xuICAgICAgICAgICAgLy8gIzJDIHNlbmQgdGhlIHRpY2tldCByZXF1ZXN0IHRvIHRoZSBuZWlnYmhvclxuICAgICAgICAgICAgdGhpcy5zZW5kKG1lc3NhZ2UsIHNhbXBsZVtpXSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyAjM0EgaWYgdGhlIG5laWdiaG9yIGlzIHRoZSBpbml0aWF0b3IsIGNyZWF0ZSBhbiBvZmZlciB0aWNrZXRcbiAgICAgICAgICAgIC8vIG91cnNlbGYgICAgICAgICAgICBcbiAgICAgICAgICAgIHZhciBpZFRpY2tldCA9IEdVSUQoKTtcbiAgICAgICAgICAgIC8vICMzQiByZWdpc3RlciB0aGUgZm9yd2FyZGluZyByb3V0ZSBmb3Igb3VyIG93biBvZmZlciB0aWNrZXRcbiAgICAgICAgICAgIHRoaXMuZm9yd2FyZHMuYWRkU29ja2V0KHRoaXMuZm9yd2FyZHMuZ2V0U29ja2V0KHtpZDppZH0pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge2lkOmlkVGlja2V0fSk7XG4gICAgICAgICAgICAvLyAjM0MgY3JlYXRlIHRoZSBvZmZlciB0aWNrZXQgYW5kIHNlbmQgaXRcbiAgICAgICAgICAgIHRoaXMub25UaWNrZXRSZXF1ZXN0KGlkVGlja2V0KTtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIC8vICM0IHJlbW92ZSB0aGUgc2FtcGxlIGZyb20gb3VyIHBhcnRpYWwgdmlld1xuICAgIHRoaXMucGFydGlhbFZpZXcucmVtb3ZlU2FtcGxlKHNhbXBsZSk7XG4gICAgLy8gIzUgcmVtb3ZlIHRoZSBzYW1wbGUgZnJvbSB0aGUgc29ja2V0cyBkaWN0aW9ubmFyeVxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc2FtcGxlLmxlbmd0aDsgKytpKXtcbiAgICAgICAgLy8gIzVBIGNoZWNrIGlmIHRoZSBwYXJ0aWFsIHZpZXcgc3RpbGwgY29udGFpbnMgcmVmZXJlbmNlcyB0byB0aGUgc29ja2V0XG4gICAgICAgIGlmICghdGhpcy5wYXJ0aWFsVmlldy5jb250YWlucyhzYW1wbGVbaV0pKXtcbiAgICAgICAgICAgIC8vICM1QiBvdGhlcndpc2UgcmVtb3ZlIHRoZSBzb2NrZXQgZnJvbSB0aGUgZGljdGlvbm5hcnlcbiAgICAgICAgICAgIHZhciBzb2NrZXQgPSB0aGlzLnNvY2tldHMucmVtb3ZlU29ja2V0KHNhbXBsZVtpXSlcbiAgICAgICAgICAgIC8vICM1QyBjbG9zZSB0aGUgc29ja2V0IGFmdGVyIGEgd2hpbGVcbiAgICAgICAgICAgIGlmIChzb2NrZXQhPT1udWxsKXtcbiAgICAgICAgICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKHMpe1xuICAgICAgICAgICAgICAgICAgICBzLmRlc3Ryb3koKTtcbiAgICAgICAgICAgICAgICB9LCB0aGlzLlRJTUVPVVQsIHNvY2tldCk7XG4gICAgICAgICAgICB9O1xuICAgICAgICB9O1xuICAgIH07XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgdGhlIGZ1bmN0aW9uIGNhbGxlZCB3aGVuIGEgbmVpZ2hib3IgaXMgdW5yZWFjaGFibGUgYW5kIHN1cHBvc2VkbHlcbiAqIGNyYXNoZWQvZGVwYXJ0ZWQuIEl0IHByb2JhYmlsaXN0aWNhbGx5IGtlZXBzIGFuIGFyYyB1cFxuICogXFxwYXJhbSBwZWVyIHRoZSBwZWVyIHRoYXQgY2Fubm90IGJlIHJlYWNoZWRcbiAqL1xuU3ByYXkucHJvdG90eXBlLm9uUGVlckRvd24gPSBmdW5jdGlvbihwZWVyKXtcbiAgICBjb25zb2xlLmxvZygnd3J0YzogYSBuZWlnaGJvciBjcmFzaGVkL2xlZnQnKTtcbiAgICAvLyAjQSByZW1vdmUgYWxsIG9jY3VycmVuY2VzIG9mIHRoZSBwZWVyIGluIHRoZSBwYXJ0aWFsIHZpZXdcbiAgICB2YXIgb2NjID0gdGhpcy5wYXJ0aWFsVmlldy5yZW1vdmVBbGwocGVlcik7XG4gICAgdGhpcy5zb2NrZXRzLnJlbW92ZVNvY2tldChwZWVyKTtcbiAgICAvLyAjQiBwcm9iYWJpbGlzdGljYWxseSByZWNyZWF0ZSBhbiBhcmMgdG8gYSBrbm93biBwZWVyXG4gICAgaWYgKHRoaXMucGFydGlhbFZpZXcubGVuZ3RoKCkgPiAwKXtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBvY2M7ICsraSl7XG4gICAgICAgICAgICBpZiAoTWF0aC5yYW5kb20oKSA+ICgxLyh0aGlzLnBhcnRpYWxWaWV3Lmxlbmd0aCgpK29jYykpKXtcbiAgICAgICAgICAgICAgICB2YXIgcm4gPSBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkqdGhpcy5wYXJ0aWFsVmlldy5sZW5ndGgoKSk7XG4gICAgICAgICAgICAgICAgdGhpcy5wYXJ0aWFsVmlldy5hZGROZWlnaGJvcih0aGlzLnBhcnRpYWxWaWV3LmFycmF5LmFycltybl0pO1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKCd3cnRjOiBjcmVhdGUgYSBkdXBsaWNhdGUnKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgIH07XG4gICAgfTtcbiAgICB0aGlzLnVwZGF0ZVN0YXRlKCk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgYSBjb25uZWN0aW9uIGZhaWxlZCB0byBlc3RhYmxpc2ggcHJvcGVybHksIHN5c3RlbWF0aWNhbGx5IGR1cGxpY2F0ZXNcbiAqIGFuIGVsZW1lbnQgb2YgdGhlIHBhcnRpYWwgdmlldy5cbiAqL1xuU3ByYXkucHJvdG90eXBlLm9uQXJjRG93biA9IGZ1bmN0aW9uKCl7XG4gICAgY29uc29sZS5sb2coJ3dydGM6IGFuIGFyYyBkaWQgbm90IHByb3Blcmx5IGVzdGFibGlzaGVkJyk7XG4gICAgaWYgKHRoaXMucGFydGlhbFZpZXcubGVuZ3RoKCk+MCl7XG4gICAgICAgIHZhciBybiA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSp0aGlzLnBhcnRpYWxWaWV3Lmxlbmd0aCgpKTtcbiAgICAgICAgdGhpcy5wYXJ0aWFsVmlldy5hZGROZWlnaGJvcih0aGlzLnBhcnRpYWxWaWV3LmFycmF5LmFycltybl0pO1xuICAgIH07XG4gICAgdGhpcy51cGRhdGVTdGF0ZSgpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIFdlYlJUQyBzcGVjaWZpYyBldmVudC4gQSBuZWlnaGJvciB3YW50cyB1cyB0byBjb25uZWN0IHRvIGFub3RoZXIgcGVlci5cbiAqIFRvIGRvIHNvLCB0aGUgZm9ybWVyIHJlcXVlc3RzIGFuIG9mZmVyIHRpY2tldCBpdCBjYW4gZXhjaGFuZ2Ugd2l0aCBvbmUgb2ZcbiAqIGl0cyBuZWlnaGJvci5cbiAqIFxccGFyYW0gcGVlciB0aGUgaWRlbnRpZmllciBvZiB0aGUgcmVxdWVzdCBtZXNzYWdlXG4gKi9cblNwcmF5LnByb3RvdHlwZS5vblRpY2tldFJlcXVlc3QgPSBmdW5jdGlvbihpZCl7XG4gICAgdmFyIG9wdGlvbnM9dGhpcy5PUFRJT05TOyBvcHRpb25zLmluaXRpYXRvcj10cnVlOyBvcHRpb25zLnRyaWNrbGU9ZmFsc2U7XG4gICAgdmFyIHNvY2tldCA9IG5ldyBTb2NrZXQob3B0aW9ucyksXG4gICAgICAgIHNlbGYgPSB0aGlzO1xuICAgIC8vICMxIGdldCB0aGUgb2ZmZXIgdGlja2V0IGZyb20gdGhlIHN0dW4gc2VydmljZSAgICBcbiAgICBzb2NrZXQub24oJ3NpZ25hbCcsIGZ1bmN0aW9uKGRhdGEpe1xuICAgICAgICAvLyAjQSByZWdpc3RlciB0aGlzIHNvY2tldCBpbiBwZW5kaW5nIHNvY2tldHMgZGljdGlvbm5hcnlcbiAgICAgICAgdmFyIG1lc3NhZ2UgPSBuZXcgTU9mZmVyVGlja2V0KGlkLCBkYXRhLCB7aWQ6IHNlbGYuSUR9KTtcbiAgICAgICAgc2VsZi5wZW5kaW5nLmFkZFNvY2tldChzb2NrZXQsIG1lc3NhZ2UpO1xuICAgICAgICAvLyAjQiBzZW5kIHRoZSBvZmZlciB0aWNrZXQgdG8gdGhlIHJlcXVlc3RlciBhbG9uZyB3aXRoIG91ciBpZGVudGlmaWVyXG4gICAgICAgIHNlbGYuc2VuZChtZXNzYWdlLCBtZXNzYWdlKTtcbiAgICAgICAgLy8gI0MgcmVtb3ZlIHRoZSBmb3J3YXJkaW5nIHJvdXRlIFxuICAgICAgICBzZWxmLmZvcndhcmRzLnJlbW92ZVNvY2tldChtZXNzYWdlKTtcbiAgICB9KTtcbiAgICAvLyAjMiBzdWNjZXNzZnVsIGNvbm5lY3Rpb24gZXN0YWJsaXNobWVudFxuICAgIHNvY2tldC5vbignY29ubmVjdCcsIGZ1bmN0aW9uKCl7XG4gICAgICAgIGNvbnNvbGUubG9nKCd3cnRjOiBzdWNjZXNzZnVsIGNvbm5lY3Rpb24gZXN0YWJsaXNobWVudCcpO1xuICAgICAgICAvLyAjQSByZW1vdmUgZnJvbSB0aGUgcGVuZGluZyBzb2NrZXRzIGRpY3Rpb25uYXJ5XG4gICAgICAgIHNlbGYucGVuZGluZy5yZW1vdmVTb2NrZXQoe2lkOmlkfSk7XG4gICAgICAgIHNlbGYuaW5WaWV3LmFkZChzb2NrZXQsIGlkKTtcbiAgICAgICAgc2VsZi51cGRhdGVTdGF0ZSgpO1xuICAgIH0pO1xuICAgIC8vICMzIGNsb3NlZCBjb25uZWN0aW9uXG4gICAgc29ja2V0Lm9uKCdjbG9zZScsIGZ1bmN0aW9uKCl7XG4gICAgICAgIGNvbnNvbGUubG9nKCd3cnRjOiBhIGNvbm5lY3Rpb24gaGFzIGJlZW4gY2xvc2VkJyk7XG4gICAgICAgIHNlbGYuaW5WaWV3LnJlbW92ZShpZCk7XG4gICAgICAgIHNlbGYudXBkYXRlU3RhdGUoKTtcbiAgICB9KTtcbiAgICAvLyAjNCByZWNlaXZlIGEgbWVzc2FnZVxuICAgIHNvY2tldC5vbignZGF0YScsIGZ1bmN0aW9uKG1lc3NhZ2Upe1xuICAgICAgICBzZWxmLnJlY2VpdmUoc29ja2V0LCBtZXNzYWdlKTtcbiAgICB9KTtcbiAgICBzb2NrZXQub24oJ3N0cmVhbScsIGZ1bmN0aW9uKHN0cmVhbSl7XG4gICAgICAgIHNlbGYuZW1pdCgnc3RyZWFtJywgc29ja2V0LCBzdHJlYW0pO1xuICAgIH0pO1xuICAgIFxuICAgIC8vICM1IHRpbWVvdXQgb24gY29ubmVjdGlvbiBlc3RhYmxpc2htZW50XG4gICAgc2V0VGltZW91dChmdW5jdGlvbigpe1xuICAgICAgICAvLyAjQSBjaGVjayBpZiBpdCB0aGUgY29ubmVjdGlvbiBlc3RhYmxpc2hlZCwgb3RoZXJ3aXNlLCBjbGVhbiBzb2NrZXRcbiAgICAgICAgaWYgKHNlbGYucGVuZGluZy5jb250YWlucyh7aWQ6aWR9KSl7XG4gICAgICAgICAgICBzZWxmLnBlbmRpbmcucmVtb3ZlU29ja2V0KHtpZDppZH0pO1xuICAgICAgICAgICAgc29ja2V0LmRlc3Ryb3koKTtcbiAgICAgICAgfTtcbiAgICB9LCB0aGlzLlRJTUVPVVQpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIFdlYlJUQyBzcGVjaWZpYyBldmVudC4gQSBuZWlnaGJvciBzZW50IGEgdGlja2V0IHRvIHN0YW1wLiBXZSBtdXN0XG4gKiBzdGFtcCBpdCBiYWNrIHRvIGVzdGFibGlzaCBhIGNvbm5lY3Rpb24uXG4gKiBcXHBhcmFtIGlkIHRoZSBpZGVudGlmaWVyIG9mIHRoZSBtZXNzYWdlIGNhcnJ5aW5nIHRoZSBvZmZlciB0aWNrZXRcbiAqIFxccGFyYW0gdGlja2V0IHRoZSBvZmZlciB0aWNrZXQgdG8gc3RhbXBcbiAqIFxccGFyYW0gcGVlciB0aGUgZW1pdHRpbmcgcGVlciBjb250YWluaW5nIGl0cyBpZGVudGlmaWVyXG4gKi9cblNwcmF5LnByb3RvdHlwZS5vblN0YW1wZWRUaWNrZXRSZXF1ZXN0ID0gZnVuY3Rpb24oaWQsIHRpY2tldCwgcGVlcil7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIC8vICMxIGlmIHRoZSBwYXJ0aWFsIHZpZXcgYWxyZWFkeSBjb250YWlucyB0aGlzIG5laWdiaG9yLCBkdXBsaWNhdGUgdGhlXG4gICAgLy8gZW50cnkgYW5kIHN0b3AgdGhlIHByb2Nlc3N1c1xuICAgIGlmICh0aGlzLnBhcnRpYWxWaWV3LmNvbnRhaW5zKHBlZXIpKXtcbiAgICAgICAgY29uc29sZS5sb2coXCJ3cnRjOiBjcmVhdGUgYSBkdXBsaWNhdGVcIik7XG4gICAgICAgIHRoaXMucGFydGlhbFZpZXcuYWRkTmVpZ2hib3IocGVlcik7XG4gICAgICAgIC8vICMyIHNlbmQgYW4gZW1wdHkgc3RhbXBlZCB0aWNrZXQgdG8gY2xvc2UgdGhlIHBlbmRpbmcgYW5kIGZvcndhcmRpbmdzXG4gICAgICAgIHZhciBtZXNzYWdlID0gbmV3IE1TdGFtcGVkVGlja2V0KGlkLCBudWxsLCB7aWQ6c2VsZi5JRH0pO1xuICAgICAgICBzZWxmLnNlbmQobWVzc2FnZSwgbWVzc2FnZSk7XG4gICAgICAgIHNlbGYuZm9yd2FyZHMucmVtb3ZlU29ja2V0KHtpZDppZH0pO1xuICAgICAgICByZXR1cm47IC8vIGRvIG5vdGhpbmcgZWxzZS4gVWdseSByZXR1cm5cbiAgICB9O1xuICAgIC8vICMyIG90aGVyd2lzZSBjcmVhdGVzIGFuIGFuc3dlclxuICAgIHZhciBvcHRpb25zPXRoaXMuT1BUSU9OUzsgb3B0aW9ucy5pbml0aWF0b3I9ZmFsc2U7IG9wdGlvbnMudHJpY2tsZT1mYWxzZTtcbiAgICB2YXIgc29ja2V0ID0gbmV3IFNvY2tldChvcHRpb25zKTtcbiAgICAvLyAjMyBnZXQgdGhlIHN0YW1wZWQgdGlja2V0IGZyb20gdGhlIHN0dW4gc2VydmljZVxuICAgIHNvY2tldC5vbignc2lnbmFsJywgZnVuY3Rpb24oZGF0YSl7XG4gICAgICAgIC8vICNBIGNyZWF0ZSB0aGUgbWVzc2FnZSBjb250YWluaW5nIHRoZSBzdGFtcGVkIHRpY2tldFxuICAgICAgICB2YXIgbWVzc2FnZSA9IG5ldyBNU3RhbXBlZFRpY2tldChpZCwgZGF0YSwge2lkOnNlbGYuSUR9KTtcbiAgICAgICAgLy8gI0Igc2VuZCBpdCBiYWNrIGZyb20gd2hlcmUgaXQgYXJyaXZlc1xuICAgICAgICBzZWxmLnNlbmQobWVzc2FnZSwgbWVzc2FnZSk7XG4gICAgICAgIC8vICNDIHJlbW92ZSB0aGUgZm9yd2FyZGluZyByb3V0ZVxuICAgICAgICBzZWxmLmZvcndhcmRzLnJlbW92ZVNvY2tldChtZXNzYWdlKTtcbiAgICB9KTtcbiAgICAvLyAjNCBzdWNjZXNzZnVsIGNvbm5lY3Rpb24gZXN0YWJsaXNobWVudFxuICAgIHNvY2tldC5vbignY29ubmVjdCcsIGZ1bmN0aW9uKCl7XG4gICAgICAgIGNvbnNvbGUubG9nKCd3cnRjOiBzdWNjZXNzZnVsIGNvbm5lY3Rpb24gZXN0YWJsaXNobWVudCcpO1xuICAgICAgICAvLyAjQSByZW1vdmUgZnJvbSBwZW5kaW5nXG4gICAgICAgIHNlbGYucGVuZGluZy5yZW1vdmVTb2NrZXQoe2lkOmlkfSk7ICAgICAgICBcbiAgICAgICAgLy8gI0IgYWRkIHRoZSBuZWlnYmhvciB0byBvdXIgcGFydGlhbCB2aWV3XG4gICAgICAgIHNlbGYucGFydGlhbFZpZXcuYWRkTmVpZ2hib3IocGVlcik7XG4gICAgICAgIC8vICNDIGFkZCB0aGUgbmVpZ2Job3IgdG8gdGhlIHNvY2tldCBkaWN0aW9ubmFyeSwgaWYgaXQgZG9lcyBub3QgZXhpc3RcbiAgICAgICAgaWYgKCFzZWxmLnNvY2tldHMuYWRkU29ja2V0KHNvY2tldCwgcGVlcikpe1xuICAgICAgICAgICAgc29ja2V0LmRlc3Ryb3koKTtcbiAgICAgICAgfTtcbiAgICAgICAgc2VsZi51cGRhdGVTdGF0ZSgpO1xuICAgIH0pO1xuICAgIC8vICM1IGNsb3NlZCBjb25uZWN0aW9uXG4gICAgc29ja2V0Lm9uKCdjbG9zZScsIGZ1bmN0aW9uKCl7XG4gICAgICAgIGNvbnNvbGUubG9nKCd3cnRjOiBhIGNvbm5lY3Rpb24gaGFzIGJlZW4gY2xvc2VkJyk7XG4gICAgICAgIHNlbGYudXBkYXRlU3RhdGUoKTtcbiAgICB9KTtcbiAgICAvLyAjNiByZWNlaXZlIGEgbWVzc2FnZVxuICAgIHNvY2tldC5vbignZGF0YScsIGZ1bmN0aW9uKG1lc3NhZ2Upe1xuICAgICAgICBzZWxmLnJlY2VpdmUoc29ja2V0LCBtZXNzYWdlKTtcbiAgICB9KTtcbiAgICBzb2NrZXQub24oJ3N0cmVhbScsIGZ1bmN0aW9uKHN0cmVhbSl7XG4gICAgICAgIHNlbGYuZW1pdCgnc3RyZWFtJywgc29ja2V0LCBzdHJlYW0pO1xuICAgIH0pO1xuICAgIC8vICM3IHNpZ25hbCB0aGUgb2ZmZXIgdGlja2V0IHRvIHRoZSBmcmVzaCBzb2NrZXRcbiAgICBzb2NrZXQuc2lnbmFsKHRpY2tldCk7XG4gICAgdGhpcy5wZW5kaW5nLmFkZFNvY2tldChzb2NrZXQsIHtpZDppZH0pO1xuICAgIC8vICM4IGEgdGltZW91dCBvbiBjb25uZWN0aW9uIGVzdGFibGlzaG1lbnRcbiAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7XG4gICAgICAgIGlmIChzZWxmLnBlbmRpbmcuY29udGFpbnMoe2lkOmlkfSkpe1xuICAgICAgICAgICAgLy8gI0EgaWYgdGhlIGNvbm5lY3Rpb24gaXMgbm90IHN1Y2Nlc3NmdWwsIHJlbW92ZSB0aGUgc29ja2V0IGFuZFxuICAgICAgICAgICAgLy8gY3JlYXRlIGEgZHVwbGljYXRlXG4gICAgICAgICAgICBzZWxmLnBlbmRpbmcucmVtb3ZlU29ja2V0KHtpZDppZH0pO1xuICAgICAgICAgICAgc29ja2V0LmRlc3Ryb3koKTtcbiAgICAgICAgICAgIHNlbGYub25BcmNEb3duKCk7XG4gICAgICAgIH07XG4gICAgfSwgdGhpcy5USU1FT1VUKTtcbn07XG5cbi8qIVxuICogXFxicmllZiBzZW5kIGEgbWVzc2FnZSB0byBhIHBhcnRpY3VsYXIgcGVlci4gSWYgbm8gcGVlciBhcmUgcGFzc2VkIGluXG4gKiBhcmd1bWVudHMsIGl0IHdpbGwgdHJ5IHRvIGZvcndhcmRzIGl0IHRoZSBhcHByb3ByaWF0ZSBwZWVyLlxuICogXFxwYXJhbSBtZXNzYWdlIHRoZSBtZXNzYWdlIHRvIHNlbmRcbiAqIFxccGFyYW0gb2JqZWN0IHRoZSBvYmplY3QgY29udGFpbmluZyB0aGUgaWQgdG8gc2VuZCB0aGUgbWVzc2FnZVxuICogXFxwYXJhbSByZXR1cm4gdHJ1ZSBpZiB0aGUgbWVzc2FnZSBhcyBiZWVuIHNlbnQsIGZhbHNlIG90aGVyd2lzZVxuICovXG5TcHJheS5wcm90b3R5cGUuc2VuZCA9IGZ1bmN0aW9uKG1lc3NhZ2UsIG9iamVjdCl7XG4gICAgdmFyIHNlbnQgPSBmYWxzZTtcbiAgICB2YXIgaWQgPSAob2JqZWN0ICYmIG9iamVjdC5pZCkgfHwgbWVzc2FnZS5pZDtcbiAgICB2YXIgc29ja2V0ID0gdGhpcy5zb2NrZXRzLmdldFNvY2tldCh7aWQ6aWR9KTtcbiAgICBpZiAoc29ja2V0ICE9PSBudWxsKXtcbiAgICAgICAgaWYgKHNvY2tldC5jb25uZWN0ZWQgJiZcbiAgICAgICAgICAgIHNvY2tldC5fY2hhbm5lbCAmJiBzb2NrZXQuX2NoYW5uZWwucmVhZHlTdGF0ZSA9PT0gJ29wZW4nKXtcbiAgICAgICAgICAgIHNvY2tldC5zZW5kKG1lc3NhZ2UpO1xuICAgICAgICAgICAgc2VudCA9IHRydWU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLm9uUGVlckRvd24oe2lkOmlkfSk7ICAgICAgICAgICAgXG4gICAgICAgIH07XG4gICAgfSBlbHNlIHtcbiAgICAgICAgc29ja2V0ID0gdGhpcy5mb3J3YXJkcy5nZXRTb2NrZXQoe2lkOmlkfSk7XG4gICAgICAgIGlmIChzb2NrZXQgIT09IG51bGwgJiYgc29ja2V0LmNvbm5lY3RlZCAmJlxuICAgICAgICAgICAgc29ja2V0Ll9jaGFubmVsICYmIHNvY2tldC5fY2hhbm5lbC5yZWFkeVN0YXRlID09PSAnb3Blbicpe1xuICAgICAgICAgICAgc29ja2V0LnNlbmQobWVzc2FnZSk7XG4gICAgICAgICAgICBzZW50ID0gdHJ1ZTtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIHJldHVybiBzZW50O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHJlY2VpdmUgYSBtZW1iZXJzaGlwIG1lc3NhZ2UgYW5kIHByb2Nlc3MgaXQgYWNjb3JkaW5nbHlcbiAqIFxccGFyYW0gc29ja2V0IHRoZSBzb2NrZXQgZnJvbSB3aGljaCB3ZSByZWNlaXZlIHRoZSBtZXNzYWdlXG4gKiBcXHBhcmFtIG1lc3NhZ2UgdGhlIHJlY2VpdmVkIG1lc3NhZ2VcbiAqL1xuU3ByYXkucHJvdG90eXBlLnJlY2VpdmUgPSBmdW5jdGlvbihzb2NrZXQsIG1lc3NhZ2Upe1xuICAgIGlmIChtZXNzYWdlICYmIG1lc3NhZ2UucHJvdG9jb2wpe1xuICAgICAgICB0aGlzLmVtaXQobWVzc2FnZS5wcm90b2NvbCsnLXJlY2VpdmUnLCBzb2NrZXQsIG1lc3NhZ2UpO1xuICAgIH07XG59O1xuXG5TcHJheS5wcm90b3R5cGUub25TcHJheVJlY2VpdmUgPSBmdW5jdGlvbihzb2NrZXQsIG1lc3NhZ2Upe1xuICAgIHN3aXRjaCAobWVzc2FnZS50eXBlKXtcbiAgICBjYXNlICdNSm9pbic6XG4gICAgICAgIGNvbnNvbGUubG9nKCd3cnRjOiBhIG5ldyBtZW1iZXIgam9pbnMgdGhlIG5ldHdvcmsnKTtcbiAgICAgICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7XG4gICAgICAgICAgICBzZWxmLmZvcndhcmRzLmFkZFNvY2tldChzb2NrZXQsIG1lc3NhZ2UpO1xuICAgICAgICAgICAgc2VsZi5vbkpvaW4obWVzc2FnZS5pZCk7XG4gICAgICAgICAgICBzZWxmLmZvcndhcmRzLnJlbW92ZVNvY2tldChtZXNzYWdlKTtcbiAgICAgICAgfSwgMTAwMCk7IC8vIG1ha2Ugc3VyZSB0aGF0IHRoZSBzb2NrZXQgaXMgdW5kb3VidGVkbHkgb3BlbmVkXG4gICAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ01SZXF1ZXN0VGlja2V0JzpcbiAgICAgICAgY29uc29sZS5sb2coJ3dydGM6IGEgbWVtYmVyIHJlcXVlc3QgYW4gb2ZmZXIgdGlja2V0Jyk7XG4gICAgICAgIHRoaXMuZm9yd2FyZHMuYWRkU29ja2V0KHNvY2tldCwgbWVzc2FnZSk7XG4gICAgICAgIHRoaXMub25UaWNrZXRSZXF1ZXN0KG1lc3NhZ2UuaWQpO1xuICAgICAgICBicmVhaztcbiAgICBjYXNlICdNT2ZmZXJUaWNrZXQnOlxuICAgICAgICBjb25zb2xlLmxvZygnd3J0YzogeW91IHJlY2VpdmVkIGFuIG9mZmVyIHRpY2tldCcpO1xuICAgICAgICBpZiAoIXRoaXMuZm9yd2FyZHMuY29udGFpbnMobWVzc2FnZSkpe1xuICAgICAgICAgICAgLy8gIzEgaWYgdGhlcmUgaXMgbm8gZm9yd2FyZGluZyByb3V0ZSwgdGhlIG9mZmVyIHRpY2tldCBpcyBmb3IgdXMgdG9cbiAgICAgICAgICAgIC8vIHN0YW1wXG4gICAgICAgICAgICB0aGlzLmZvcndhcmRzLmFkZFNvY2tldChzb2NrZXQsIG1lc3NhZ2UpO1xuICAgICAgICAgICAgdGhpcy5vblN0YW1wZWRUaWNrZXRSZXF1ZXN0KG1lc3NhZ2UuaWQsbWVzc2FnZS50aWNrZXQsbWVzc2FnZS5wZWVyKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vICMyQSBvdGhlcndpc2UsIHdlIGZvcndhcmQgdGhlIG9mZmVyIHRpY2tldCBhY2NvcmRpbmdseVxuICAgICAgICAgICAgaWYgKHRoaXMuc2VuZChtZXNzYWdlLCBtZXNzYWdlKSl7XG4gICAgICAgICAgICAgICAgLy8gIzJCIGludmVydCB0aGUgZGlyZWN0aW9uIG9mIGZvcndhcmRpbmcgcm91dGUgaW4gb3JkZXIgdG9cbiAgICAgICAgICAgICAgICAvLyBjb25zaXN0ZW50bHkgcmVkaXJlY3QgdGhlIHN0YW1wZWQgdGlja2V0XG4gICAgICAgICAgICAgICAgdGhpcy5mb3J3YXJkcy5yZW1vdmVTb2NrZXQobWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgdGhpcy5mb3J3YXJkcy5hZGRTb2NrZXQoc29ja2V0LCBtZXNzYWdlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gIzJDIGlmIHRoZSBtZXNzYWdlIGhhcyBub3QgYmVlbiBzZW50LCBzaW1wbHkgcmVtb3ZlIHRoZSByb3V0ZVxuICAgICAgICAgICAgICAgIHRoaXMuZm9yd2FyZHMucmVtb3ZlU29ja2V0KG1lc3NhZ2UpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfTtcbiAgICAgICAgYnJlYWs7XG4gICAgY2FzZSAnTVN0YW1wZWRUaWNrZXQnOlxuICAgICAgICBjb25zb2xlLmxvZygnd3J0YzogeW91IHJlY2VpdmVkIGEgc3RhbXBlZCB0aWNrZXQnKTtcbiAgICAgICAgaWYgKCF0aGlzLmZvcndhcmRzLmNvbnRhaW5zKG1lc3NhZ2UpKXtcbiAgICAgICAgICAgIC8vICMxIGlmIHRoZXJlIGlzIG5vIGZvcndhcmRpbmcgcm91dGUsIHRoZSBtZXNzYWdlIGlzIGZvciB1cyB0b1xuICAgICAgICAgICAgLy8gZmluYWxpemVcbiAgICAgICAgICAgIGlmIChtZXNzYWdlLnRpY2tldCA9PT0gbnVsbCl7XG4gICAgICAgICAgICAgICAgLy8gIzFBIGVtcHR5IHRpY2tldCBtZWFuaW5nIHRoZSByZW1vdGUgcGVlciBhbHJlYWR5IGtub3dzIHVzLFxuICAgICAgICAgICAgICAgIC8vIHRoZXJlZm9yZSwgc2ltcGx5IGNsb3NlIHRoZSBwZW5kaW5nIG9mZmVyXG4gICAgICAgICAgICAgICAgdmFyIHNvY2tldCA9IHRoaXMucGVuZGluZy5yZW1vdmVTb2NrZXQobWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgc29ja2V0LmRlc3Ryb3koKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gIzFCIG90aGVyd2lzZSwgZmluYWxpemUgdGhlIGNvbm5lY3Rpb25cbiAgICAgICAgICAgICAgICB0aGlzLnBlbmRpbmcuZ2V0U29ja2V0KG1lc3NhZ2UpLnNpZ25hbChtZXNzYWdlLnRpY2tldCk7XG4gICAgICAgICAgICB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gIzJBIG90aGVyd2lzZSwgd2UgZm9yd2FyZCB0aGUgc3RhbXBlZCB0aWNrZXQgYWNjb3JkaW5nbHlcbiAgICAgICAgICAgIHRoaXMuc2VuZChtZXNzYWdlLCBtZXNzYWdlKTtcbiAgICAgICAgICAgIC8vICMyQiByZW1vdmUgdGhlIGRpcmVjdGlvbiBmcm9tIHRoZSBrbm93biBmb3J3YXJkaW5nIHJvdXRlc1xuICAgICAgICAgICAgdGhpcy5mb3J3YXJkcy5yZW1vdmVTb2NrZXQobWVzc2FnZSk7XG4gICAgICAgIH07XG4gICAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ01FeGNoYW5nZSc6XG4gICAgICAgIGNvbnNvbGUubG9nKCd3cnRjOiBhIHBlZXIgc3RhcnRzIHRvIGV4Y2hhbmdlIHdpdGggeW91Jyk7XG4gICAgICAgIHRoaXMuZm9yd2FyZHMuYWRkU29ja2V0KHNvY2tldCwgbWVzc2FnZSk7XG4gICAgICAgIHRoaXMub25FeGNoYW5nZShtZXNzYWdlLmlkLCBtZXNzYWdlLnBlZXIpO1xuICAgICAgICB0aGlzLmZvcndhcmRzLnJlbW92ZVNvY2tldChtZXNzYWdlKTtcbiAgICAgICAgYnJlYWs7XG4gICAgfTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gU3ByYXk7XG4iLCIvKiBnbG9iYWwgQmxvYiAqL1xuXG5tb2R1bGUuZXhwb3J0cyA9IFBlZXJcblxudmFyIGRlYnVnID0gcmVxdWlyZSgnZGVidWcnKSgnc2ltcGxlLXBlZXInKVxudmFyIGhhdCA9IHJlcXVpcmUoJ2hhdCcpXG52YXIgaW5oZXJpdHMgPSByZXF1aXJlKCdpbmhlcml0cycpXG52YXIgaXNUeXBlZEFycmF5ID0gcmVxdWlyZSgnaXMtdHlwZWRhcnJheScpXG52YXIgb25jZSA9IHJlcXVpcmUoJ29uY2UnKVxudmFyIHN0cmVhbSA9IHJlcXVpcmUoJ3N0cmVhbScpXG52YXIgdG9CdWZmZXIgPSByZXF1aXJlKCd0eXBlZGFycmF5LXRvLWJ1ZmZlcicpXG5cbmluaGVyaXRzKFBlZXIsIHN0cmVhbS5EdXBsZXgpXG5cbi8qKlxuICogV2ViUlRDIHBlZXIgY29ubmVjdGlvbi4gU2FtZSBBUEkgYXMgbm9kZSBjb3JlIGBuZXQuU29ja2V0YCwgcGx1cyBhIGZldyBleHRyYSBtZXRob2RzLlxuICogRHVwbGV4IHN0cmVhbS5cbiAqIEBwYXJhbSB7T2JqZWN0fSBvcHRzXG4gKi9cbmZ1bmN0aW9uIFBlZXIgKG9wdHMpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmICghKHNlbGYgaW5zdGFuY2VvZiBQZWVyKSkgcmV0dXJuIG5ldyBQZWVyKG9wdHMpXG4gIHNlbGYuX2RlYnVnKCduZXcgcGVlciAlbycsIG9wdHMpXG5cbiAgaWYgKCFvcHRzKSBvcHRzID0ge31cbiAgb3B0cy5hbGxvd0hhbGZPcGVuID0gZmFsc2VcbiAgaWYgKG9wdHMuaGlnaFdhdGVyTWFyayA9PSBudWxsKSBvcHRzLmhpZ2hXYXRlck1hcmsgPSAxMDI0ICogMTAyNFxuXG4gIHN0cmVhbS5EdXBsZXguY2FsbChzZWxmLCBvcHRzKVxuXG4gIHNlbGYuaW5pdGlhdG9yID0gb3B0cy5pbml0aWF0b3IgfHwgZmFsc2VcbiAgc2VsZi5jaGFubmVsQ29uZmlnID0gb3B0cy5jaGFubmVsQ29uZmlnIHx8IFBlZXIuY2hhbm5lbENvbmZpZ1xuICBzZWxmLmNoYW5uZWxOYW1lID0gb3B0cy5jaGFubmVsTmFtZSB8fCBoYXQoMTYwKVxuICBpZiAoIW9wdHMuaW5pdGlhdG9yKSBzZWxmLmNoYW5uZWxOYW1lID0gbnVsbFxuICBzZWxmLmNvbmZpZyA9IG9wdHMuY29uZmlnIHx8IFBlZXIuY29uZmlnXG4gIHNlbGYuY29uc3RyYWludHMgPSBvcHRzLmNvbnN0cmFpbnRzIHx8IFBlZXIuY29uc3RyYWludHNcbiAgc2VsZi5yZWNvbm5lY3RUaW1lciA9IG9wdHMucmVjb25uZWN0VGltZXIgfHwgMFxuICBzZWxmLnNkcFRyYW5zZm9ybSA9IG9wdHMuc2RwVHJhbnNmb3JtIHx8IGZ1bmN0aW9uIChzZHApIHsgcmV0dXJuIHNkcCB9XG4gIHNlbGYuc3RyZWFtID0gb3B0cy5zdHJlYW0gfHwgZmFsc2VcbiAgc2VsZi50cmlja2xlID0gb3B0cy50cmlja2xlICE9PSB1bmRlZmluZWQgPyBvcHRzLnRyaWNrbGUgOiB0cnVlXG5cbiAgc2VsZi5kZXN0cm95ZWQgPSBmYWxzZVxuICBzZWxmLmNvbm5lY3RlZCA9IGZhbHNlXG5cbiAgLy8gc28gUGVlciBvYmplY3QgYWx3YXlzIGhhcyBzYW1lIHNoYXBlIChWOCBvcHRpbWl6YXRpb24pXG4gIHNlbGYucmVtb3RlQWRkcmVzcyA9IHVuZGVmaW5lZFxuICBzZWxmLnJlbW90ZUZhbWlseSA9IHVuZGVmaW5lZFxuICBzZWxmLnJlbW90ZVBvcnQgPSB1bmRlZmluZWRcbiAgc2VsZi5sb2NhbEFkZHJlc3MgPSB1bmRlZmluZWRcbiAgc2VsZi5sb2NhbFBvcnQgPSB1bmRlZmluZWRcblxuICBzZWxmLl93cnRjID0gb3B0cy53cnRjIHx8IGdldEJyb3dzZXJSVEMoKVxuICBpZiAoIXNlbGYuX3dydGMpIHtcbiAgICBpZiAodHlwZW9mIHdpbmRvdyA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignTm8gV2ViUlRDIHN1cHBvcnQ6IFNwZWNpZnkgYG9wdHMud3J0Y2Agb3B0aW9uIGluIHRoaXMgZW52aXJvbm1lbnQnKVxuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vIFdlYlJUQyBzdXBwb3J0OiBOb3QgYSBzdXBwb3J0ZWQgYnJvd3NlcicpXG4gICAgfVxuICB9XG5cbiAgc2VsZi5fbWF4QnVmZmVyZWRBbW91bnQgPSBvcHRzLmhpZ2hXYXRlck1hcmtcbiAgc2VsZi5fcGNSZWFkeSA9IGZhbHNlXG4gIHNlbGYuX2NoYW5uZWxSZWFkeSA9IGZhbHNlXG4gIHNlbGYuX2ljZUNvbXBsZXRlID0gZmFsc2UgLy8gaWNlIGNhbmRpZGF0ZSB0cmlja2xlIGRvbmUgKGdvdCBudWxsIGNhbmRpZGF0ZSlcbiAgc2VsZi5fY2hhbm5lbCA9IG51bGxcblxuICBzZWxmLl9jaHVuayA9IG51bGxcbiAgc2VsZi5fY2IgPSBudWxsXG4gIHNlbGYuX2ludGVydmFsID0gbnVsbFxuICBzZWxmLl9yZWNvbm5lY3RUaW1lb3V0ID0gbnVsbFxuXG4gIHNlbGYuX3BjID0gbmV3IChzZWxmLl93cnRjLlJUQ1BlZXJDb25uZWN0aW9uKShzZWxmLmNvbmZpZywgc2VsZi5jb25zdHJhaW50cylcbiAgc2VsZi5fcGMub25pY2Vjb25uZWN0aW9uc3RhdGVjaGFuZ2UgPSBzZWxmLl9vbkljZUNvbm5lY3Rpb25TdGF0ZUNoYW5nZS5iaW5kKHNlbGYpXG4gIHNlbGYuX3BjLm9uc2lnbmFsaW5nc3RhdGVjaGFuZ2UgPSBzZWxmLl9vblNpZ25hbGluZ1N0YXRlQ2hhbmdlLmJpbmQoc2VsZilcbiAgc2VsZi5fcGMub25pY2VjYW5kaWRhdGUgPSBzZWxmLl9vbkljZUNhbmRpZGF0ZS5iaW5kKHNlbGYpXG5cbiAgaWYgKHNlbGYuc3RyZWFtKSBzZWxmLl9wYy5hZGRTdHJlYW0oc2VsZi5zdHJlYW0pXG4gIHNlbGYuX3BjLm9uYWRkc3RyZWFtID0gc2VsZi5fb25BZGRTdHJlYW0uYmluZChzZWxmKVxuXG4gIGlmIChzZWxmLmluaXRpYXRvcikge1xuICAgIHNlbGYuX3NldHVwRGF0YSh7IGNoYW5uZWw6IHNlbGYuX3BjLmNyZWF0ZURhdGFDaGFubmVsKHNlbGYuY2hhbm5lbE5hbWUsIHNlbGYuY2hhbm5lbENvbmZpZykgfSlcbiAgICBzZWxmLl9wYy5vbm5lZ290aWF0aW9ubmVlZGVkID0gb25jZShzZWxmLl9jcmVhdGVPZmZlci5iaW5kKHNlbGYpKVxuICAgIC8vIE9ubHkgQ2hyb21lIHRyaWdnZXJzIFwibmVnb3RpYXRpb25uZWVkZWRcIjsgdGhpcyBpcyBhIHdvcmthcm91bmQgZm9yIG90aGVyXG4gICAgLy8gaW1wbGVtZW50YXRpb25zXG4gICAgaWYgKHR5cGVvZiB3aW5kb3cgPT09ICd1bmRlZmluZWQnIHx8ICF3aW5kb3cud2Via2l0UlRDUGVlckNvbm5lY3Rpb24pIHtcbiAgICAgIHNlbGYuX3BjLm9ubmVnb3RpYXRpb25uZWVkZWQoKVxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBzZWxmLl9wYy5vbmRhdGFjaGFubmVsID0gc2VsZi5fc2V0dXBEYXRhLmJpbmQoc2VsZilcbiAgfVxuXG4gIHNlbGYub24oJ2ZpbmlzaCcsIGZ1bmN0aW9uICgpIHtcbiAgICBpZiAoc2VsZi5jb25uZWN0ZWQpIHtcbiAgICAgIC8vIFdoZW4gbG9jYWwgcGVlciBpcyBmaW5pc2hlZCB3cml0aW5nLCBjbG9zZSBjb25uZWN0aW9uIHRvIHJlbW90ZSBwZWVyLlxuICAgICAgLy8gSGFsZiBvcGVuIGNvbm5lY3Rpb25zIGFyZSBjdXJyZW50bHkgbm90IHN1cHBvcnRlZC5cbiAgICAgIC8vIFdhaXQgYSBiaXQgYmVmb3JlIGRlc3Ryb3lpbmcgc28gdGhlIGRhdGFjaGFubmVsIGZsdXNoZXMuXG4gICAgICAvLyBUT0RPOiBpcyB0aGVyZSBhIG1vcmUgcmVsaWFibGUgd2F5IHRvIGFjY29tcGxpc2ggdGhpcz9cbiAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICBzZWxmLl9kZXN0cm95KClcbiAgICAgIH0sIDEwMClcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gSWYgZGF0YSBjaGFubmVsIGlzIG5vdCBjb25uZWN0ZWQgd2hlbiBsb2NhbCBwZWVyIGlzIGZpbmlzaGVkIHdyaXRpbmcsIHdhaXQgdW50aWxcbiAgICAgIC8vIGRhdGEgaXMgZmx1c2hlZCB0byBuZXR3b3JrIGF0IFwiY29ubmVjdFwiIGV2ZW50LlxuICAgICAgLy8gVE9ETzogaXMgdGhlcmUgYSBtb3JlIHJlbGlhYmxlIHdheSB0byBhY2NvbXBsaXNoIHRoaXM/XG4gICAgICBzZWxmLm9uY2UoJ2Nvbm5lY3QnLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgIHNlbGYuX2Rlc3Ryb3koKVxuICAgICAgICB9LCAxMDApXG4gICAgICB9KVxuICAgIH1cbiAgfSlcbn1cblxuUGVlci5XRUJSVENfU1VQUE9SVCA9ICEhZ2V0QnJvd3NlclJUQygpXG5cbi8qKlxuICogRXhwb3NlIGNvbmZpZywgY29uc3RyYWludHMsIGFuZCBkYXRhIGNoYW5uZWwgY29uZmlnIGZvciBvdmVycmlkaW5nIGFsbCBQZWVyXG4gKiBpbnN0YW5jZXMuIE90aGVyd2lzZSwganVzdCBzZXQgb3B0cy5jb25maWcsIG9wdHMuY29uc3RyYWludHMsIG9yIG9wdHMuY2hhbm5lbENvbmZpZ1xuICogd2hlbiBjb25zdHJ1Y3RpbmcgYSBQZWVyLlxuICovXG5QZWVyLmNvbmZpZyA9IHtcbiAgaWNlU2VydmVyczogW1xuICAgIHtcbiAgICAgIHVybDogJ3N0dW46MjMuMjEuMTUwLjEyMScsIC8vIGRlcHJlY2F0ZWQsIHJlcGxhY2VkIGJ5IGB1cmxzYFxuICAgICAgdXJsczogJ3N0dW46MjMuMjEuMTUwLjEyMSdcbiAgICB9XG4gIF1cbn1cblBlZXIuY29uc3RyYWludHMgPSB7fVxuUGVlci5jaGFubmVsQ29uZmlnID0ge31cblxuT2JqZWN0LmRlZmluZVByb3BlcnR5KFBlZXIucHJvdG90eXBlLCAnYnVmZmVyU2l6ZScsIHtcbiAgZ2V0OiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzXG4gICAgcmV0dXJuIChzZWxmLl9jaGFubmVsICYmIHNlbGYuX2NoYW5uZWwuYnVmZmVyZWRBbW91bnQpIHx8IDBcbiAgfVxufSlcblxuUGVlci5wcm90b3R5cGUuYWRkcmVzcyA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIHJldHVybiB7IHBvcnQ6IHNlbGYubG9jYWxQb3J0LCBmYW1pbHk6ICdJUHY0JywgYWRkcmVzczogc2VsZi5sb2NhbEFkZHJlc3MgfVxufVxuXG5QZWVyLnByb3RvdHlwZS5zaWduYWwgPSBmdW5jdGlvbiAoZGF0YSkge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgaWYgKHNlbGYuZGVzdHJveWVkKSB0aHJvdyBuZXcgRXJyb3IoJ2Nhbm5vdCBzaWduYWwgYWZ0ZXIgcGVlciBpcyBkZXN0cm95ZWQnKVxuICBpZiAodHlwZW9mIGRhdGEgPT09ICdzdHJpbmcnKSB7XG4gICAgdHJ5IHtcbiAgICAgIGRhdGEgPSBKU09OLnBhcnNlKGRhdGEpXG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBkYXRhID0ge31cbiAgICB9XG4gIH1cbiAgc2VsZi5fZGVidWcoJ3NpZ25hbCgpJylcbiAgaWYgKGRhdGEuc2RwKSB7XG4gICAgc2VsZi5fcGMuc2V0UmVtb3RlRGVzY3JpcHRpb24obmV3IChzZWxmLl93cnRjLlJUQ1Nlc3Npb25EZXNjcmlwdGlvbikoZGF0YSksIGZ1bmN0aW9uICgpIHtcbiAgICAgIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG4gICAgICBpZiAoc2VsZi5fcGMucmVtb3RlRGVzY3JpcHRpb24udHlwZSA9PT0gJ29mZmVyJykgc2VsZi5fY3JlYXRlQW5zd2VyKClcbiAgICB9LCBzZWxmLl9vbkVycm9yLmJpbmQoc2VsZikpXG4gIH1cbiAgaWYgKGRhdGEuY2FuZGlkYXRlKSB7XG4gICAgdHJ5IHtcbiAgICAgIHNlbGYuX3BjLmFkZEljZUNhbmRpZGF0ZShcbiAgICAgICAgbmV3IChzZWxmLl93cnRjLlJUQ0ljZUNhbmRpZGF0ZSkoZGF0YS5jYW5kaWRhdGUpLCBub29wLCBzZWxmLl9vbkVycm9yLmJpbmQoc2VsZilcbiAgICAgIClcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHNlbGYuX2Rlc3Ryb3kobmV3IEVycm9yKCdlcnJvciBhZGRpbmcgY2FuZGlkYXRlOiAnICsgZXJyLm1lc3NhZ2UpKVxuICAgIH1cbiAgfVxuICBpZiAoIWRhdGEuc2RwICYmICFkYXRhLmNhbmRpZGF0ZSkge1xuICAgIHNlbGYuX2Rlc3Ryb3kobmV3IEVycm9yKCdzaWduYWwoKSBjYWxsZWQgd2l0aCBpbnZhbGlkIHNpZ25hbCBkYXRhJykpXG4gIH1cbn1cblxuLyoqXG4gKiBTZW5kIHRleHQvYmluYXJ5IGRhdGEgdG8gdGhlIHJlbW90ZSBwZWVyLlxuICogQHBhcmFtIHtUeXBlZEFycmF5Vmlld3xBcnJheUJ1ZmZlcnxCdWZmZXJ8c3RyaW5nfEJsb2J8T2JqZWN0fSBjaHVua1xuICovXG5QZWVyLnByb3RvdHlwZS5zZW5kID0gZnVuY3Rpb24gKGNodW5rKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuXG4gIGlmICghaXNUeXBlZEFycmF5LnN0cmljdChjaHVuaykgJiYgIShjaHVuayBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSAmJlxuICAgICFCdWZmZXIuaXNCdWZmZXIoY2h1bmspICYmIHR5cGVvZiBjaHVuayAhPT0gJ3N0cmluZycgJiZcbiAgICAodHlwZW9mIEJsb2IgPT09ICd1bmRlZmluZWQnIHx8ICEoY2h1bmsgaW5zdGFuY2VvZiBCbG9iKSkpIHtcbiAgICBjaHVuayA9IEpTT04uc3RyaW5naWZ5KGNodW5rKVxuICB9XG5cbiAgLy8gYHdydGNgIG1vZHVsZSBkb2Vzbid0IGFjY2VwdCBub2RlLmpzIGJ1ZmZlclxuICBpZiAoQnVmZmVyLmlzQnVmZmVyKGNodW5rKSAmJiAhaXNUeXBlZEFycmF5LnN0cmljdChjaHVuaykpIHtcbiAgICBjaHVuayA9IG5ldyBVaW50OEFycmF5KGNodW5rKVxuICB9XG5cbiAgdmFyIGxlbiA9IGNodW5rLmxlbmd0aCB8fCBjaHVuay5ieXRlTGVuZ3RoIHx8IGNodW5rLnNpemVcbiAgc2VsZi5fY2hhbm5lbC5zZW5kKGNodW5rKVxuICBzZWxmLl9kZWJ1Zygnd3JpdGU6ICVkIGJ5dGVzJywgbGVuKVxufVxuXG5QZWVyLnByb3RvdHlwZS5kZXN0cm95ID0gZnVuY3Rpb24gKG9uY2xvc2UpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIHNlbGYuX2Rlc3Ryb3kobnVsbCwgb25jbG9zZSlcbn1cblxuUGVlci5wcm90b3R5cGUuX2Rlc3Ryb3kgPSBmdW5jdGlvbiAoZXJyLCBvbmNsb3NlKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBpZiAoc2VsZi5kZXN0cm95ZWQpIHJldHVyblxuICBpZiAob25jbG9zZSkgc2VsZi5vbmNlKCdjbG9zZScsIG9uY2xvc2UpXG5cbiAgc2VsZi5fZGVidWcoJ2Rlc3Ryb3kgKGVycm9yOiAlcyknLCBlcnIgJiYgZXJyLm1lc3NhZ2UpXG5cbiAgc2VsZi5yZWFkYWJsZSA9IHNlbGYud3JpdGFibGUgPSBmYWxzZVxuXG4gIGlmICghc2VsZi5fcmVhZGFibGVTdGF0ZS5lbmRlZCkgc2VsZi5wdXNoKG51bGwpXG4gIGlmICghc2VsZi5fd3JpdGFibGVTdGF0ZS5maW5pc2hlZCkgc2VsZi5lbmQoKVxuXG4gIHNlbGYuZGVzdHJveWVkID0gdHJ1ZVxuICBzZWxmLmNvbm5lY3RlZCA9IGZhbHNlXG4gIHNlbGYuX3BjUmVhZHkgPSBmYWxzZVxuICBzZWxmLl9jaGFubmVsUmVhZHkgPSBmYWxzZVxuXG4gIHNlbGYuX2NodW5rID0gbnVsbFxuICBzZWxmLl9jYiA9IG51bGxcbiAgY2xlYXJJbnRlcnZhbChzZWxmLl9pbnRlcnZhbClcbiAgY2xlYXJUaW1lb3V0KHNlbGYuX3JlY29ubmVjdFRpbWVvdXQpXG5cbiAgaWYgKHNlbGYuX3BjKSB7XG4gICAgdHJ5IHtcbiAgICAgIHNlbGYuX3BjLmNsb3NlKClcbiAgICB9IGNhdGNoIChlcnIpIHt9XG5cbiAgICBzZWxmLl9wYy5vbmljZWNvbm5lY3Rpb25zdGF0ZWNoYW5nZSA9IG51bGxcbiAgICBzZWxmLl9wYy5vbnNpZ25hbGluZ3N0YXRlY2hhbmdlID0gbnVsbFxuICAgIHNlbGYuX3BjLm9uaWNlY2FuZGlkYXRlID0gbnVsbFxuICB9XG5cbiAgaWYgKHNlbGYuX2NoYW5uZWwpIHtcbiAgICB0cnkge1xuICAgICAgc2VsZi5fY2hhbm5lbC5jbG9zZSgpXG4gICAgfSBjYXRjaCAoZXJyKSB7fVxuXG4gICAgc2VsZi5fY2hhbm5lbC5vbm1lc3NhZ2UgPSBudWxsXG4gICAgc2VsZi5fY2hhbm5lbC5vbm9wZW4gPSBudWxsXG4gICAgc2VsZi5fY2hhbm5lbC5vbmNsb3NlID0gbnVsbFxuICB9XG4gIHNlbGYuX3BjID0gbnVsbFxuICBzZWxmLl9jaGFubmVsID0gbnVsbFxuXG4gIGlmIChlcnIpIHNlbGYuZW1pdCgnZXJyb3InLCBlcnIpXG4gIHNlbGYuZW1pdCgnY2xvc2UnKVxufVxuXG5QZWVyLnByb3RvdHlwZS5fc2V0dXBEYXRhID0gZnVuY3Rpb24gKGV2ZW50KSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBzZWxmLl9jaGFubmVsID0gZXZlbnQuY2hhbm5lbFxuICBzZWxmLmNoYW5uZWxOYW1lID0gc2VsZi5fY2hhbm5lbC5sYWJlbFxuXG4gIHNlbGYuX2NoYW5uZWwuYmluYXJ5VHlwZSA9ICdhcnJheWJ1ZmZlcidcbiAgc2VsZi5fY2hhbm5lbC5vbm1lc3NhZ2UgPSBzZWxmLl9vbkNoYW5uZWxNZXNzYWdlLmJpbmQoc2VsZilcbiAgc2VsZi5fY2hhbm5lbC5vbm9wZW4gPSBzZWxmLl9vbkNoYW5uZWxPcGVuLmJpbmQoc2VsZilcbiAgc2VsZi5fY2hhbm5lbC5vbmNsb3NlID0gc2VsZi5fb25DaGFubmVsQ2xvc2UuYmluZChzZWxmKVxufVxuXG5QZWVyLnByb3RvdHlwZS5fcmVhZCA9IGZ1bmN0aW9uICgpIHt9XG5cblBlZXIucHJvdG90eXBlLl93cml0ZSA9IGZ1bmN0aW9uIChjaHVuaywgZW5jb2RpbmcsIGNiKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBpZiAoc2VsZi5kZXN0cm95ZWQpIHJldHVybiBjYihuZXcgRXJyb3IoJ2Nhbm5vdCB3cml0ZSBhZnRlciBwZWVyIGlzIGRlc3Ryb3llZCcpKVxuXG4gIGlmIChzZWxmLmNvbm5lY3RlZCkge1xuICAgIHNlbGYuc2VuZChjaHVuaylcbiAgICBpZiAoc2VsZi5fY2hhbm5lbC5idWZmZXJlZEFtb3VudCA+IHNlbGYuX21heEJ1ZmZlcmVkQW1vdW50KSB7XG4gICAgICBzZWxmLl9kZWJ1Zygnc3RhcnQgYmFja3ByZXNzdXJlOiBidWZmZXJlZEFtb3VudCAlZCcsIHNlbGYuX2NoYW5uZWwuYnVmZmVyZWRBbW91bnQpXG4gICAgICBzZWxmLl9jYiA9IGNiXG4gICAgfSBlbHNlIHtcbiAgICAgIGNiKG51bGwpXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHNlbGYuX2RlYnVnKCd3cml0ZSBiZWZvcmUgY29ubmVjdCcpXG4gICAgc2VsZi5fY2h1bmsgPSBjaHVua1xuICAgIHNlbGYuX2NiID0gY2JcbiAgfVxufVxuXG5QZWVyLnByb3RvdHlwZS5fY3JlYXRlT2ZmZXIgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBpZiAoc2VsZi5kZXN0cm95ZWQpIHJldHVyblxuXG4gIHNlbGYuX3BjLmNyZWF0ZU9mZmVyKGZ1bmN0aW9uIChvZmZlcikge1xuICAgIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG4gICAgc3BlZWRIYWNrKG9mZmVyKVxuICAgIG9mZmVyLnNkcCA9IHNlbGYuc2RwVHJhbnNmb3JtKG9mZmVyLnNkcClcbiAgICBzZWxmLl9wYy5zZXRMb2NhbERlc2NyaXB0aW9uKG9mZmVyLCBub29wLCBzZWxmLl9vbkVycm9yLmJpbmQoc2VsZikpXG4gICAgdmFyIHNlbmRPZmZlciA9IGZ1bmN0aW9uICgpIHtcbiAgICAgIHNlbGYuX2RlYnVnKCdzaWduYWwnKVxuICAgICAgc2VsZi5lbWl0KCdzaWduYWwnLCBzZWxmLl9wYy5sb2NhbERlc2NyaXB0aW9uIHx8IG9mZmVyKVxuICAgIH1cbiAgICBpZiAoc2VsZi50cmlja2xlIHx8IHNlbGYuX2ljZUNvbXBsZXRlKSBzZW5kT2ZmZXIoKVxuICAgIGVsc2Ugc2VsZi5vbmNlKCdfaWNlQ29tcGxldGUnLCBzZW5kT2ZmZXIpIC8vIHdhaXQgZm9yIGNhbmRpZGF0ZXNcbiAgfSwgc2VsZi5fb25FcnJvci5iaW5kKHNlbGYpLCBzZWxmLm9mZmVyQ29uc3RyYWludHMpXG59XG5cblBlZXIucHJvdG90eXBlLl9jcmVhdGVBbnN3ZXIgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBpZiAoc2VsZi5kZXN0cm95ZWQpIHJldHVyblxuXG4gIHNlbGYuX3BjLmNyZWF0ZUFuc3dlcihmdW5jdGlvbiAoYW5zd2VyKSB7XG4gICAgaWYgKHNlbGYuZGVzdHJveWVkKSByZXR1cm5cbiAgICBzcGVlZEhhY2soYW5zd2VyKVxuICAgIGFuc3dlci5zZHAgPSBzZWxmLnNkcFRyYW5zZm9ybShhbnN3ZXIuc2RwKVxuICAgIHNlbGYuX3BjLnNldExvY2FsRGVzY3JpcHRpb24oYW5zd2VyLCBub29wLCBzZWxmLl9vbkVycm9yLmJpbmQoc2VsZikpXG4gICAgdmFyIHNlbmRBbnN3ZXIgPSBmdW5jdGlvbiAoKSB7XG4gICAgICBzZWxmLl9kZWJ1Zygnc2lnbmFsJylcbiAgICAgIHNlbGYuZW1pdCgnc2lnbmFsJywgc2VsZi5fcGMubG9jYWxEZXNjcmlwdGlvbiB8fCBhbnN3ZXIpXG4gICAgfVxuICAgIGlmIChzZWxmLnRyaWNrbGUgfHwgc2VsZi5faWNlQ29tcGxldGUpIHNlbmRBbnN3ZXIoKVxuICAgIGVsc2Ugc2VsZi5vbmNlKCdfaWNlQ29tcGxldGUnLCBzZW5kQW5zd2VyKVxuICB9LCBzZWxmLl9vbkVycm9yLmJpbmQoc2VsZiksIHNlbGYuYW5zd2VyQ29uc3RyYWludHMpXG59XG5cblBlZXIucHJvdG90eXBlLl9vbkljZUNvbm5lY3Rpb25TdGF0ZUNoYW5nZSA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG4gIHZhciBpY2VHYXRoZXJpbmdTdGF0ZSA9IHNlbGYuX3BjLmljZUdhdGhlcmluZ1N0YXRlXG4gIHZhciBpY2VDb25uZWN0aW9uU3RhdGUgPSBzZWxmLl9wYy5pY2VDb25uZWN0aW9uU3RhdGVcbiAgc2VsZi5fZGVidWcoJ2ljZUNvbm5lY3Rpb25TdGF0ZUNoYW5nZSAlcyAlcycsIGljZUdhdGhlcmluZ1N0YXRlLCBpY2VDb25uZWN0aW9uU3RhdGUpXG4gIHNlbGYuZW1pdCgnaWNlQ29ubmVjdGlvblN0YXRlQ2hhbmdlJywgaWNlR2F0aGVyaW5nU3RhdGUsIGljZUNvbm5lY3Rpb25TdGF0ZSlcbiAgaWYgKGljZUNvbm5lY3Rpb25TdGF0ZSA9PT0gJ2Nvbm5lY3RlZCcgfHwgaWNlQ29ubmVjdGlvblN0YXRlID09PSAnY29tcGxldGVkJykge1xuICAgIGNsZWFyVGltZW91dChzZWxmLl9yZWNvbm5lY3RUaW1lb3V0KVxuICAgIHNlbGYuX3BjUmVhZHkgPSB0cnVlXG4gICAgc2VsZi5fbWF5YmVSZWFkeSgpXG4gIH1cbiAgaWYgKGljZUNvbm5lY3Rpb25TdGF0ZSA9PT0gJ2Rpc2Nvbm5lY3RlZCcpIHtcbiAgICBpZiAoc2VsZi5yZWNvbm5lY3RUaW1lcikge1xuICAgICAgLy8gSWYgdXNlciBoYXMgc2V0IGBvcHQucmVjb25uZWN0VGltZXJgLCBhbGxvdyB0aW1lIGZvciBJQ0UgdG8gYXR0ZW1wdCBhIHJlY29ubmVjdFxuICAgICAgY2xlYXJUaW1lb3V0KHNlbGYuX3JlY29ubmVjdFRpbWVvdXQpXG4gICAgICBzZWxmLl9yZWNvbm5lY3RUaW1lb3V0ID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgIHNlbGYuX2Rlc3Ryb3koKVxuICAgICAgfSwgc2VsZi5yZWNvbm5lY3RUaW1lcilcbiAgICB9IGVsc2Uge1xuICAgICAgc2VsZi5fZGVzdHJveSgpXG4gICAgfVxuICB9XG4gIGlmIChpY2VDb25uZWN0aW9uU3RhdGUgPT09ICdjbG9zZWQnKSB7XG4gICAgc2VsZi5fZGVzdHJveSgpXG4gIH1cbn1cblxuUGVlci5wcm90b3R5cGUuX21heWJlUmVhZHkgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBzZWxmLl9kZWJ1ZygnbWF5YmVSZWFkeSBwYyAlcyBjaGFubmVsICVzJywgc2VsZi5fcGNSZWFkeSwgc2VsZi5fY2hhbm5lbFJlYWR5KVxuICBpZiAoc2VsZi5jb25uZWN0ZWQgfHwgc2VsZi5fY29ubmVjdGluZyB8fCAhc2VsZi5fcGNSZWFkeSB8fCAhc2VsZi5fY2hhbm5lbFJlYWR5KSByZXR1cm5cbiAgc2VsZi5fY29ubmVjdGluZyA9IHRydWVcblxuICBpZiAodHlwZW9mIHdpbmRvdyAhPT0gJ3VuZGVmaW5lZCcgJiYgISF3aW5kb3cubW96UlRDUGVlckNvbm5lY3Rpb24pIHtcbiAgICBzZWxmLl9wYy5nZXRTdGF0cyhudWxsLCBmdW5jdGlvbiAocmVzKSB7XG4gICAgICB2YXIgaXRlbXMgPSBbXVxuICAgICAgcmVzLmZvckVhY2goZnVuY3Rpb24gKGl0ZW0pIHtcbiAgICAgICAgaXRlbXMucHVzaChpdGVtKVxuICAgICAgfSlcbiAgICAgIG9uU3RhdHMoaXRlbXMpXG4gICAgfSwgc2VsZi5fb25FcnJvci5iaW5kKHNlbGYpKVxuICB9IGVsc2Uge1xuICAgIHNlbGYuX3BjLmdldFN0YXRzKGZ1bmN0aW9uIChyZXMpIHtcbiAgICAgIHZhciBpdGVtcyA9IFtdXG4gICAgICByZXMucmVzdWx0KCkuZm9yRWFjaChmdW5jdGlvbiAocmVzdWx0KSB7XG4gICAgICAgIHZhciBpdGVtID0ge31cbiAgICAgICAgcmVzdWx0Lm5hbWVzKCkuZm9yRWFjaChmdW5jdGlvbiAobmFtZSkge1xuICAgICAgICAgIGl0ZW1bbmFtZV0gPSByZXN1bHQuc3RhdChuYW1lKVxuICAgICAgICB9KVxuICAgICAgICBpdGVtLmlkID0gcmVzdWx0LmlkXG4gICAgICAgIGl0ZW0udHlwZSA9IHJlc3VsdC50eXBlXG4gICAgICAgIGl0ZW0udGltZXN0YW1wID0gcmVzdWx0LnRpbWVzdGFtcFxuICAgICAgICBpdGVtcy5wdXNoKGl0ZW0pXG4gICAgICB9KVxuICAgICAgb25TdGF0cyhpdGVtcylcbiAgICB9KVxuICB9XG5cbiAgZnVuY3Rpb24gb25TdGF0cyAoaXRlbXMpIHtcbiAgICBpdGVtcy5mb3JFYWNoKGZ1bmN0aW9uIChpdGVtKSB7XG4gICAgICBpZiAoaXRlbS50eXBlID09PSAncmVtb3RlY2FuZGlkYXRlJykge1xuICAgICAgICBzZWxmLnJlbW90ZUFkZHJlc3MgPSBpdGVtLmlwQWRkcmVzc1xuICAgICAgICBzZWxmLnJlbW90ZUZhbWlseSA9ICdJUHY0J1xuICAgICAgICBzZWxmLnJlbW90ZVBvcnQgPSBOdW1iZXIoaXRlbS5wb3J0TnVtYmVyKVxuICAgICAgICBzZWxmLl9kZWJ1ZyhcbiAgICAgICAgICAnY29ubmVjdCByZW1vdGU6ICVzOiVzICglcyknLFxuICAgICAgICAgIHNlbGYucmVtb3RlQWRkcmVzcywgc2VsZi5yZW1vdGVQb3J0LCBzZWxmLnJlbW90ZUZhbWlseVxuICAgICAgICApXG4gICAgICB9IGVsc2UgaWYgKGl0ZW0udHlwZSA9PT0gJ2xvY2FsY2FuZGlkYXRlJyAmJiBpdGVtLmNhbmRpZGF0ZVR5cGUgPT09ICdob3N0Jykge1xuICAgICAgICBzZWxmLmxvY2FsQWRkcmVzcyA9IGl0ZW0uaXBBZGRyZXNzXG4gICAgICAgIHNlbGYubG9jYWxQb3J0ID0gTnVtYmVyKGl0ZW0ucG9ydE51bWJlcilcbiAgICAgICAgc2VsZi5fZGVidWcoJ2Nvbm5lY3QgbG9jYWw6ICVzOiVzJywgc2VsZi5sb2NhbEFkZHJlc3MsIHNlbGYubG9jYWxQb3J0KVxuICAgICAgfVxuICAgIH0pXG5cbiAgICBzZWxmLl9jb25uZWN0aW5nID0gZmFsc2VcbiAgICBzZWxmLmNvbm5lY3RlZCA9IHRydWVcblxuICAgIGlmIChzZWxmLl9jaHVuaykge1xuICAgICAgc2VsZi5zZW5kKHNlbGYuX2NodW5rKVxuICAgICAgc2VsZi5fY2h1bmsgPSBudWxsXG4gICAgICBzZWxmLl9kZWJ1Zygnc2VudCBjaHVuayBmcm9tIFwid3JpdGUgYmVmb3JlIGNvbm5lY3RcIicpXG5cbiAgICAgIHZhciBjYiA9IHNlbGYuX2NiXG4gICAgICBzZWxmLl9jYiA9IG51bGxcbiAgICAgIGNiKG51bGwpXG4gICAgfVxuXG4gICAgc2VsZi5faW50ZXJ2YWwgPSBzZXRJbnRlcnZhbChmdW5jdGlvbiAoKSB7XG4gICAgICBpZiAoIXNlbGYuX2NiIHx8ICFzZWxmLl9jaGFubmVsIHx8IHNlbGYuX2NoYW5uZWwuYnVmZmVyZWRBbW91bnQgPiBzZWxmLl9tYXhCdWZmZXJlZEFtb3VudCkgcmV0dXJuXG4gICAgICBzZWxmLl9kZWJ1ZygnZW5kaW5nIGJhY2twcmVzc3VyZTogYnVmZmVyZWRBbW91bnQgJWQnLCBzZWxmLl9jaGFubmVsLmJ1ZmZlcmVkQW1vdW50KVxuICAgICAgdmFyIGNiID0gc2VsZi5fY2JcbiAgICAgIHNlbGYuX2NiID0gbnVsbFxuICAgICAgY2IobnVsbClcbiAgICB9LCAxNTApXG4gICAgaWYgKHNlbGYuX2ludGVydmFsLnVucmVmKSBzZWxmLl9pbnRlcnZhbC51bnJlZigpXG5cbiAgICBzZWxmLl9kZWJ1ZygnY29ubmVjdCcpXG4gICAgc2VsZi5lbWl0KCdjb25uZWN0JylcbiAgfVxufVxuXG5QZWVyLnByb3RvdHlwZS5fb25TaWduYWxpbmdTdGF0ZUNoYW5nZSA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG4gIHNlbGYuX2RlYnVnKCdzaWduYWxpbmdTdGF0ZUNoYW5nZSAlcycsIHNlbGYuX3BjLnNpZ25hbGluZ1N0YXRlKVxuICBzZWxmLmVtaXQoJ3NpZ25hbGluZ1N0YXRlQ2hhbmdlJywgc2VsZi5fcGMuc2lnbmFsaW5nU3RhdGUpXG59XG5cblBlZXIucHJvdG90eXBlLl9vbkljZUNhbmRpZGF0ZSA9IGZ1bmN0aW9uIChldmVudCkge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgaWYgKHNlbGYuZGVzdHJveWVkKSByZXR1cm5cbiAgaWYgKGV2ZW50LmNhbmRpZGF0ZSAmJiBzZWxmLnRyaWNrbGUpIHtcbiAgICBzZWxmLmVtaXQoJ3NpZ25hbCcsIHsgY2FuZGlkYXRlOiBldmVudC5jYW5kaWRhdGUgfSlcbiAgfSBlbHNlIGlmICghZXZlbnQuY2FuZGlkYXRlKSB7XG4gICAgc2VsZi5faWNlQ29tcGxldGUgPSB0cnVlXG4gICAgc2VsZi5lbWl0KCdfaWNlQ29tcGxldGUnKVxuICB9XG59XG5cblBlZXIucHJvdG90eXBlLl9vbkNoYW5uZWxNZXNzYWdlID0gZnVuY3Rpb24gKGV2ZW50KSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBpZiAoc2VsZi5kZXN0cm95ZWQpIHJldHVyblxuICB2YXIgZGF0YSA9IGV2ZW50LmRhdGFcbiAgc2VsZi5fZGVidWcoJ3JlYWQ6ICVkIGJ5dGVzJywgZGF0YS5ieXRlTGVuZ3RoIHx8IGRhdGEubGVuZ3RoKVxuXG4gIGlmIChkYXRhIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpIHtcbiAgICBkYXRhID0gdG9CdWZmZXIobmV3IFVpbnQ4QXJyYXkoZGF0YSkpXG4gICAgc2VsZi5wdXNoKGRhdGEpXG4gIH0gZWxzZSB7XG4gICAgdHJ5IHtcbiAgICAgIGRhdGEgPSBKU09OLnBhcnNlKGRhdGEpXG4gICAgfSBjYXRjaCAoZXJyKSB7fVxuICAgIHNlbGYuZW1pdCgnZGF0YScsIGRhdGEpXG4gIH1cbn1cblxuUGVlci5wcm90b3R5cGUuX29uQ2hhbm5lbE9wZW4gPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBpZiAoc2VsZi5jb25uZWN0ZWQgfHwgc2VsZi5kZXN0cm95ZWQpIHJldHVyblxuICBzZWxmLl9kZWJ1Zygnb24gY2hhbm5lbCBvcGVuJylcbiAgc2VsZi5fY2hhbm5lbFJlYWR5ID0gdHJ1ZVxuICBzZWxmLl9tYXliZVJlYWR5KClcbn1cblxuUGVlci5wcm90b3R5cGUuX29uQ2hhbm5lbENsb3NlID0gZnVuY3Rpb24gKCkge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgaWYgKHNlbGYuZGVzdHJveWVkKSByZXR1cm5cbiAgc2VsZi5fZGVidWcoJ29uIGNoYW5uZWwgY2xvc2UnKVxuICBzZWxmLl9kZXN0cm95KClcbn1cblxuUGVlci5wcm90b3R5cGUuX29uQWRkU3RyZWFtID0gZnVuY3Rpb24gKGV2ZW50KSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBpZiAoc2VsZi5kZXN0cm95ZWQpIHJldHVyblxuICBzZWxmLl9kZWJ1Zygnb24gYWRkIHN0cmVhbScpXG4gIHNlbGYuZW1pdCgnc3RyZWFtJywgZXZlbnQuc3RyZWFtKVxufVxuXG5QZWVyLnByb3RvdHlwZS5fb25FcnJvciA9IGZ1bmN0aW9uIChlcnIpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG4gIHNlbGYuX2RlYnVnKCdlcnJvciAlcycsIGVyci5tZXNzYWdlIHx8IGVycilcbiAgc2VsZi5fZGVzdHJveShlcnIpXG59XG5cblBlZXIucHJvdG90eXBlLl9kZWJ1ZyA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpXG4gIHZhciBpZCA9IHNlbGYuY2hhbm5lbE5hbWUgJiYgc2VsZi5jaGFubmVsTmFtZS5zdWJzdHJpbmcoMCwgNylcbiAgYXJnc1swXSA9ICdbJyArIGlkICsgJ10gJyArIGFyZ3NbMF1cbiAgZGVidWcuYXBwbHkobnVsbCwgYXJncylcbn1cblxuZnVuY3Rpb24gZ2V0QnJvd3NlclJUQyAoKSB7XG4gIGlmICh0eXBlb2Ygd2luZG93ID09PSAndW5kZWZpbmVkJykgcmV0dXJuIG51bGxcbiAgdmFyIHdydGMgPSB7XG4gICAgUlRDUGVlckNvbm5lY3Rpb246IHdpbmRvdy5tb3pSVENQZWVyQ29ubmVjdGlvbiB8fCB3aW5kb3cuUlRDUGVlckNvbm5lY3Rpb24gfHxcbiAgICAgIHdpbmRvdy53ZWJraXRSVENQZWVyQ29ubmVjdGlvbixcbiAgICBSVENTZXNzaW9uRGVzY3JpcHRpb246IHdpbmRvdy5tb3pSVENTZXNzaW9uRGVzY3JpcHRpb24gfHxcbiAgICAgIHdpbmRvdy5SVENTZXNzaW9uRGVzY3JpcHRpb24gfHwgd2luZG93LndlYmtpdFJUQ1Nlc3Npb25EZXNjcmlwdGlvbixcbiAgICBSVENJY2VDYW5kaWRhdGU6IHdpbmRvdy5tb3pSVENJY2VDYW5kaWRhdGUgfHwgd2luZG93LlJUQ0ljZUNhbmRpZGF0ZSB8fFxuICAgICAgd2luZG93LndlYmtpdFJUQ0ljZUNhbmRpZGF0ZVxuICB9XG4gIGlmICghd3J0Yy5SVENQZWVyQ29ubmVjdGlvbikgcmV0dXJuIG51bGxcbiAgcmV0dXJuIHdydGNcbn1cblxuZnVuY3Rpb24gc3BlZWRIYWNrIChvYmopIHtcbiAgdmFyIHMgPSBvYmouc2RwLnNwbGl0KCdiPUFTOjMwJylcbiAgaWYgKHMubGVuZ3RoID4gMSkgb2JqLnNkcCA9IHNbMF0gKyAnYj1BUzoxNjM4NDAwJyArIHNbMV1cbn1cblxuZnVuY3Rpb24gbm9vcCAoKSB7fVxuIiwiXG4vKipcbiAqIFRoaXMgaXMgdGhlIHdlYiBicm93c2VyIGltcGxlbWVudGF0aW9uIG9mIGBkZWJ1ZygpYC5cbiAqXG4gKiBFeHBvc2UgYGRlYnVnKClgIGFzIHRoZSBtb2R1bGUuXG4gKi9cblxuZXhwb3J0cyA9IG1vZHVsZS5leHBvcnRzID0gcmVxdWlyZSgnLi9kZWJ1ZycpO1xuZXhwb3J0cy5sb2cgPSBsb2c7XG5leHBvcnRzLmZvcm1hdEFyZ3MgPSBmb3JtYXRBcmdzO1xuZXhwb3J0cy5zYXZlID0gc2F2ZTtcbmV4cG9ydHMubG9hZCA9IGxvYWQ7XG5leHBvcnRzLnVzZUNvbG9ycyA9IHVzZUNvbG9ycztcbmV4cG9ydHMuc3RvcmFnZSA9ICd1bmRlZmluZWQnICE9IHR5cGVvZiBjaHJvbWVcbiAgICAgICAgICAgICAgICYmICd1bmRlZmluZWQnICE9IHR5cGVvZiBjaHJvbWUuc3RvcmFnZVxuICAgICAgICAgICAgICAgICAgPyBjaHJvbWUuc3RvcmFnZS5sb2NhbFxuICAgICAgICAgICAgICAgICAgOiBsb2NhbHN0b3JhZ2UoKTtcblxuLyoqXG4gKiBDb2xvcnMuXG4gKi9cblxuZXhwb3J0cy5jb2xvcnMgPSBbXG4gICdsaWdodHNlYWdyZWVuJyxcbiAgJ2ZvcmVzdGdyZWVuJyxcbiAgJ2dvbGRlbnJvZCcsXG4gICdkb2RnZXJibHVlJyxcbiAgJ2RhcmtvcmNoaWQnLFxuICAnY3JpbXNvbidcbl07XG5cbi8qKlxuICogQ3VycmVudGx5IG9ubHkgV2ViS2l0LWJhc2VkIFdlYiBJbnNwZWN0b3JzLCBGaXJlZm94ID49IHYzMSxcbiAqIGFuZCB0aGUgRmlyZWJ1ZyBleHRlbnNpb24gKGFueSBGaXJlZm94IHZlcnNpb24pIGFyZSBrbm93blxuICogdG8gc3VwcG9ydCBcIiVjXCIgQ1NTIGN1c3RvbWl6YXRpb25zLlxuICpcbiAqIFRPRE86IGFkZCBhIGBsb2NhbFN0b3JhZ2VgIHZhcmlhYmxlIHRvIGV4cGxpY2l0bHkgZW5hYmxlL2Rpc2FibGUgY29sb3JzXG4gKi9cblxuZnVuY3Rpb24gdXNlQ29sb3JzKCkge1xuICAvLyBpcyB3ZWJraXQ/IGh0dHA6Ly9zdGFja292ZXJmbG93LmNvbS9hLzE2NDU5NjA2LzM3Njc3M1xuICByZXR1cm4gKCdXZWJraXRBcHBlYXJhbmNlJyBpbiBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuc3R5bGUpIHx8XG4gICAgLy8gaXMgZmlyZWJ1Zz8gaHR0cDovL3N0YWNrb3ZlcmZsb3cuY29tL2EvMzk4MTIwLzM3Njc3M1xuICAgICh3aW5kb3cuY29uc29sZSAmJiAoY29uc29sZS5maXJlYnVnIHx8IChjb25zb2xlLmV4Y2VwdGlvbiAmJiBjb25zb2xlLnRhYmxlKSkpIHx8XG4gICAgLy8gaXMgZmlyZWZveCA+PSB2MzE/XG4gICAgLy8gaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9Ub29scy9XZWJfQ29uc29sZSNTdHlsaW5nX21lc3NhZ2VzXG4gICAgKG5hdmlnYXRvci51c2VyQWdlbnQudG9Mb3dlckNhc2UoKS5tYXRjaCgvZmlyZWZveFxcLyhcXGQrKS8pICYmIHBhcnNlSW50KFJlZ0V4cC4kMSwgMTApID49IDMxKTtcbn1cblxuLyoqXG4gKiBNYXAgJWogdG8gYEpTT04uc3RyaW5naWZ5KClgLCBzaW5jZSBubyBXZWIgSW5zcGVjdG9ycyBkbyB0aGF0IGJ5IGRlZmF1bHQuXG4gKi9cblxuZXhwb3J0cy5mb3JtYXR0ZXJzLmogPSBmdW5jdGlvbih2KSB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh2KTtcbn07XG5cblxuLyoqXG4gKiBDb2xvcml6ZSBsb2cgYXJndW1lbnRzIGlmIGVuYWJsZWQuXG4gKlxuICogQGFwaSBwdWJsaWNcbiAqL1xuXG5mdW5jdGlvbiBmb3JtYXRBcmdzKCkge1xuICB2YXIgYXJncyA9IGFyZ3VtZW50cztcbiAgdmFyIHVzZUNvbG9ycyA9IHRoaXMudXNlQ29sb3JzO1xuXG4gIGFyZ3NbMF0gPSAodXNlQ29sb3JzID8gJyVjJyA6ICcnKVxuICAgICsgdGhpcy5uYW1lc3BhY2VcbiAgICArICh1c2VDb2xvcnMgPyAnICVjJyA6ICcgJylcbiAgICArIGFyZ3NbMF1cbiAgICArICh1c2VDb2xvcnMgPyAnJWMgJyA6ICcgJylcbiAgICArICcrJyArIGV4cG9ydHMuaHVtYW5pemUodGhpcy5kaWZmKTtcblxuICBpZiAoIXVzZUNvbG9ycykgcmV0dXJuIGFyZ3M7XG5cbiAgdmFyIGMgPSAnY29sb3I6ICcgKyB0aGlzLmNvbG9yO1xuICBhcmdzID0gW2FyZ3NbMF0sIGMsICdjb2xvcjogaW5oZXJpdCddLmNvbmNhdChBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmdzLCAxKSk7XG5cbiAgLy8gdGhlIGZpbmFsIFwiJWNcIiBpcyBzb21ld2hhdCB0cmlja3ksIGJlY2F1c2UgdGhlcmUgY291bGQgYmUgb3RoZXJcbiAgLy8gYXJndW1lbnRzIHBhc3NlZCBlaXRoZXIgYmVmb3JlIG9yIGFmdGVyIHRoZSAlYywgc28gd2UgbmVlZCB0b1xuICAvLyBmaWd1cmUgb3V0IHRoZSBjb3JyZWN0IGluZGV4IHRvIGluc2VydCB0aGUgQ1NTIGludG9cbiAgdmFyIGluZGV4ID0gMDtcbiAgdmFyIGxhc3RDID0gMDtcbiAgYXJnc1swXS5yZXBsYWNlKC8lW2EteiVdL2csIGZ1bmN0aW9uKG1hdGNoKSB7XG4gICAgaWYgKCclJScgPT09IG1hdGNoKSByZXR1cm47XG4gICAgaW5kZXgrKztcbiAgICBpZiAoJyVjJyA9PT0gbWF0Y2gpIHtcbiAgICAgIC8vIHdlIG9ubHkgYXJlIGludGVyZXN0ZWQgaW4gdGhlICpsYXN0KiAlY1xuICAgICAgLy8gKHRoZSB1c2VyIG1heSBoYXZlIHByb3ZpZGVkIHRoZWlyIG93bilcbiAgICAgIGxhc3RDID0gaW5kZXg7XG4gICAgfVxuICB9KTtcblxuICBhcmdzLnNwbGljZShsYXN0QywgMCwgYyk7XG4gIHJldHVybiBhcmdzO1xufVxuXG4vKipcbiAqIEludm9rZXMgYGNvbnNvbGUubG9nKClgIHdoZW4gYXZhaWxhYmxlLlxuICogTm8tb3Agd2hlbiBgY29uc29sZS5sb2dgIGlzIG5vdCBhIFwiZnVuY3Rpb25cIi5cbiAqXG4gKiBAYXBpIHB1YmxpY1xuICovXG5cbmZ1bmN0aW9uIGxvZygpIHtcbiAgLy8gdGhpcyBoYWNrZXJ5IGlzIHJlcXVpcmVkIGZvciBJRTgvOSwgd2hlcmVcbiAgLy8gdGhlIGBjb25zb2xlLmxvZ2AgZnVuY3Rpb24gZG9lc24ndCBoYXZlICdhcHBseSdcbiAgcmV0dXJuICdvYmplY3QnID09PSB0eXBlb2YgY29uc29sZVxuICAgICYmIGNvbnNvbGUubG9nXG4gICAgJiYgRnVuY3Rpb24ucHJvdG90eXBlLmFwcGx5LmNhbGwoY29uc29sZS5sb2csIGNvbnNvbGUsIGFyZ3VtZW50cyk7XG59XG5cbi8qKlxuICogU2F2ZSBgbmFtZXNwYWNlc2AuXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IG5hbWVzcGFjZXNcbiAqIEBhcGkgcHJpdmF0ZVxuICovXG5cbmZ1bmN0aW9uIHNhdmUobmFtZXNwYWNlcykge1xuICB0cnkge1xuICAgIGlmIChudWxsID09IG5hbWVzcGFjZXMpIHtcbiAgICAgIGV4cG9ydHMuc3RvcmFnZS5yZW1vdmVJdGVtKCdkZWJ1ZycpO1xuICAgIH0gZWxzZSB7XG4gICAgICBleHBvcnRzLnN0b3JhZ2UuZGVidWcgPSBuYW1lc3BhY2VzO1xuICAgIH1cbiAgfSBjYXRjaChlKSB7fVxufVxuXG4vKipcbiAqIExvYWQgYG5hbWVzcGFjZXNgLlxuICpcbiAqIEByZXR1cm4ge1N0cmluZ30gcmV0dXJucyB0aGUgcHJldmlvdXNseSBwZXJzaXN0ZWQgZGVidWcgbW9kZXNcbiAqIEBhcGkgcHJpdmF0ZVxuICovXG5cbmZ1bmN0aW9uIGxvYWQoKSB7XG4gIHZhciByO1xuICB0cnkge1xuICAgIHIgPSBleHBvcnRzLnN0b3JhZ2UuZGVidWc7XG4gIH0gY2F0Y2goZSkge31cbiAgcmV0dXJuIHI7XG59XG5cbi8qKlxuICogRW5hYmxlIG5hbWVzcGFjZXMgbGlzdGVkIGluIGBsb2NhbFN0b3JhZ2UuZGVidWdgIGluaXRpYWxseS5cbiAqL1xuXG5leHBvcnRzLmVuYWJsZShsb2FkKCkpO1xuXG4vKipcbiAqIExvY2Fsc3RvcmFnZSBhdHRlbXB0cyB0byByZXR1cm4gdGhlIGxvY2Fsc3RvcmFnZS5cbiAqXG4gKiBUaGlzIGlzIG5lY2Vzc2FyeSBiZWNhdXNlIHNhZmFyaSB0aHJvd3NcbiAqIHdoZW4gYSB1c2VyIGRpc2FibGVzIGNvb2tpZXMvbG9jYWxzdG9yYWdlXG4gKiBhbmQgeW91IGF0dGVtcHQgdG8gYWNjZXNzIGl0LlxuICpcbiAqIEByZXR1cm4ge0xvY2FsU3RvcmFnZX1cbiAqIEBhcGkgcHJpdmF0ZVxuICovXG5cbmZ1bmN0aW9uIGxvY2Fsc3RvcmFnZSgpe1xuICB0cnkge1xuICAgIHJldHVybiB3aW5kb3cubG9jYWxTdG9yYWdlO1xuICB9IGNhdGNoIChlKSB7fVxufVxuIiwiXG4vKipcbiAqIFRoaXMgaXMgdGhlIGNvbW1vbiBsb2dpYyBmb3IgYm90aCB0aGUgTm9kZS5qcyBhbmQgd2ViIGJyb3dzZXJcbiAqIGltcGxlbWVudGF0aW9ucyBvZiBgZGVidWcoKWAuXG4gKlxuICogRXhwb3NlIGBkZWJ1ZygpYCBhcyB0aGUgbW9kdWxlLlxuICovXG5cbmV4cG9ydHMgPSBtb2R1bGUuZXhwb3J0cyA9IGRlYnVnO1xuZXhwb3J0cy5jb2VyY2UgPSBjb2VyY2U7XG5leHBvcnRzLmRpc2FibGUgPSBkaXNhYmxlO1xuZXhwb3J0cy5lbmFibGUgPSBlbmFibGU7XG5leHBvcnRzLmVuYWJsZWQgPSBlbmFibGVkO1xuZXhwb3J0cy5odW1hbml6ZSA9IHJlcXVpcmUoJ21zJyk7XG5cbi8qKlxuICogVGhlIGN1cnJlbnRseSBhY3RpdmUgZGVidWcgbW9kZSBuYW1lcywgYW5kIG5hbWVzIHRvIHNraXAuXG4gKi9cblxuZXhwb3J0cy5uYW1lcyA9IFtdO1xuZXhwb3J0cy5za2lwcyA9IFtdO1xuXG4vKipcbiAqIE1hcCBvZiBzcGVjaWFsIFwiJW5cIiBoYW5kbGluZyBmdW5jdGlvbnMsIGZvciB0aGUgZGVidWcgXCJmb3JtYXRcIiBhcmd1bWVudC5cbiAqXG4gKiBWYWxpZCBrZXkgbmFtZXMgYXJlIGEgc2luZ2xlLCBsb3dlcmNhc2VkIGxldHRlciwgaS5lLiBcIm5cIi5cbiAqL1xuXG5leHBvcnRzLmZvcm1hdHRlcnMgPSB7fTtcblxuLyoqXG4gKiBQcmV2aW91c2x5IGFzc2lnbmVkIGNvbG9yLlxuICovXG5cbnZhciBwcmV2Q29sb3IgPSAwO1xuXG4vKipcbiAqIFByZXZpb3VzIGxvZyB0aW1lc3RhbXAuXG4gKi9cblxudmFyIHByZXZUaW1lO1xuXG4vKipcbiAqIFNlbGVjdCBhIGNvbG9yLlxuICpcbiAqIEByZXR1cm4ge051bWJlcn1cbiAqIEBhcGkgcHJpdmF0ZVxuICovXG5cbmZ1bmN0aW9uIHNlbGVjdENvbG9yKCkge1xuICByZXR1cm4gZXhwb3J0cy5jb2xvcnNbcHJldkNvbG9yKysgJSBleHBvcnRzLmNvbG9ycy5sZW5ndGhdO1xufVxuXG4vKipcbiAqIENyZWF0ZSBhIGRlYnVnZ2VyIHdpdGggdGhlIGdpdmVuIGBuYW1lc3BhY2VgLlxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSBuYW1lc3BhY2VcbiAqIEByZXR1cm4ge0Z1bmN0aW9ufVxuICogQGFwaSBwdWJsaWNcbiAqL1xuXG5mdW5jdGlvbiBkZWJ1ZyhuYW1lc3BhY2UpIHtcblxuICAvLyBkZWZpbmUgdGhlIGBkaXNhYmxlZGAgdmVyc2lvblxuICBmdW5jdGlvbiBkaXNhYmxlZCgpIHtcbiAgfVxuICBkaXNhYmxlZC5lbmFibGVkID0gZmFsc2U7XG5cbiAgLy8gZGVmaW5lIHRoZSBgZW5hYmxlZGAgdmVyc2lvblxuICBmdW5jdGlvbiBlbmFibGVkKCkge1xuXG4gICAgdmFyIHNlbGYgPSBlbmFibGVkO1xuXG4gICAgLy8gc2V0IGBkaWZmYCB0aW1lc3RhbXBcbiAgICB2YXIgY3VyciA9ICtuZXcgRGF0ZSgpO1xuICAgIHZhciBtcyA9IGN1cnIgLSAocHJldlRpbWUgfHwgY3Vycik7XG4gICAgc2VsZi5kaWZmID0gbXM7XG4gICAgc2VsZi5wcmV2ID0gcHJldlRpbWU7XG4gICAgc2VsZi5jdXJyID0gY3VycjtcbiAgICBwcmV2VGltZSA9IGN1cnI7XG5cbiAgICAvLyBhZGQgdGhlIGBjb2xvcmAgaWYgbm90IHNldFxuICAgIGlmIChudWxsID09IHNlbGYudXNlQ29sb3JzKSBzZWxmLnVzZUNvbG9ycyA9IGV4cG9ydHMudXNlQ29sb3JzKCk7XG4gICAgaWYgKG51bGwgPT0gc2VsZi5jb2xvciAmJiBzZWxmLnVzZUNvbG9ycykgc2VsZi5jb2xvciA9IHNlbGVjdENvbG9yKCk7XG5cbiAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG5cbiAgICBhcmdzWzBdID0gZXhwb3J0cy5jb2VyY2UoYXJnc1swXSk7XG5cbiAgICBpZiAoJ3N0cmluZycgIT09IHR5cGVvZiBhcmdzWzBdKSB7XG4gICAgICAvLyBhbnl0aGluZyBlbHNlIGxldCdzIGluc3BlY3Qgd2l0aCAlb1xuICAgICAgYXJncyA9IFsnJW8nXS5jb25jYXQoYXJncyk7XG4gICAgfVxuXG4gICAgLy8gYXBwbHkgYW55IGBmb3JtYXR0ZXJzYCB0cmFuc2Zvcm1hdGlvbnNcbiAgICB2YXIgaW5kZXggPSAwO1xuICAgIGFyZ3NbMF0gPSBhcmdzWzBdLnJlcGxhY2UoLyUoW2EteiVdKS9nLCBmdW5jdGlvbihtYXRjaCwgZm9ybWF0KSB7XG4gICAgICAvLyBpZiB3ZSBlbmNvdW50ZXIgYW4gZXNjYXBlZCAlIHRoZW4gZG9uJ3QgaW5jcmVhc2UgdGhlIGFycmF5IGluZGV4XG4gICAgICBpZiAobWF0Y2ggPT09ICclJScpIHJldHVybiBtYXRjaDtcbiAgICAgIGluZGV4Kys7XG4gICAgICB2YXIgZm9ybWF0dGVyID0gZXhwb3J0cy5mb3JtYXR0ZXJzW2Zvcm1hdF07XG4gICAgICBpZiAoJ2Z1bmN0aW9uJyA9PT0gdHlwZW9mIGZvcm1hdHRlcikge1xuICAgICAgICB2YXIgdmFsID0gYXJnc1tpbmRleF07XG4gICAgICAgIG1hdGNoID0gZm9ybWF0dGVyLmNhbGwoc2VsZiwgdmFsKTtcblxuICAgICAgICAvLyBub3cgd2UgbmVlZCB0byByZW1vdmUgYGFyZ3NbaW5kZXhdYCBzaW5jZSBpdCdzIGlubGluZWQgaW4gdGhlIGBmb3JtYXRgXG4gICAgICAgIGFyZ3Muc3BsaWNlKGluZGV4LCAxKTtcbiAgICAgICAgaW5kZXgtLTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBtYXRjaDtcbiAgICB9KTtcblxuICAgIGlmICgnZnVuY3Rpb24nID09PSB0eXBlb2YgZXhwb3J0cy5mb3JtYXRBcmdzKSB7XG4gICAgICBhcmdzID0gZXhwb3J0cy5mb3JtYXRBcmdzLmFwcGx5KHNlbGYsIGFyZ3MpO1xuICAgIH1cbiAgICB2YXIgbG9nRm4gPSBlbmFibGVkLmxvZyB8fCBleHBvcnRzLmxvZyB8fCBjb25zb2xlLmxvZy5iaW5kKGNvbnNvbGUpO1xuICAgIGxvZ0ZuLmFwcGx5KHNlbGYsIGFyZ3MpO1xuICB9XG4gIGVuYWJsZWQuZW5hYmxlZCA9IHRydWU7XG5cbiAgdmFyIGZuID0gZXhwb3J0cy5lbmFibGVkKG5hbWVzcGFjZSkgPyBlbmFibGVkIDogZGlzYWJsZWQ7XG5cbiAgZm4ubmFtZXNwYWNlID0gbmFtZXNwYWNlO1xuXG4gIHJldHVybiBmbjtcbn1cblxuLyoqXG4gKiBFbmFibGVzIGEgZGVidWcgbW9kZSBieSBuYW1lc3BhY2VzLiBUaGlzIGNhbiBpbmNsdWRlIG1vZGVzXG4gKiBzZXBhcmF0ZWQgYnkgYSBjb2xvbiBhbmQgd2lsZGNhcmRzLlxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSBuYW1lc3BhY2VzXG4gKiBAYXBpIHB1YmxpY1xuICovXG5cbmZ1bmN0aW9uIGVuYWJsZShuYW1lc3BhY2VzKSB7XG4gIGV4cG9ydHMuc2F2ZShuYW1lc3BhY2VzKTtcblxuICB2YXIgc3BsaXQgPSAobmFtZXNwYWNlcyB8fCAnJykuc3BsaXQoL1tcXHMsXSsvKTtcbiAgdmFyIGxlbiA9IHNwbGl0Lmxlbmd0aDtcblxuICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgaWYgKCFzcGxpdFtpXSkgY29udGludWU7IC8vIGlnbm9yZSBlbXB0eSBzdHJpbmdzXG4gICAgbmFtZXNwYWNlcyA9IHNwbGl0W2ldLnJlcGxhY2UoL1xcKi9nLCAnLio/Jyk7XG4gICAgaWYgKG5hbWVzcGFjZXNbMF0gPT09ICctJykge1xuICAgICAgZXhwb3J0cy5za2lwcy5wdXNoKG5ldyBSZWdFeHAoJ14nICsgbmFtZXNwYWNlcy5zdWJzdHIoMSkgKyAnJCcpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgZXhwb3J0cy5uYW1lcy5wdXNoKG5ldyBSZWdFeHAoJ14nICsgbmFtZXNwYWNlcyArICckJykpO1xuICAgIH1cbiAgfVxufVxuXG4vKipcbiAqIERpc2FibGUgZGVidWcgb3V0cHV0LlxuICpcbiAqIEBhcGkgcHVibGljXG4gKi9cblxuZnVuY3Rpb24gZGlzYWJsZSgpIHtcbiAgZXhwb3J0cy5lbmFibGUoJycpO1xufVxuXG4vKipcbiAqIFJldHVybnMgdHJ1ZSBpZiB0aGUgZ2l2ZW4gbW9kZSBuYW1lIGlzIGVuYWJsZWQsIGZhbHNlIG90aGVyd2lzZS5cbiAqXG4gKiBAcGFyYW0ge1N0cmluZ30gbmFtZVxuICogQHJldHVybiB7Qm9vbGVhbn1cbiAqIEBhcGkgcHVibGljXG4gKi9cblxuZnVuY3Rpb24gZW5hYmxlZChuYW1lKSB7XG4gIHZhciBpLCBsZW47XG4gIGZvciAoaSA9IDAsIGxlbiA9IGV4cG9ydHMuc2tpcHMubGVuZ3RoOyBpIDwgbGVuOyBpKyspIHtcbiAgICBpZiAoZXhwb3J0cy5za2lwc1tpXS50ZXN0KG5hbWUpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG4gIGZvciAoaSA9IDAsIGxlbiA9IGV4cG9ydHMubmFtZXMubGVuZ3RoOyBpIDwgbGVuOyBpKyspIHtcbiAgICBpZiAoZXhwb3J0cy5uYW1lc1tpXS50ZXN0KG5hbWUpKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKipcbiAqIENvZXJjZSBgdmFsYC5cbiAqXG4gKiBAcGFyYW0ge01peGVkfSB2YWxcbiAqIEByZXR1cm4ge01peGVkfVxuICogQGFwaSBwcml2YXRlXG4gKi9cblxuZnVuY3Rpb24gY29lcmNlKHZhbCkge1xuICBpZiAodmFsIGluc3RhbmNlb2YgRXJyb3IpIHJldHVybiB2YWwuc3RhY2sgfHwgdmFsLm1lc3NhZ2U7XG4gIHJldHVybiB2YWw7XG59XG4iLCIvKipcbiAqIEhlbHBlcnMuXG4gKi9cblxudmFyIHMgPSAxMDAwO1xudmFyIG0gPSBzICogNjA7XG52YXIgaCA9IG0gKiA2MDtcbnZhciBkID0gaCAqIDI0O1xudmFyIHkgPSBkICogMzY1LjI1O1xuXG4vKipcbiAqIFBhcnNlIG9yIGZvcm1hdCB0aGUgZ2l2ZW4gYHZhbGAuXG4gKlxuICogT3B0aW9uczpcbiAqXG4gKiAgLSBgbG9uZ2AgdmVyYm9zZSBmb3JtYXR0aW5nIFtmYWxzZV1cbiAqXG4gKiBAcGFyYW0ge1N0cmluZ3xOdW1iZXJ9IHZhbFxuICogQHBhcmFtIHtPYmplY3R9IG9wdGlvbnNcbiAqIEByZXR1cm4ge1N0cmluZ3xOdW1iZXJ9XG4gKiBAYXBpIHB1YmxpY1xuICovXG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24odmFsLCBvcHRpb25zKXtcbiAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gIGlmICgnc3RyaW5nJyA9PSB0eXBlb2YgdmFsKSByZXR1cm4gcGFyc2UodmFsKTtcbiAgcmV0dXJuIG9wdGlvbnMubG9uZ1xuICAgID8gbG9uZyh2YWwpXG4gICAgOiBzaG9ydCh2YWwpO1xufTtcblxuLyoqXG4gKiBQYXJzZSB0aGUgZ2l2ZW4gYHN0cmAgYW5kIHJldHVybiBtaWxsaXNlY29uZHMuXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IHN0clxuICogQHJldHVybiB7TnVtYmVyfVxuICogQGFwaSBwcml2YXRlXG4gKi9cblxuZnVuY3Rpb24gcGFyc2Uoc3RyKSB7XG4gIHN0ciA9ICcnICsgc3RyO1xuICBpZiAoc3RyLmxlbmd0aCA+IDEwMDAwKSByZXR1cm47XG4gIHZhciBtYXRjaCA9IC9eKCg/OlxcZCspP1xcLj9cXGQrKSAqKG1pbGxpc2Vjb25kcz98bXNlY3M/fG1zfHNlY29uZHM/fHNlY3M/fHN8bWludXRlcz98bWlucz98bXxob3Vycz98aHJzP3xofGRheXM/fGR8eWVhcnM/fHlycz98eSk/JC9pLmV4ZWMoc3RyKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuO1xuICB2YXIgbiA9IHBhcnNlRmxvYXQobWF0Y2hbMV0pO1xuICB2YXIgdHlwZSA9IChtYXRjaFsyXSB8fCAnbXMnKS50b0xvd2VyQ2FzZSgpO1xuICBzd2l0Y2ggKHR5cGUpIHtcbiAgICBjYXNlICd5ZWFycyc6XG4gICAgY2FzZSAneWVhcic6XG4gICAgY2FzZSAneXJzJzpcbiAgICBjYXNlICd5cic6XG4gICAgY2FzZSAneSc6XG4gICAgICByZXR1cm4gbiAqIHk7XG4gICAgY2FzZSAnZGF5cyc6XG4gICAgY2FzZSAnZGF5JzpcbiAgICBjYXNlICdkJzpcbiAgICAgIHJldHVybiBuICogZDtcbiAgICBjYXNlICdob3Vycyc6XG4gICAgY2FzZSAnaG91cic6XG4gICAgY2FzZSAnaHJzJzpcbiAgICBjYXNlICdocic6XG4gICAgY2FzZSAnaCc6XG4gICAgICByZXR1cm4gbiAqIGg7XG4gICAgY2FzZSAnbWludXRlcyc6XG4gICAgY2FzZSAnbWludXRlJzpcbiAgICBjYXNlICdtaW5zJzpcbiAgICBjYXNlICdtaW4nOlxuICAgIGNhc2UgJ20nOlxuICAgICAgcmV0dXJuIG4gKiBtO1xuICAgIGNhc2UgJ3NlY29uZHMnOlxuICAgIGNhc2UgJ3NlY29uZCc6XG4gICAgY2FzZSAnc2Vjcyc6XG4gICAgY2FzZSAnc2VjJzpcbiAgICBjYXNlICdzJzpcbiAgICAgIHJldHVybiBuICogcztcbiAgICBjYXNlICdtaWxsaXNlY29uZHMnOlxuICAgIGNhc2UgJ21pbGxpc2Vjb25kJzpcbiAgICBjYXNlICdtc2Vjcyc6XG4gICAgY2FzZSAnbXNlYyc6XG4gICAgY2FzZSAnbXMnOlxuICAgICAgcmV0dXJuIG47XG4gIH1cbn1cblxuLyoqXG4gKiBTaG9ydCBmb3JtYXQgZm9yIGBtc2AuXG4gKlxuICogQHBhcmFtIHtOdW1iZXJ9IG1zXG4gKiBAcmV0dXJuIHtTdHJpbmd9XG4gKiBAYXBpIHByaXZhdGVcbiAqL1xuXG5mdW5jdGlvbiBzaG9ydChtcykge1xuICBpZiAobXMgPj0gZCkgcmV0dXJuIE1hdGgucm91bmQobXMgLyBkKSArICdkJztcbiAgaWYgKG1zID49IGgpIHJldHVybiBNYXRoLnJvdW5kKG1zIC8gaCkgKyAnaCc7XG4gIGlmIChtcyA+PSBtKSByZXR1cm4gTWF0aC5yb3VuZChtcyAvIG0pICsgJ20nO1xuICBpZiAobXMgPj0gcykgcmV0dXJuIE1hdGgucm91bmQobXMgLyBzKSArICdzJztcbiAgcmV0dXJuIG1zICsgJ21zJztcbn1cblxuLyoqXG4gKiBMb25nIGZvcm1hdCBmb3IgYG1zYC5cbiAqXG4gKiBAcGFyYW0ge051bWJlcn0gbXNcbiAqIEByZXR1cm4ge1N0cmluZ31cbiAqIEBhcGkgcHJpdmF0ZVxuICovXG5cbmZ1bmN0aW9uIGxvbmcobXMpIHtcbiAgcmV0dXJuIHBsdXJhbChtcywgZCwgJ2RheScpXG4gICAgfHwgcGx1cmFsKG1zLCBoLCAnaG91cicpXG4gICAgfHwgcGx1cmFsKG1zLCBtLCAnbWludXRlJylcbiAgICB8fCBwbHVyYWwobXMsIHMsICdzZWNvbmQnKVxuICAgIHx8IG1zICsgJyBtcyc7XG59XG5cbi8qKlxuICogUGx1cmFsaXphdGlvbiBoZWxwZXIuXG4gKi9cblxuZnVuY3Rpb24gcGx1cmFsKG1zLCBuLCBuYW1lKSB7XG4gIGlmIChtcyA8IG4pIHJldHVybjtcbiAgaWYgKG1zIDwgbiAqIDEuNSkgcmV0dXJuIE1hdGguZmxvb3IobXMgLyBuKSArICcgJyArIG5hbWU7XG4gIHJldHVybiBNYXRoLmNlaWwobXMgLyBuKSArICcgJyArIG5hbWUgKyAncyc7XG59XG4iLCJ2YXIgaGF0ID0gbW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoYml0cywgYmFzZSkge1xuICAgIGlmICghYmFzZSkgYmFzZSA9IDE2O1xuICAgIGlmIChiaXRzID09PSB1bmRlZmluZWQpIGJpdHMgPSAxMjg7XG4gICAgaWYgKGJpdHMgPD0gMCkgcmV0dXJuICcwJztcbiAgICBcbiAgICB2YXIgZGlnaXRzID0gTWF0aC5sb2coTWF0aC5wb3coMiwgYml0cykpIC8gTWF0aC5sb2coYmFzZSk7XG4gICAgZm9yICh2YXIgaSA9IDI7IGRpZ2l0cyA9PT0gSW5maW5pdHk7IGkgKj0gMikge1xuICAgICAgICBkaWdpdHMgPSBNYXRoLmxvZyhNYXRoLnBvdygyLCBiaXRzIC8gaSkpIC8gTWF0aC5sb2coYmFzZSkgKiBpO1xuICAgIH1cbiAgICBcbiAgICB2YXIgcmVtID0gZGlnaXRzIC0gTWF0aC5mbG9vcihkaWdpdHMpO1xuICAgIFxuICAgIHZhciByZXMgPSAnJztcbiAgICBcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IE1hdGguZmxvb3IoZGlnaXRzKTsgaSsrKSB7XG4gICAgICAgIHZhciB4ID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogYmFzZSkudG9TdHJpbmcoYmFzZSk7XG4gICAgICAgIHJlcyA9IHggKyByZXM7XG4gICAgfVxuICAgIFxuICAgIGlmIChyZW0pIHtcbiAgICAgICAgdmFyIGIgPSBNYXRoLnBvdyhiYXNlLCByZW0pO1xuICAgICAgICB2YXIgeCA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIGIpLnRvU3RyaW5nKGJhc2UpO1xuICAgICAgICByZXMgPSB4ICsgcmVzO1xuICAgIH1cbiAgICBcbiAgICB2YXIgcGFyc2VkID0gcGFyc2VJbnQocmVzLCBiYXNlKTtcbiAgICBpZiAocGFyc2VkICE9PSBJbmZpbml0eSAmJiBwYXJzZWQgPj0gTWF0aC5wb3coMiwgYml0cykpIHtcbiAgICAgICAgcmV0dXJuIGhhdChiaXRzLCBiYXNlKVxuICAgIH1cbiAgICBlbHNlIHJldHVybiByZXM7XG59O1xuXG5oYXQucmFjayA9IGZ1bmN0aW9uIChiaXRzLCBiYXNlLCBleHBhbmRCeSkge1xuICAgIHZhciBmbiA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gICAgICAgIHZhciBpdGVycyA9IDA7XG4gICAgICAgIGRvIHtcbiAgICAgICAgICAgIGlmIChpdGVycyArKyA+IDEwKSB7XG4gICAgICAgICAgICAgICAgaWYgKGV4cGFuZEJ5KSBiaXRzICs9IGV4cGFuZEJ5O1xuICAgICAgICAgICAgICAgIGVsc2UgdGhyb3cgbmV3IEVycm9yKCd0b28gbWFueSBJRCBjb2xsaXNpb25zLCB1c2UgbW9yZSBiaXRzJylcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgdmFyIGlkID0gaGF0KGJpdHMsIGJhc2UpO1xuICAgICAgICB9IHdoaWxlIChPYmplY3QuaGFzT3duUHJvcGVydHkuY2FsbChoYXRzLCBpZCkpO1xuICAgICAgICBcbiAgICAgICAgaGF0c1tpZF0gPSBkYXRhO1xuICAgICAgICByZXR1cm4gaWQ7XG4gICAgfTtcbiAgICB2YXIgaGF0cyA9IGZuLmhhdHMgPSB7fTtcbiAgICBcbiAgICBmbi5nZXQgPSBmdW5jdGlvbiAoaWQpIHtcbiAgICAgICAgcmV0dXJuIGZuLmhhdHNbaWRdO1xuICAgIH07XG4gICAgXG4gICAgZm4uc2V0ID0gZnVuY3Rpb24gKGlkLCB2YWx1ZSkge1xuICAgICAgICBmbi5oYXRzW2lkXSA9IHZhbHVlO1xuICAgICAgICByZXR1cm4gZm47XG4gICAgfTtcbiAgICBcbiAgICBmbi5iaXRzID0gYml0cyB8fCAxMjg7XG4gICAgZm4uYmFzZSA9IGJhc2UgfHwgMTY7XG4gICAgcmV0dXJuIGZuO1xufTtcbiIsImlmICh0eXBlb2YgT2JqZWN0LmNyZWF0ZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAvLyBpbXBsZW1lbnRhdGlvbiBmcm9tIHN0YW5kYXJkIG5vZGUuanMgJ3V0aWwnIG1vZHVsZVxuICBtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIGluaGVyaXRzKGN0b3IsIHN1cGVyQ3Rvcikge1xuICAgIGN0b3Iuc3VwZXJfID0gc3VwZXJDdG9yXG4gICAgY3Rvci5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKHN1cGVyQ3Rvci5wcm90b3R5cGUsIHtcbiAgICAgIGNvbnN0cnVjdG9yOiB7XG4gICAgICAgIHZhbHVlOiBjdG9yLFxuICAgICAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICAgICAgd3JpdGFibGU6IHRydWUsXG4gICAgICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZVxuICAgICAgfVxuICAgIH0pO1xuICB9O1xufSBlbHNlIHtcbiAgLy8gb2xkIHNjaG9vbCBzaGltIGZvciBvbGQgYnJvd3NlcnNcbiAgbW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBpbmhlcml0cyhjdG9yLCBzdXBlckN0b3IpIHtcbiAgICBjdG9yLnN1cGVyXyA9IHN1cGVyQ3RvclxuICAgIHZhciBUZW1wQ3RvciA9IGZ1bmN0aW9uICgpIHt9XG4gICAgVGVtcEN0b3IucHJvdG90eXBlID0gc3VwZXJDdG9yLnByb3RvdHlwZVxuICAgIGN0b3IucHJvdG90eXBlID0gbmV3IFRlbXBDdG9yKClcbiAgICBjdG9yLnByb3RvdHlwZS5jb25zdHJ1Y3RvciA9IGN0b3JcbiAgfVxufVxuIiwibW9kdWxlLmV4cG9ydHMgICAgICA9IGlzVHlwZWRBcnJheVxuaXNUeXBlZEFycmF5LnN0cmljdCA9IGlzU3RyaWN0VHlwZWRBcnJheVxuaXNUeXBlZEFycmF5Lmxvb3NlICA9IGlzTG9vc2VUeXBlZEFycmF5XG5cbnZhciB0b1N0cmluZyA9IE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmdcbnZhciBuYW1lcyA9IHtcbiAgICAnW29iamVjdCBJbnQ4QXJyYXldJzogdHJ1ZVxuICAsICdbb2JqZWN0IEludDE2QXJyYXldJzogdHJ1ZVxuICAsICdbb2JqZWN0IEludDMyQXJyYXldJzogdHJ1ZVxuICAsICdbb2JqZWN0IFVpbnQ4QXJyYXldJzogdHJ1ZVxuICAsICdbb2JqZWN0IFVpbnQ4Q2xhbXBlZEFycmF5XSc6IHRydWVcbiAgLCAnW29iamVjdCBVaW50MTZBcnJheV0nOiB0cnVlXG4gICwgJ1tvYmplY3QgVWludDMyQXJyYXldJzogdHJ1ZVxuICAsICdbb2JqZWN0IEZsb2F0MzJBcnJheV0nOiB0cnVlXG4gICwgJ1tvYmplY3QgRmxvYXQ2NEFycmF5XSc6IHRydWVcbn1cblxuZnVuY3Rpb24gaXNUeXBlZEFycmF5KGFycikge1xuICByZXR1cm4gKFxuICAgICAgIGlzU3RyaWN0VHlwZWRBcnJheShhcnIpXG4gICAgfHwgaXNMb29zZVR5cGVkQXJyYXkoYXJyKVxuICApXG59XG5cbmZ1bmN0aW9uIGlzU3RyaWN0VHlwZWRBcnJheShhcnIpIHtcbiAgcmV0dXJuIChcbiAgICAgICBhcnIgaW5zdGFuY2VvZiBJbnQ4QXJyYXlcbiAgICB8fCBhcnIgaW5zdGFuY2VvZiBJbnQxNkFycmF5XG4gICAgfHwgYXJyIGluc3RhbmNlb2YgSW50MzJBcnJheVxuICAgIHx8IGFyciBpbnN0YW5jZW9mIFVpbnQ4QXJyYXlcbiAgICB8fCBhcnIgaW5zdGFuY2VvZiBVaW50OENsYW1wZWRBcnJheVxuICAgIHx8IGFyciBpbnN0YW5jZW9mIFVpbnQxNkFycmF5XG4gICAgfHwgYXJyIGluc3RhbmNlb2YgVWludDMyQXJyYXlcbiAgICB8fCBhcnIgaW5zdGFuY2VvZiBGbG9hdDMyQXJyYXlcbiAgICB8fCBhcnIgaW5zdGFuY2VvZiBGbG9hdDY0QXJyYXlcbiAgKVxufVxuXG5mdW5jdGlvbiBpc0xvb3NlVHlwZWRBcnJheShhcnIpIHtcbiAgcmV0dXJuIG5hbWVzW3RvU3RyaW5nLmNhbGwoYXJyKV1cbn1cbiIsIi8vIFJldHVybnMgYSB3cmFwcGVyIGZ1bmN0aW9uIHRoYXQgcmV0dXJucyBhIHdyYXBwZWQgY2FsbGJhY2tcbi8vIFRoZSB3cmFwcGVyIGZ1bmN0aW9uIHNob3VsZCBkbyBzb21lIHN0dWZmLCBhbmQgcmV0dXJuIGFcbi8vIHByZXN1bWFibHkgZGlmZmVyZW50IGNhbGxiYWNrIGZ1bmN0aW9uLlxuLy8gVGhpcyBtYWtlcyBzdXJlIHRoYXQgb3duIHByb3BlcnRpZXMgYXJlIHJldGFpbmVkLCBzbyB0aGF0XG4vLyBkZWNvcmF0aW9ucyBhbmQgc3VjaCBhcmUgbm90IGxvc3QgYWxvbmcgdGhlIHdheS5cbm1vZHVsZS5leHBvcnRzID0gd3JhcHB5XG5mdW5jdGlvbiB3cmFwcHkgKGZuLCBjYikge1xuICBpZiAoZm4gJiYgY2IpIHJldHVybiB3cmFwcHkoZm4pKGNiKVxuXG4gIGlmICh0eXBlb2YgZm4gIT09ICdmdW5jdGlvbicpXG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignbmVlZCB3cmFwcGVyIGZ1bmN0aW9uJylcblxuICBPYmplY3Qua2V5cyhmbikuZm9yRWFjaChmdW5jdGlvbiAoaykge1xuICAgIHdyYXBwZXJba10gPSBmbltrXVxuICB9KVxuXG4gIHJldHVybiB3cmFwcGVyXG5cbiAgZnVuY3Rpb24gd3JhcHBlcigpIHtcbiAgICB2YXIgYXJncyA9IG5ldyBBcnJheShhcmd1bWVudHMubGVuZ3RoKVxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYXJncy5sZW5ndGg7IGkrKykge1xuICAgICAgYXJnc1tpXSA9IGFyZ3VtZW50c1tpXVxuICAgIH1cbiAgICB2YXIgcmV0ID0gZm4uYXBwbHkodGhpcywgYXJncylcbiAgICB2YXIgY2IgPSBhcmdzW2FyZ3MubGVuZ3RoLTFdXG4gICAgaWYgKHR5cGVvZiByZXQgPT09ICdmdW5jdGlvbicgJiYgcmV0ICE9PSBjYikge1xuICAgICAgT2JqZWN0LmtleXMoY2IpLmZvckVhY2goZnVuY3Rpb24gKGspIHtcbiAgICAgICAgcmV0W2tdID0gY2Jba11cbiAgICAgIH0pXG4gICAgfVxuICAgIHJldHVybiByZXRcbiAgfVxufVxuIiwidmFyIHdyYXBweSA9IHJlcXVpcmUoJ3dyYXBweScpXG5tb2R1bGUuZXhwb3J0cyA9IHdyYXBweShvbmNlKVxuXG5vbmNlLnByb3RvID0gb25jZShmdW5jdGlvbiAoKSB7XG4gIE9iamVjdC5kZWZpbmVQcm9wZXJ0eShGdW5jdGlvbi5wcm90b3R5cGUsICdvbmNlJywge1xuICAgIHZhbHVlOiBmdW5jdGlvbiAoKSB7XG4gICAgICByZXR1cm4gb25jZSh0aGlzKVxuICAgIH0sXG4gICAgY29uZmlndXJhYmxlOiB0cnVlXG4gIH0pXG59KVxuXG5mdW5jdGlvbiBvbmNlIChmbikge1xuICB2YXIgZiA9IGZ1bmN0aW9uICgpIHtcbiAgICBpZiAoZi5jYWxsZWQpIHJldHVybiBmLnZhbHVlXG4gICAgZi5jYWxsZWQgPSB0cnVlXG4gICAgcmV0dXJuIGYudmFsdWUgPSBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpXG4gIH1cbiAgZi5jYWxsZWQgPSBmYWxzZVxuICByZXR1cm4gZlxufVxuIiwiLyoqXG4gKiBDb252ZXJ0IGEgdHlwZWQgYXJyYXkgdG8gYSBCdWZmZXIgd2l0aG91dCBhIGNvcHlcbiAqXG4gKiBBdXRob3I6ICAgRmVyb3NzIEFib3VraGFkaWplaCA8ZmVyb3NzQGZlcm9zcy5vcmc+IDxodHRwOi8vZmVyb3NzLm9yZz5cbiAqIExpY2Vuc2U6ICBNSVRcbiAqXG4gKiBgbnBtIGluc3RhbGwgdHlwZWRhcnJheS10by1idWZmZXJgXG4gKi9cblxudmFyIGlzVHlwZWRBcnJheSA9IHJlcXVpcmUoJ2lzLXR5cGVkYXJyYXknKS5zdHJpY3RcblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoYXJyKSB7XG4gIC8vIElmIGBCdWZmZXJgIGlzIHRoZSBicm93c2VyIGBidWZmZXJgIG1vZHVsZSwgYW5kIHRoZSBicm93c2VyIHN1cHBvcnRzIHR5cGVkIGFycmF5cyxcbiAgLy8gdGhlbiBhdm9pZCBhIGNvcHkuIE90aGVyd2lzZSwgY3JlYXRlIGEgYEJ1ZmZlcmAgd2l0aCBhIGNvcHkuXG4gIHZhciBjb25zdHJ1Y3RvciA9IEJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUXG4gICAgPyBCdWZmZXIuX2F1Z21lbnRcbiAgICA6IGZ1bmN0aW9uIChhcnIpIHsgcmV0dXJuIG5ldyBCdWZmZXIoYXJyKSB9XG5cbiAgaWYgKGFyciBpbnN0YW5jZW9mIFVpbnQ4QXJyYXkpIHtcbiAgICByZXR1cm4gY29uc3RydWN0b3IoYXJyKVxuICB9IGVsc2UgaWYgKGFyciBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG4gICAgcmV0dXJuIGNvbnN0cnVjdG9yKG5ldyBVaW50OEFycmF5KGFycikpXG4gIH0gZWxzZSBpZiAoaXNUeXBlZEFycmF5KGFycikpIHtcbiAgICAvLyBVc2UgdGhlIHR5cGVkIGFycmF5J3MgdW5kZXJseWluZyBBcnJheUJ1ZmZlciB0byBiYWNrIG5ldyBCdWZmZXIuIFRoaXMgcmVzcGVjdHNcbiAgICAvLyB0aGUgXCJ2aWV3XCIgb24gdGhlIEFycmF5QnVmZmVyLCBpLmUuIGJ5dGVPZmZzZXQgYW5kIGJ5dGVMZW5ndGguIE5vIGNvcHkuXG4gICAgcmV0dXJuIGNvbnN0cnVjdG9yKG5ldyBVaW50OEFycmF5KGFyci5idWZmZXIsIGFyci5ieXRlT2Zmc2V0LCBhcnIuYnl0ZUxlbmd0aCkpXG4gIH0gZWxzZSB7XG4gICAgLy8gVW5zdXBwb3J0ZWQgdHlwZSwganVzdCBwYXNzIGl0IHRocm91Z2ggdG8gdGhlIGBCdWZmZXJgIGNvbnN0cnVjdG9yLlxuICAgIHJldHVybiBuZXcgQnVmZmVyKGFycilcbiAgfVxufVxuIiwiJ3VzZSBzdHJpY3QnO1xubW9kdWxlLmV4cG9ydHMgPSBTb3J0ZWRBcnJheVxudmFyIHNlYXJjaCA9IHJlcXVpcmUoJ2JpbmFyeS1zZWFyY2gnKVxuXG5mdW5jdGlvbiBTb3J0ZWRBcnJheShjbXAsIGFycikge1xuICBpZiAodHlwZW9mIGNtcCAhPSAnZnVuY3Rpb24nKVxuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ2NvbXBhcmF0b3IgbXVzdCBiZSBhIGZ1bmN0aW9uJylcblxuICB0aGlzLmFyciA9IGFyciB8fCBbXVxuICB0aGlzLmNtcCA9IGNtcFxufVxuXG5Tb3J0ZWRBcnJheS5wcm90b3R5cGUuaW5zZXJ0ID0gZnVuY3Rpb24oZWxlbWVudCkge1xuICB2YXIgaW5kZXggPSBzZWFyY2godGhpcy5hcnIsIGVsZW1lbnQsIHRoaXMuY21wKVxuICBpZiAoaW5kZXggPCAwKVxuICAgIGluZGV4ID0gfmluZGV4XG5cbiAgdGhpcy5hcnIuc3BsaWNlKGluZGV4LCAwLCBlbGVtZW50KVxufVxuXG5Tb3J0ZWRBcnJheS5wcm90b3R5cGUuaW5kZXhPZiA9IGZ1bmN0aW9uKGVsZW1lbnQpIHtcbiAgdmFyIGluZGV4ID0gc2VhcmNoKHRoaXMuYXJyLCBlbGVtZW50LCB0aGlzLmNtcClcbiAgcmV0dXJuIGluZGV4ID49IDBcbiAgICA/IGluZGV4XG4gICAgOiAtMVxufVxuXG5Tb3J0ZWRBcnJheS5wcm90b3R5cGUucmVtb3ZlID0gZnVuY3Rpb24oZWxlbWVudCkge1xuICB2YXIgaW5kZXggPSBzZWFyY2godGhpcy5hcnIsIGVsZW1lbnQsIHRoaXMuY21wKVxuICBpZiAoaW5kZXggPCAwKVxuICAgIHJldHVybiBmYWxzZVxuXG4gIHRoaXMuYXJyLnNwbGljZShpbmRleCwgMSlcbiAgcmV0dXJuIHRydWVcbn1cbiIsIm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oaGF5c3RhY2ssIG5lZWRsZSwgY29tcGFyYXRvciwgbG93LCBoaWdoKSB7XG4gIHZhciBtaWQsIGNtcDtcblxuICBpZihsb3cgPT09IHVuZGVmaW5lZClcbiAgICBsb3cgPSAwO1xuXG4gIGVsc2Uge1xuICAgIGxvdyA9IGxvd3wwO1xuICAgIGlmKGxvdyA8IDAgfHwgbG93ID49IGhheXN0YWNrLmxlbmd0aClcbiAgICAgIHRocm93IG5ldyBSYW5nZUVycm9yKFwiaW52YWxpZCBsb3dlciBib3VuZFwiKTtcbiAgfVxuXG4gIGlmKGhpZ2ggPT09IHVuZGVmaW5lZClcbiAgICBoaWdoID0gaGF5c3RhY2subGVuZ3RoIC0gMTtcblxuICBlbHNlIHtcbiAgICBoaWdoID0gaGlnaHwwO1xuICAgIGlmKGhpZ2ggPCBsb3cgfHwgaGlnaCA+PSBoYXlzdGFjay5sZW5ndGgpXG4gICAgICB0aHJvdyBuZXcgUmFuZ2VFcnJvcihcImludmFsaWQgdXBwZXIgYm91bmRcIik7XG4gIH1cblxuICB3aGlsZShsb3cgPD0gaGlnaCkge1xuICAgIC8qIE5vdGUgdGhhdCBcIihsb3cgKyBoaWdoKSA+Pj4gMVwiIG1heSBvdmVyZmxvdywgYW5kIHJlc3VsdHMgaW4gYSB0eXBlY2FzdFxuICAgICAqIHRvIGRvdWJsZSAod2hpY2ggZ2l2ZXMgdGhlIHdyb25nIHJlc3VsdHMpLiAqL1xuICAgIG1pZCA9IGxvdyArIChoaWdoIC0gbG93ID4+IDEpO1xuICAgIGNtcCA9ICtjb21wYXJhdG9yKGhheXN0YWNrW21pZF0sIG5lZWRsZSk7XG5cbiAgICAvKiBUb28gbG93LiAqL1xuICAgIGlmKGNtcCA8IDAuMCkgXG4gICAgICBsb3cgID0gbWlkICsgMTtcblxuICAgIC8qIFRvbyBoaWdoLiAqL1xuICAgIGVsc2UgaWYoY21wID4gMC4wKVxuICAgICAgaGlnaCA9IG1pZCAtIDE7XG4gICAgXG4gICAgLyogS2V5IGZvdW5kLiAqL1xuICAgIGVsc2VcbiAgICAgIHJldHVybiBtaWQ7XG4gIH1cblxuICAvKiBLZXkgbm90IGZvdW5kLiAqL1xuICByZXR1cm4gfmxvdztcbn1cbiIsInZhciBTb3J0ZWRBcnJheSA9IHJlcXVpcmUoJ3NvcnRlZC1jbXAtYXJyYXknKTtcbnZhciBDb21wYXJhdG9yID0gcmVxdWlyZSgnLi92dndlZW50cnkuanMnKS5Db21wYXJhdG9yO1xudmFyIFZWd0VFbnRyeSA9IHJlcXVpcmUoJy4vdnZ3ZWVudHJ5LmpzJyk7XG5cbi8qKlxuICogXFxjbGFzcyBWVndFXG4gKiBcXGJyaWVmIGNsYXNzIHZlcnNpb24gdmVjdG9yIHdpdGggZXhjZXB0aW9uIGtlZXBzIHRyYWNrIG9mIGV2ZW50cyBpbiBhIFxuICogY29uY2lzZSB3YXlcbiAqIFxccGFyYW0gZSB0aGUgZW50cnkgY2hvc2VuIGJ5IHRoZSBsb2NhbCBzaXRlICgxIGVudHJ5IDwtPiAxIHNpdGUpXG4gKi9cbmZ1bmN0aW9uIFZWd0UoZSl7XG4gICAgdGhpcy5sb2NhbCA9IG5ldyBWVndFRW50cnkoZSk7XG4gICAgdGhpcy52ZWN0b3IgPSBuZXcgU29ydGVkQXJyYXkoQ29tcGFyYXRvcik7XG4gICAgdGhpcy52ZWN0b3IuaW5zZXJ0KHRoaXMubG9jYWwpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNsb25lIG9mIHRoaXMgdnZ3ZVxuICovXG5WVndFLnByb3RvdHlwZS5jbG9uZSA9IGZ1bmN0aW9uKCl7XG4gICAgdmFyIGNsb25lVlZ3RSA9IG5ldyBWVndFKHRoaXMubG9jYWwuZSk7XG4gICAgZm9yICh2YXIgaT0wOyBpPHRoaXMudmVjdG9yLmFyci5sZW5ndGg7ICsraSl7XG4gICAgICAgIGNsb25lVlZ3RS52ZWN0b3IuYXJyW2ldID0gbmV3IFZWd0VFbnRyeSh0aGlzLnZlY3Rvci5hcnJbaV0uZSk7XG4gICAgICAgIGNsb25lVlZ3RS52ZWN0b3IuYXJyW2ldLnYgPSB0aGlzLnZlY3Rvci5hcnJbaV0udjtcbiAgICAgICAgZm9yICh2YXIgaj0wOyBqPHRoaXMudmVjdG9yLmFycltpXS54Lmxlbmd0aDsgKytqKXtcbiAgICAgICAgICAgIGNsb25lVlZ3RS52ZWN0b3IuYXJyW2ldLngucHVzaCh0aGlzLnZlY3Rvci5hcnJbaV0ueFtqXSk7XG4gICAgICAgIH07XG4gICAgICAgIGlmIChjbG9uZVZWd0UudmVjdG9yLmFycltpXS5lID09PSB0aGlzLmxvY2FsLmUpe1xuICAgICAgICAgICAgY2xvbmVWVndFLmxvY2FsID0gY2xvbmVWVndFLnZlY3Rvci5hcnJbaV07XG4gICAgICAgIH07XG4gICAgfTtcbiAgICByZXR1cm4gY2xvbmVWVndFO1xufTtcblxuVlZ3RS5wcm90b3R5cGUuZnJvbUpTT04gPSBmdW5jdGlvbihvYmplY3Qpe1xuICAgIGZvciAodmFyIGk9MDsgaTxvYmplY3QudmVjdG9yLmFyci5sZW5ndGg7ICsraSl7XG4gICAgICAgIHRoaXMudmVjdG9yLmFycltpXSA9IG5ldyBWVndFRW50cnkob2JqZWN0LnZlY3Rvci5hcnJbaV0uZSk7XG4gICAgICAgIHRoaXMudmVjdG9yLmFycltpXS52ID0gb2JqZWN0LnZlY3Rvci5hcnJbaV0udjtcbiAgICAgICAgZm9yICh2YXIgaj0wOyBqPG9iamVjdC52ZWN0b3IuYXJyW2ldLngubGVuZ3RoOyArK2ope1xuICAgICAgICAgICAgdGhpcy52ZWN0b3IuYXJyW2ldLngucHVzaChvYmplY3QudmVjdG9yLmFycltpXS54W2pdKTtcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKG9iamVjdC52ZWN0b3IuYXJyW2ldLmUgPT09IG9iamVjdC5sb2NhbC5lKXtcbiAgICAgICAgICAgIHRoaXMubG9jYWwgPSB0aGlzLnZlY3Rvci5hcnJbaV07XG4gICAgICAgIH07XG4gICAgfTtcbiAgICByZXR1cm4gdGhpcztcbn07XG5cbi8qKlxuICogXFxicmllZiBpbmNyZW1lbnQgdGhlIGVudHJ5IG9mIHRoZSB2ZWN0b3Igb24gbG9jYWwgdXBkYXRlXG4gKiBcXHJldHVybiB7X2U6IGVudHJ5LCBfYzogY291bnRlcn0gdW5pcXVlbHkgaWRlbnRpZnlpbmcgdGhlIG9wZXJhdGlvblxuICovXG5WVndFLnByb3RvdHlwZS5pbmNyZW1lbnQgPSBmdW5jdGlvbigpe1xuICAgIHRoaXMubG9jYWwuaW5jcmVtZW50KCk7XG4gICAgcmV0dXJuIHtfZTogdGhpcy5sb2NhbC5lLCBfYzp0aGlzLmxvY2FsLnZ9OyBcbn07XG5cblxuLyoqXG4gKiBcXGJyaWVmIGluY3JlbWVudCBmcm9tIGEgcmVtb3RlIG9wZXJhdGlvblxuICogXFxwYXJhbSBlYyB0aGUgZW50cnkgYW5kIGNsb2NrIG9mIHRoZSByZWNlaXZlZCBldmVudCB0byBhZGQgc3VwcG9zZWRseSByZHlcbiAqIHRoZSB0eXBlIGlzIHtfZTogZW50cnksIF9jOiBjb3VudGVyfVxuICovXG5WVndFLnByb3RvdHlwZS5pbmNyZW1lbnRGcm9tID0gZnVuY3Rpb24gKGVjKXtcbiAgICBpZiAoIWVjIHx8IChlYyAmJiAhZWMuX2UpIHx8IChlYyAmJiAhZWMuX2MpKSB7cmV0dXJuO31cbiAgICAvLyAjMCBmaW5kIHRoZSBlbnRyeSB3aXRoaW4gdGhlIGFycmF5IG9mIFZWd0VudHJpZXNcbiAgICB2YXIgaW5kZXggPSB0aGlzLnZlY3Rvci5pbmRleE9mKGVjLl9lKTtcbiAgICBpZiAoaW5kZXggPCAwKXtcbiAgICAgICAgLy8gIzEgaWYgdGhlIGVudHJ5IGRvZXMgbm90IGV4aXN0LCBpbml0aWFsaXplIGFuZCBpbmNyZW1lbnRcbiAgICAgICAgdGhpcy52ZWN0b3IuaW5zZXJ0KG5ldyBWVndFRW50cnkoZWMuX2UpKTtcbiAgICAgICAgdGhpcy52ZWN0b3IuYXJyW3RoaXMudmVjdG9yLmluZGV4T2YoZWMuX2UpXS5pbmNyZW1lbnRGcm9tKGVjLl9jKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICAvLyAjMiBvdGhlcndpc2UsIG9ubHkgaW5jcmVtZW50XG4gICAgICAgIHRoaXMudmVjdG9yLmFycltpbmRleF0uaW5jcmVtZW50RnJvbShlYy5fYyk7XG4gICAgfTtcbn07XG5cblxuLyoqXG4gKiBcXGJyaWVmIGNoZWNrIGlmIHRoZSBhcmd1bWVudCBhcmUgY2F1c2FsbHkgcmVhZHkgcmVnYXJkcyB0byB0aGlzIHZlY3RvclxuICogXFxwYXJhbSBlYyB0aGUgc2l0ZSBjbG9jayB0aGF0IGhhcHBlbi1iZWZvcmUgdGhlIGN1cnJlbnQgZXZlbnRcbiAqL1xuVlZ3RS5wcm90b3R5cGUuaXNSZWFkeSA9IGZ1bmN0aW9uKGVjKXtcbiAgICB2YXIgcmVhZHkgPSAhZWM7XG4gICAgaWYgKCFyZWFkeSl7XG4gICAgICAgIHZhciBpbmRleCA9IHRoaXMudmVjdG9yLmluZGV4T2YoZWMuX2UpO1xuICAgICAgICByZWFkeSA9IGluZGV4ID49MCAmJiBlYy5fYyA8PSB0aGlzLnZlY3Rvci5hcnJbaW5kZXhdLnYgJiZcbiAgICAgICAgICAgIHRoaXMudmVjdG9yLmFycltpbmRleF0ueC5pbmRleE9mKGVjLl9jKTwwO1xuICAgIH07XG4gICAgcmV0dXJuIHJlYWR5O1xufTtcblxuLyoqXG4gKiBcXGJyaWVmIGNoZWNrIGlmIHRoZSBtZXNzYWdlIGNvbnRhaW5zIGluZm9ybWF0aW9uIGFscmVhZHkgZGVsaXZlcmVkXG4gKiBcXHBhcmFtIGVjIHRoZSBzaXRlIGNsb2NrIHRvIGNoZWNrXG4gKi9cblZWd0UucHJvdG90eXBlLmlzTG93ZXIgPSBmdW5jdGlvbihlYyl7XG4gICAgcmV0dXJuIChlYyAmJiB0aGlzLmlzUmVhZHkoZWMpKTtcbn07XG5cbi8qKlxuICogXFxicmllZiBtZXJnZSB0aGUgdmVyc2lvbiB2ZWN0b3IgaW4gYXJndW1lbnQgd2l0aCB0aGlzXG4gKiBcXHBhcmFtIG90aGVyIHRoZSBvdGhlciB2ZXJzaW9uIHZlY3RvciB0byBtZXJnZVxuICovXG5WVndFLnByb3RvdHlwZS5tZXJnZSA9IGZ1bmN0aW9uKG90aGVyKXtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG90aGVyLnZlY3Rvci5hcnIubGVuZ3RoOyArK2kpe1xuICAgICAgICB2YXIgZW50cnkgPSBvdGhlci52ZWN0b3IuYXJyW2ldO1xuICAgICAgICB2YXIgaW5kZXggPSB0aGlzLnZlY3Rvci5pbmRleE9mKGVudHJ5KTtcbiAgICAgICAgaWYgKGluZGV4IDwgMCl7XG4gICAgICAgICAgICAvLyAjMSBlbnRyeSBkb2VzIG5vdCBleGlzdCwgZnVsbHkgY29weSBpdFxuICAgICAgICAgICAgdmFyIG5ld0VudHJ5ID0gbmV3IFZWd0VFbnRyeShlbnRyeS5lKTtcbiAgICAgICAgICAgIG5ld0VudHJ5LnYgPSBlbnRyeS52O1xuICAgICAgICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCBlbnRyeS54Lmxlbmd0aDsgKytqKXtcbiAgICAgICAgICAgICAgICBuZXdFbnRyeS54LnB1c2goZW50cnkueFtqXSk7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgdGhpcy52ZWN0b3IuaW5zZXJ0KG5ld0VudHJ5KTtcbiAgICAgICAgfWVsc2V7XG4gICAgICAgICAgICAvLyAjMiBvdGhlcndpc2UgbWVyZ2UgdGhlIGVudHJpZXNcbiAgICAgICAgICAgIHZhciBjdXJyRW50cnkgPSB0aGlzLnZlY3Rvci5hcnJbaV07XG4gICAgICAgICAgICAvLyAjMkEgcmVtb3ZlIHRoZSBleGNlcHRpb24gZnJvbSBvdXIgdmVjdG9yXG4gICAgICAgICAgICB2YXIgaiA9IDA7XG4gICAgICAgICAgICB3aGlsZSAoajxjdXJyRW50cnkueC5sZW5ndGgpe1xuICAgICAgICAgICAgICAgIGlmIChjdXJyRW50cnkueFtqXTxlbnRyeS52ICYmXG4gICAgICAgICAgICAgICAgICAgIGVudHJ5LnguaW5kZXhPZihjdXJyRW50cnkueFtqXSk8MCl7XG4gICAgICAgICAgICAgICAgICAgIGN1cnJFbnRyeS54LnNwbGljZShqLCAxKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICArK2o7XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICAvLyAjMkIgYWRkIHRoZSBuZXcgZXhjZXB0aW9uc1xuICAgICAgICAgICAgaiA9IDA7XG4gICAgICAgICAgICB3aGlsZSAoajxlbnRyeS54Lmxlbmd0aCl7XG4gICAgICAgICAgICAgICAgaWYgKGVudHJ5Lnhbal0gPiBjdXJyRW50cnkudiAmJlxuICAgICAgICAgICAgICAgICAgICBjdXJyRW50cnkueC5pbmRleE9mKGVudHJ5Lnhbal0pPDApe1xuICAgICAgICAgICAgICAgICAgICBjdXJyRW50cnkueC5wdXNoKGVudHJ5Lnhbal0pO1xuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgKytqO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGN1cnJFbnRyeS52ID0gTWF0aC5tYXgoY3VyckVudHJ5LnYsIGVudHJ5LnYpO1xuICAgICAgICB9O1xuICAgIH07XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IFZWd0U7XG5cbiIsIlxuLyohXG4gIFxcYnJpZWYgY3JlYXRlIGFuIGVudHJ5IG9mIHRoZSB2ZXJzaW9uIHZlY3RvciB3aXRoIGV4Y2VwdGlvbnMgY29udGFpbmluZyB0aGVcbiAgaW5kZXggb2YgdGhlIGVudHJ5LCB0aGUgdmFsdWUgdiB0aGF0IGNyZWF0ZXMgYSBjb250aWd1b3VzIGludGVydmFsXG4gIGZyb20gMCB0byB2LCBhbiBhcnJheSBvZiBpbnRlZ2VycyB0aGF0IGNvbnRhaW4gdGhlIG9wZXJhdGlvbnMgbG93ZXIgdG8gdiB0aGF0XG4gIGhhdmUgbm90IGJlZW4gcmVjZWl2ZWQgeWV0XG4gIFxccGFyYW0gZSB0aGUgZW50cnkgaW4gdGhlIGludGVydmFsIHZlcnNpb24gdmVjdG9yXG4qL1xuZnVuY3Rpb24gVlZ3RUVudHJ5KGUpe1xuICAgIHRoaXMuZSA9IGU7ICAgXG4gICAgdGhpcy52ID0gMDtcbiAgICB0aGlzLnggPSBbXTtcbn07XG5cbi8qIVxuICogXFxicmllZiBsb2NhbCBjb3VudGVyIGluY3JlbWVudGVkXG4gKi9cblZWd0VFbnRyeS5wcm90b3R5cGUuaW5jcmVtZW50ID0gZnVuY3Rpb24oKXtcbiAgICB0aGlzLnYgKz0gMTtcbn07XG5cbi8qKlxuICogXFxicmllZiBpbmNyZW1lbnQgZnJvbSBhIHJlbW90ZSBvcGVyYXRpb25cbiAqIFxccGFyYW0gYyB0aGUgY291bnRlciBvZiB0aGUgb3BlcmF0aW9uIHRvIGFkZCB0byB0aGlzIFxuICovXG5WVndFRW50cnkucHJvdG90eXBlLmluY3JlbWVudEZyb20gPSBmdW5jdGlvbihjKXtcbiAgICAvLyAjMSBjaGVjayBpZiB0aGUgY291bnRlciBpcyBpbmNsdWRlZCBpbiB0aGUgZXhjZXB0aW9uc1xuICAgIGlmIChjIDwgdGhpcy52KXtcbiAgICAgICAgdmFyIGluZGV4ID0gdGhpcy54LmluZGV4T2YoYyk7XG4gICAgICAgIGlmIChpbmRleD49MCl7IC8vIHRoZSBleGNlcHRpb24gaXMgZm91bmRcbiAgICAgICAgICAgIHRoaXMueC5zcGxpY2UoaW5kZXgsIDEpO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgLy8gIzIgaWYgdGhlIHZhbHVlIGlzICsxIGNvbXBhcmVkIHRvIHRoZSBjdXJyZW50IHZhbHVlIG9mIHRoZSB2ZWN0b3JcbiAgICBpZiAoYyA9PSAodGhpcy52ICsgMSkpe1xuICAgICAgICB0aGlzLnYgKz0gMTtcbiAgICB9O1xuICAgIC8vICMzIG90aGVyd2lzZSBleGNlcHRpb24gYXJlIG1hZGVcbiAgICBpZiAoYyA+ICh0aGlzLnYgKyAxKSl7XG4gICAgICAgIGZvciAodmFyIGkgPSAodGhpcy52ICsgMSk7IGk8YzsgKytpKXtcbiAgICAgICAgICAgIHRoaXMueC5wdXNoKGkpO1xuICAgICAgICB9O1xuICAgICAgICB0aGlzLnYgPSBjO1xuICAgIH07XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgY29tcGFyaXNvbiBmdW5jdGlvbiBiZXR3ZWVuIHR3byBWVndFIGVudHJpZXNcbiAqIFxccGFyYW0gYSB0aGUgZmlyc3QgZWxlbWVudFxuICogXFxwYXJhbSBiIHRoZSBzZWNvbmQgZWxlbWVudFxuICogXFxyZXR1cm4gLTEgaWYgYSA8IGIsIDEgaWYgYSA+IGIsIDAgb3RoZXJ3aXNlXG4gKi9cbmZ1bmN0aW9uIENvbXBhcmF0b3IgKGEsIGIpe1xuICAgIHZhciBhRW50cnkgPSAoYS5lKSB8fCBhO1xuICAgIHZhciBiRW50cnkgPSAoYi5lKSB8fCBiO1xuICAgIGlmIChhRW50cnkgPCBiRW50cnkpeyByZXR1cm4gLTE7IH07XG4gICAgaWYgKGFFbnRyeSA+IGJFbnRyeSl7IHJldHVybiAgMTsgfTtcbiAgICByZXR1cm4gMDtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gVlZ3RUVudHJ5O1xubW9kdWxlLmV4cG9ydHMuQ29tcGFyYXRvciA9IENvbXBhcmF0b3I7XG4iLG51bGwsIi8qIVxuICogVGhlIGJ1ZmZlciBtb2R1bGUgZnJvbSBub2RlLmpzLCBmb3IgdGhlIGJyb3dzZXIuXG4gKlxuICogQGF1dGhvciAgIEZlcm9zcyBBYm91a2hhZGlqZWggPGZlcm9zc0BmZXJvc3Mub3JnPiA8aHR0cDovL2Zlcm9zcy5vcmc+XG4gKiBAbGljZW5zZSAgTUlUXG4gKi9cbi8qIGVzbGludC1kaXNhYmxlIG5vLXByb3RvICovXG5cbnZhciBiYXNlNjQgPSByZXF1aXJlKCdiYXNlNjQtanMnKVxudmFyIGllZWU3NTQgPSByZXF1aXJlKCdpZWVlNzU0JylcbnZhciBpc0FycmF5ID0gcmVxdWlyZSgnaXMtYXJyYXknKVxuXG5leHBvcnRzLkJ1ZmZlciA9IEJ1ZmZlclxuZXhwb3J0cy5TbG93QnVmZmVyID0gU2xvd0J1ZmZlclxuZXhwb3J0cy5JTlNQRUNUX01BWF9CWVRFUyA9IDUwXG5CdWZmZXIucG9vbFNpemUgPSA4MTkyIC8vIG5vdCB1c2VkIGJ5IHRoaXMgaW1wbGVtZW50YXRpb25cblxudmFyIHJvb3RQYXJlbnQgPSB7fVxuXG4vKipcbiAqIElmIGBCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVGA6XG4gKiAgID09PSB0cnVlICAgIFVzZSBVaW50OEFycmF5IGltcGxlbWVudGF0aW9uIChmYXN0ZXN0KVxuICogICA9PT0gZmFsc2UgICBVc2UgT2JqZWN0IGltcGxlbWVudGF0aW9uIChtb3N0IGNvbXBhdGlibGUsIGV2ZW4gSUU2KVxuICpcbiAqIEJyb3dzZXJzIHRoYXQgc3VwcG9ydCB0eXBlZCBhcnJheXMgYXJlIElFIDEwKywgRmlyZWZveCA0KywgQ2hyb21lIDcrLCBTYWZhcmkgNS4xKyxcbiAqIE9wZXJhIDExLjYrLCBpT1MgNC4yKy5cbiAqXG4gKiBEdWUgdG8gdmFyaW91cyBicm93c2VyIGJ1Z3MsIHNvbWV0aW1lcyB0aGUgT2JqZWN0IGltcGxlbWVudGF0aW9uIHdpbGwgYmUgdXNlZCBldmVuXG4gKiB3aGVuIHRoZSBicm93c2VyIHN1cHBvcnRzIHR5cGVkIGFycmF5cy5cbiAqXG4gKiBOb3RlOlxuICpcbiAqICAgLSBGaXJlZm94IDQtMjkgbGFja3Mgc3VwcG9ydCBmb3IgYWRkaW5nIG5ldyBwcm9wZXJ0aWVzIHRvIGBVaW50OEFycmF5YCBpbnN0YW5jZXMsXG4gKiAgICAgU2VlOiBodHRwczovL2J1Z3ppbGxhLm1vemlsbGEub3JnL3Nob3dfYnVnLmNnaT9pZD02OTU0MzguXG4gKlxuICogICAtIFNhZmFyaSA1LTcgbGFja3Mgc3VwcG9ydCBmb3IgY2hhbmdpbmcgdGhlIGBPYmplY3QucHJvdG90eXBlLmNvbnN0cnVjdG9yYCBwcm9wZXJ0eVxuICogICAgIG9uIG9iamVjdHMuXG4gKlxuICogICAtIENocm9tZSA5LTEwIGlzIG1pc3NpbmcgdGhlIGBUeXBlZEFycmF5LnByb3RvdHlwZS5zdWJhcnJheWAgZnVuY3Rpb24uXG4gKlxuICogICAtIElFMTAgaGFzIGEgYnJva2VuIGBUeXBlZEFycmF5LnByb3RvdHlwZS5zdWJhcnJheWAgZnVuY3Rpb24gd2hpY2ggcmV0dXJucyBhcnJheXMgb2ZcbiAqICAgICBpbmNvcnJlY3QgbGVuZ3RoIGluIHNvbWUgc2l0dWF0aW9ucy5cblxuICogV2UgZGV0ZWN0IHRoZXNlIGJ1Z2d5IGJyb3dzZXJzIGFuZCBzZXQgYEJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUYCB0byBgZmFsc2VgIHNvIHRoZXlcbiAqIGdldCB0aGUgT2JqZWN0IGltcGxlbWVudGF0aW9uLCB3aGljaCBpcyBzbG93ZXIgYnV0IGJlaGF2ZXMgY29ycmVjdGx5LlxuICovXG5CdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCA9IGdsb2JhbC5UWVBFRF9BUlJBWV9TVVBQT1JUICE9PSB1bmRlZmluZWRcbiAgPyBnbG9iYWwuVFlQRURfQVJSQVlfU1VQUE9SVFxuICA6IHR5cGVkQXJyYXlTdXBwb3J0KClcblxuZnVuY3Rpb24gdHlwZWRBcnJheVN1cHBvcnQgKCkge1xuICBmdW5jdGlvbiBCYXIgKCkge31cbiAgdHJ5IHtcbiAgICB2YXIgYXJyID0gbmV3IFVpbnQ4QXJyYXkoMSlcbiAgICBhcnIuZm9vID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gNDIgfVxuICAgIGFyci5jb25zdHJ1Y3RvciA9IEJhclxuICAgIHJldHVybiBhcnIuZm9vKCkgPT09IDQyICYmIC8vIHR5cGVkIGFycmF5IGluc3RhbmNlcyBjYW4gYmUgYXVnbWVudGVkXG4gICAgICAgIGFyci5jb25zdHJ1Y3RvciA9PT0gQmFyICYmIC8vIGNvbnN0cnVjdG9yIGNhbiBiZSBzZXRcbiAgICAgICAgdHlwZW9mIGFyci5zdWJhcnJheSA9PT0gJ2Z1bmN0aW9uJyAmJiAvLyBjaHJvbWUgOS0xMCBsYWNrIGBzdWJhcnJheWBcbiAgICAgICAgYXJyLnN1YmFycmF5KDEsIDEpLmJ5dGVMZW5ndGggPT09IDAgLy8gaWUxMCBoYXMgYnJva2VuIGBzdWJhcnJheWBcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiBmYWxzZVxuICB9XG59XG5cbmZ1bmN0aW9uIGtNYXhMZW5ndGggKCkge1xuICByZXR1cm4gQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlRcbiAgICA/IDB4N2ZmZmZmZmZcbiAgICA6IDB4M2ZmZmZmZmZcbn1cblxuLyoqXG4gKiBDbGFzczogQnVmZmVyXG4gKiA9PT09PT09PT09PT09XG4gKlxuICogVGhlIEJ1ZmZlciBjb25zdHJ1Y3RvciByZXR1cm5zIGluc3RhbmNlcyBvZiBgVWludDhBcnJheWAgdGhhdCBhcmUgYXVnbWVudGVkXG4gKiB3aXRoIGZ1bmN0aW9uIHByb3BlcnRpZXMgZm9yIGFsbCB0aGUgbm9kZSBgQnVmZmVyYCBBUEkgZnVuY3Rpb25zLiBXZSB1c2VcbiAqIGBVaW50OEFycmF5YCBzbyB0aGF0IHNxdWFyZSBicmFja2V0IG5vdGF0aW9uIHdvcmtzIGFzIGV4cGVjdGVkIC0tIGl0IHJldHVybnNcbiAqIGEgc2luZ2xlIG9jdGV0LlxuICpcbiAqIEJ5IGF1Z21lbnRpbmcgdGhlIGluc3RhbmNlcywgd2UgY2FuIGF2b2lkIG1vZGlmeWluZyB0aGUgYFVpbnQ4QXJyYXlgXG4gKiBwcm90b3R5cGUuXG4gKi9cbmZ1bmN0aW9uIEJ1ZmZlciAoYXJnKSB7XG4gIGlmICghKHRoaXMgaW5zdGFuY2VvZiBCdWZmZXIpKSB7XG4gICAgLy8gQXZvaWQgZ29pbmcgdGhyb3VnaCBhbiBBcmd1bWVudHNBZGFwdG9yVHJhbXBvbGluZSBpbiB0aGUgY29tbW9uIGNhc2UuXG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAxKSByZXR1cm4gbmV3IEJ1ZmZlcihhcmcsIGFyZ3VtZW50c1sxXSlcbiAgICByZXR1cm4gbmV3IEJ1ZmZlcihhcmcpXG4gIH1cblxuICB0aGlzLmxlbmd0aCA9IDBcbiAgdGhpcy5wYXJlbnQgPSB1bmRlZmluZWRcblxuICAvLyBDb21tb24gY2FzZS5cbiAgaWYgKHR5cGVvZiBhcmcgPT09ICdudW1iZXInKSB7XG4gICAgcmV0dXJuIGZyb21OdW1iZXIodGhpcywgYXJnKVxuICB9XG5cbiAgLy8gU2xpZ2h0bHkgbGVzcyBjb21tb24gY2FzZS5cbiAgaWYgKHR5cGVvZiBhcmcgPT09ICdzdHJpbmcnKSB7XG4gICAgcmV0dXJuIGZyb21TdHJpbmcodGhpcywgYXJnLCBhcmd1bWVudHMubGVuZ3RoID4gMSA/IGFyZ3VtZW50c1sxXSA6ICd1dGY4JylcbiAgfVxuXG4gIC8vIFVudXN1YWwuXG4gIHJldHVybiBmcm9tT2JqZWN0KHRoaXMsIGFyZylcbn1cblxuZnVuY3Rpb24gZnJvbU51bWJlciAodGhhdCwgbGVuZ3RoKSB7XG4gIHRoYXQgPSBhbGxvY2F0ZSh0aGF0LCBsZW5ndGggPCAwID8gMCA6IGNoZWNrZWQobGVuZ3RoKSB8IDApXG4gIGlmICghQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgICB0aGF0W2ldID0gMFxuICAgIH1cbiAgfVxuICByZXR1cm4gdGhhdFxufVxuXG5mdW5jdGlvbiBmcm9tU3RyaW5nICh0aGF0LCBzdHJpbmcsIGVuY29kaW5nKSB7XG4gIGlmICh0eXBlb2YgZW5jb2RpbmcgIT09ICdzdHJpbmcnIHx8IGVuY29kaW5nID09PSAnJykgZW5jb2RpbmcgPSAndXRmOCdcblxuICAvLyBBc3N1bXB0aW9uOiBieXRlTGVuZ3RoKCkgcmV0dXJuIHZhbHVlIGlzIGFsd2F5cyA8IGtNYXhMZW5ndGguXG4gIHZhciBsZW5ndGggPSBieXRlTGVuZ3RoKHN0cmluZywgZW5jb2RpbmcpIHwgMFxuICB0aGF0ID0gYWxsb2NhdGUodGhhdCwgbGVuZ3RoKVxuXG4gIHRoYXQud3JpdGUoc3RyaW5nLCBlbmNvZGluZylcbiAgcmV0dXJuIHRoYXRcbn1cblxuZnVuY3Rpb24gZnJvbU9iamVjdCAodGhhdCwgb2JqZWN0KSB7XG4gIGlmIChCdWZmZXIuaXNCdWZmZXIob2JqZWN0KSkgcmV0dXJuIGZyb21CdWZmZXIodGhhdCwgb2JqZWN0KVxuXG4gIGlmIChpc0FycmF5KG9iamVjdCkpIHJldHVybiBmcm9tQXJyYXkodGhhdCwgb2JqZWN0KVxuXG4gIGlmIChvYmplY3QgPT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ211c3Qgc3RhcnQgd2l0aCBudW1iZXIsIGJ1ZmZlciwgYXJyYXkgb3Igc3RyaW5nJylcbiAgfVxuXG4gIGlmICh0eXBlb2YgQXJyYXlCdWZmZXIgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgaWYgKG9iamVjdC5idWZmZXIgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuICAgICAgcmV0dXJuIGZyb21UeXBlZEFycmF5KHRoYXQsIG9iamVjdClcbiAgICB9XG4gICAgaWYgKG9iamVjdCBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7XG4gICAgICByZXR1cm4gZnJvbUFycmF5QnVmZmVyKHRoYXQsIG9iamVjdClcbiAgICB9XG4gIH1cblxuICBpZiAob2JqZWN0Lmxlbmd0aCkgcmV0dXJuIGZyb21BcnJheUxpa2UodGhhdCwgb2JqZWN0KVxuXG4gIHJldHVybiBmcm9tSnNvbk9iamVjdCh0aGF0LCBvYmplY3QpXG59XG5cbmZ1bmN0aW9uIGZyb21CdWZmZXIgKHRoYXQsIGJ1ZmZlcikge1xuICB2YXIgbGVuZ3RoID0gY2hlY2tlZChidWZmZXIubGVuZ3RoKSB8IDBcbiAgdGhhdCA9IGFsbG9jYXRlKHRoYXQsIGxlbmd0aClcbiAgYnVmZmVyLmNvcHkodGhhdCwgMCwgMCwgbGVuZ3RoKVxuICByZXR1cm4gdGhhdFxufVxuXG5mdW5jdGlvbiBmcm9tQXJyYXkgKHRoYXQsIGFycmF5KSB7XG4gIHZhciBsZW5ndGggPSBjaGVja2VkKGFycmF5Lmxlbmd0aCkgfCAwXG4gIHRoYXQgPSBhbGxvY2F0ZSh0aGF0LCBsZW5ndGgpXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuZ3RoOyBpICs9IDEpIHtcbiAgICB0aGF0W2ldID0gYXJyYXlbaV0gJiAyNTVcbiAgfVxuICByZXR1cm4gdGhhdFxufVxuXG4vLyBEdXBsaWNhdGUgb2YgZnJvbUFycmF5KCkgdG8ga2VlcCBmcm9tQXJyYXkoKSBtb25vbW9ycGhpYy5cbmZ1bmN0aW9uIGZyb21UeXBlZEFycmF5ICh0aGF0LCBhcnJheSkge1xuICB2YXIgbGVuZ3RoID0gY2hlY2tlZChhcnJheS5sZW5ndGgpIHwgMFxuICB0aGF0ID0gYWxsb2NhdGUodGhhdCwgbGVuZ3RoKVxuICAvLyBUcnVuY2F0aW5nIHRoZSBlbGVtZW50cyBpcyBwcm9iYWJseSBub3Qgd2hhdCBwZW9wbGUgZXhwZWN0IGZyb20gdHlwZWRcbiAgLy8gYXJyYXlzIHdpdGggQllURVNfUEVSX0VMRU1FTlQgPiAxIGJ1dCBpdCdzIGNvbXBhdGlibGUgd2l0aCB0aGUgYmVoYXZpb3JcbiAgLy8gb2YgdGhlIG9sZCBCdWZmZXIgY29uc3RydWN0b3IuXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuZ3RoOyBpICs9IDEpIHtcbiAgICB0aGF0W2ldID0gYXJyYXlbaV0gJiAyNTVcbiAgfVxuICByZXR1cm4gdGhhdFxufVxuXG5mdW5jdGlvbiBmcm9tQXJyYXlCdWZmZXIgKHRoYXQsIGFycmF5KSB7XG4gIGlmIChCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkge1xuICAgIC8vIFJldHVybiBhbiBhdWdtZW50ZWQgYFVpbnQ4QXJyYXlgIGluc3RhbmNlLCBmb3IgYmVzdCBwZXJmb3JtYW5jZVxuICAgIGFycmF5LmJ5dGVMZW5ndGhcbiAgICB0aGF0ID0gQnVmZmVyLl9hdWdtZW50KG5ldyBVaW50OEFycmF5KGFycmF5KSlcbiAgfSBlbHNlIHtcbiAgICAvLyBGYWxsYmFjazogUmV0dXJuIGFuIG9iamVjdCBpbnN0YW5jZSBvZiB0aGUgQnVmZmVyIGNsYXNzXG4gICAgdGhhdCA9IGZyb21UeXBlZEFycmF5KHRoYXQsIG5ldyBVaW50OEFycmF5KGFycmF5KSlcbiAgfVxuICByZXR1cm4gdGhhdFxufVxuXG5mdW5jdGlvbiBmcm9tQXJyYXlMaWtlICh0aGF0LCBhcnJheSkge1xuICB2YXIgbGVuZ3RoID0gY2hlY2tlZChhcnJheS5sZW5ndGgpIHwgMFxuICB0aGF0ID0gYWxsb2NhdGUodGhhdCwgbGVuZ3RoKVxuICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSArPSAxKSB7XG4gICAgdGhhdFtpXSA9IGFycmF5W2ldICYgMjU1XG4gIH1cbiAgcmV0dXJuIHRoYXRcbn1cblxuLy8gRGVzZXJpYWxpemUgeyB0eXBlOiAnQnVmZmVyJywgZGF0YTogWzEsMiwzLC4uLl0gfSBpbnRvIGEgQnVmZmVyIG9iamVjdC5cbi8vIFJldHVybnMgYSB6ZXJvLWxlbmd0aCBidWZmZXIgZm9yIGlucHV0cyB0aGF0IGRvbid0IGNvbmZvcm0gdG8gdGhlIHNwZWMuXG5mdW5jdGlvbiBmcm9tSnNvbk9iamVjdCAodGhhdCwgb2JqZWN0KSB7XG4gIHZhciBhcnJheVxuICB2YXIgbGVuZ3RoID0gMFxuXG4gIGlmIChvYmplY3QudHlwZSA9PT0gJ0J1ZmZlcicgJiYgaXNBcnJheShvYmplY3QuZGF0YSkpIHtcbiAgICBhcnJheSA9IG9iamVjdC5kYXRhXG4gICAgbGVuZ3RoID0gY2hlY2tlZChhcnJheS5sZW5ndGgpIHwgMFxuICB9XG4gIHRoYXQgPSBhbGxvY2F0ZSh0aGF0LCBsZW5ndGgpXG5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW5ndGg7IGkgKz0gMSkge1xuICAgIHRoYXRbaV0gPSBhcnJheVtpXSAmIDI1NVxuICB9XG4gIHJldHVybiB0aGF0XG59XG5cbmlmIChCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkge1xuICBCdWZmZXIucHJvdG90eXBlLl9fcHJvdG9fXyA9IFVpbnQ4QXJyYXkucHJvdG90eXBlXG4gIEJ1ZmZlci5fX3Byb3RvX18gPSBVaW50OEFycmF5XG59XG5cbmZ1bmN0aW9uIGFsbG9jYXRlICh0aGF0LCBsZW5ndGgpIHtcbiAgaWYgKEJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUKSB7XG4gICAgLy8gUmV0dXJuIGFuIGF1Z21lbnRlZCBgVWludDhBcnJheWAgaW5zdGFuY2UsIGZvciBiZXN0IHBlcmZvcm1hbmNlXG4gICAgdGhhdCA9IEJ1ZmZlci5fYXVnbWVudChuZXcgVWludDhBcnJheShsZW5ndGgpKVxuICAgIHRoYXQuX19wcm90b19fID0gQnVmZmVyLnByb3RvdHlwZVxuICB9IGVsc2Uge1xuICAgIC8vIEZhbGxiYWNrOiBSZXR1cm4gYW4gb2JqZWN0IGluc3RhbmNlIG9mIHRoZSBCdWZmZXIgY2xhc3NcbiAgICB0aGF0Lmxlbmd0aCA9IGxlbmd0aFxuICAgIHRoYXQuX2lzQnVmZmVyID0gdHJ1ZVxuICB9XG5cbiAgdmFyIGZyb21Qb29sID0gbGVuZ3RoICE9PSAwICYmIGxlbmd0aCA8PSBCdWZmZXIucG9vbFNpemUgPj4+IDFcbiAgaWYgKGZyb21Qb29sKSB0aGF0LnBhcmVudCA9IHJvb3RQYXJlbnRcblxuICByZXR1cm4gdGhhdFxufVxuXG5mdW5jdGlvbiBjaGVja2VkIChsZW5ndGgpIHtcbiAgLy8gTm90ZTogY2Fubm90IHVzZSBgbGVuZ3RoIDwga01heExlbmd0aGAgaGVyZSBiZWNhdXNlIHRoYXQgZmFpbHMgd2hlblxuICAvLyBsZW5ndGggaXMgTmFOICh3aGljaCBpcyBvdGhlcndpc2UgY29lcmNlZCB0byB6ZXJvLilcbiAgaWYgKGxlbmd0aCA+PSBrTWF4TGVuZ3RoKCkpIHtcbiAgICB0aHJvdyBuZXcgUmFuZ2VFcnJvcignQXR0ZW1wdCB0byBhbGxvY2F0ZSBCdWZmZXIgbGFyZ2VyIHRoYW4gbWF4aW11bSAnICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAnc2l6ZTogMHgnICsga01heExlbmd0aCgpLnRvU3RyaW5nKDE2KSArICcgYnl0ZXMnKVxuICB9XG4gIHJldHVybiBsZW5ndGggfCAwXG59XG5cbmZ1bmN0aW9uIFNsb3dCdWZmZXIgKHN1YmplY3QsIGVuY29kaW5nKSB7XG4gIGlmICghKHRoaXMgaW5zdGFuY2VvZiBTbG93QnVmZmVyKSkgcmV0dXJuIG5ldyBTbG93QnVmZmVyKHN1YmplY3QsIGVuY29kaW5nKVxuXG4gIHZhciBidWYgPSBuZXcgQnVmZmVyKHN1YmplY3QsIGVuY29kaW5nKVxuICBkZWxldGUgYnVmLnBhcmVudFxuICByZXR1cm4gYnVmXG59XG5cbkJ1ZmZlci5pc0J1ZmZlciA9IGZ1bmN0aW9uIGlzQnVmZmVyIChiKSB7XG4gIHJldHVybiAhIShiICE9IG51bGwgJiYgYi5faXNCdWZmZXIpXG59XG5cbkJ1ZmZlci5jb21wYXJlID0gZnVuY3Rpb24gY29tcGFyZSAoYSwgYikge1xuICBpZiAoIUJ1ZmZlci5pc0J1ZmZlcihhKSB8fCAhQnVmZmVyLmlzQnVmZmVyKGIpKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignQXJndW1lbnRzIG11c3QgYmUgQnVmZmVycycpXG4gIH1cblxuICBpZiAoYSA9PT0gYikgcmV0dXJuIDBcblxuICB2YXIgeCA9IGEubGVuZ3RoXG4gIHZhciB5ID0gYi5sZW5ndGhcblxuICB2YXIgaSA9IDBcbiAgdmFyIGxlbiA9IE1hdGgubWluKHgsIHkpXG4gIHdoaWxlIChpIDwgbGVuKSB7XG4gICAgaWYgKGFbaV0gIT09IGJbaV0pIGJyZWFrXG5cbiAgICArK2lcbiAgfVxuXG4gIGlmIChpICE9PSBsZW4pIHtcbiAgICB4ID0gYVtpXVxuICAgIHkgPSBiW2ldXG4gIH1cblxuICBpZiAoeCA8IHkpIHJldHVybiAtMVxuICBpZiAoeSA8IHgpIHJldHVybiAxXG4gIHJldHVybiAwXG59XG5cbkJ1ZmZlci5pc0VuY29kaW5nID0gZnVuY3Rpb24gaXNFbmNvZGluZyAoZW5jb2RpbmcpIHtcbiAgc3dpdGNoIChTdHJpbmcoZW5jb2RpbmcpLnRvTG93ZXJDYXNlKCkpIHtcbiAgICBjYXNlICdoZXgnOlxuICAgIGNhc2UgJ3V0ZjgnOlxuICAgIGNhc2UgJ3V0Zi04JzpcbiAgICBjYXNlICdhc2NpaSc6XG4gICAgY2FzZSAnYmluYXJ5JzpcbiAgICBjYXNlICdiYXNlNjQnOlxuICAgIGNhc2UgJ3Jhdyc6XG4gICAgY2FzZSAndWNzMic6XG4gICAgY2FzZSAndWNzLTInOlxuICAgIGNhc2UgJ3V0ZjE2bGUnOlxuICAgIGNhc2UgJ3V0Zi0xNmxlJzpcbiAgICAgIHJldHVybiB0cnVlXG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiBmYWxzZVxuICB9XG59XG5cbkJ1ZmZlci5jb25jYXQgPSBmdW5jdGlvbiBjb25jYXQgKGxpc3QsIGxlbmd0aCkge1xuICBpZiAoIWlzQXJyYXkobGlzdCkpIHRocm93IG5ldyBUeXBlRXJyb3IoJ2xpc3QgYXJndW1lbnQgbXVzdCBiZSBhbiBBcnJheSBvZiBCdWZmZXJzLicpXG5cbiAgaWYgKGxpc3QubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIG5ldyBCdWZmZXIoMClcbiAgfVxuXG4gIHZhciBpXG4gIGlmIChsZW5ndGggPT09IHVuZGVmaW5lZCkge1xuICAgIGxlbmd0aCA9IDBcbiAgICBmb3IgKGkgPSAwOyBpIDwgbGlzdC5sZW5ndGg7IGkrKykge1xuICAgICAgbGVuZ3RoICs9IGxpc3RbaV0ubGVuZ3RoXG4gICAgfVxuICB9XG5cbiAgdmFyIGJ1ZiA9IG5ldyBCdWZmZXIobGVuZ3RoKVxuICB2YXIgcG9zID0gMFxuICBmb3IgKGkgPSAwOyBpIDwgbGlzdC5sZW5ndGg7IGkrKykge1xuICAgIHZhciBpdGVtID0gbGlzdFtpXVxuICAgIGl0ZW0uY29weShidWYsIHBvcylcbiAgICBwb3MgKz0gaXRlbS5sZW5ndGhcbiAgfVxuICByZXR1cm4gYnVmXG59XG5cbmZ1bmN0aW9uIGJ5dGVMZW5ndGggKHN0cmluZywgZW5jb2RpbmcpIHtcbiAgaWYgKHR5cGVvZiBzdHJpbmcgIT09ICdzdHJpbmcnKSBzdHJpbmcgPSAnJyArIHN0cmluZ1xuXG4gIHZhciBsZW4gPSBzdHJpbmcubGVuZ3RoXG4gIGlmIChsZW4gPT09IDApIHJldHVybiAwXG5cbiAgLy8gVXNlIGEgZm9yIGxvb3AgdG8gYXZvaWQgcmVjdXJzaW9uXG4gIHZhciBsb3dlcmVkQ2FzZSA9IGZhbHNlXG4gIGZvciAoOzspIHtcbiAgICBzd2l0Y2ggKGVuY29kaW5nKSB7XG4gICAgICBjYXNlICdhc2NpaSc6XG4gICAgICBjYXNlICdiaW5hcnknOlxuICAgICAgLy8gRGVwcmVjYXRlZFxuICAgICAgY2FzZSAncmF3JzpcbiAgICAgIGNhc2UgJ3Jhd3MnOlxuICAgICAgICByZXR1cm4gbGVuXG4gICAgICBjYXNlICd1dGY4JzpcbiAgICAgIGNhc2UgJ3V0Zi04JzpcbiAgICAgICAgcmV0dXJuIHV0ZjhUb0J5dGVzKHN0cmluZykubGVuZ3RoXG4gICAgICBjYXNlICd1Y3MyJzpcbiAgICAgIGNhc2UgJ3Vjcy0yJzpcbiAgICAgIGNhc2UgJ3V0ZjE2bGUnOlxuICAgICAgY2FzZSAndXRmLTE2bGUnOlxuICAgICAgICByZXR1cm4gbGVuICogMlxuICAgICAgY2FzZSAnaGV4JzpcbiAgICAgICAgcmV0dXJuIGxlbiA+Pj4gMVxuICAgICAgY2FzZSAnYmFzZTY0JzpcbiAgICAgICAgcmV0dXJuIGJhc2U2NFRvQnl0ZXMoc3RyaW5nKS5sZW5ndGhcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIGlmIChsb3dlcmVkQ2FzZSkgcmV0dXJuIHV0ZjhUb0J5dGVzKHN0cmluZykubGVuZ3RoIC8vIGFzc3VtZSB1dGY4XG4gICAgICAgIGVuY29kaW5nID0gKCcnICsgZW5jb2RpbmcpLnRvTG93ZXJDYXNlKClcbiAgICAgICAgbG93ZXJlZENhc2UgPSB0cnVlXG4gICAgfVxuICB9XG59XG5CdWZmZXIuYnl0ZUxlbmd0aCA9IGJ5dGVMZW5ndGhcblxuLy8gcHJlLXNldCBmb3IgdmFsdWVzIHRoYXQgbWF5IGV4aXN0IGluIHRoZSBmdXR1cmVcbkJ1ZmZlci5wcm90b3R5cGUubGVuZ3RoID0gdW5kZWZpbmVkXG5CdWZmZXIucHJvdG90eXBlLnBhcmVudCA9IHVuZGVmaW5lZFxuXG5mdW5jdGlvbiBzbG93VG9TdHJpbmcgKGVuY29kaW5nLCBzdGFydCwgZW5kKSB7XG4gIHZhciBsb3dlcmVkQ2FzZSA9IGZhbHNlXG5cbiAgc3RhcnQgPSBzdGFydCB8IDBcbiAgZW5kID0gZW5kID09PSB1bmRlZmluZWQgfHwgZW5kID09PSBJbmZpbml0eSA/IHRoaXMubGVuZ3RoIDogZW5kIHwgMFxuXG4gIGlmICghZW5jb2RpbmcpIGVuY29kaW5nID0gJ3V0ZjgnXG4gIGlmIChzdGFydCA8IDApIHN0YXJ0ID0gMFxuICBpZiAoZW5kID4gdGhpcy5sZW5ndGgpIGVuZCA9IHRoaXMubGVuZ3RoXG4gIGlmIChlbmQgPD0gc3RhcnQpIHJldHVybiAnJ1xuXG4gIHdoaWxlICh0cnVlKSB7XG4gICAgc3dpdGNoIChlbmNvZGluZykge1xuICAgICAgY2FzZSAnaGV4JzpcbiAgICAgICAgcmV0dXJuIGhleFNsaWNlKHRoaXMsIHN0YXJ0LCBlbmQpXG5cbiAgICAgIGNhc2UgJ3V0ZjgnOlxuICAgICAgY2FzZSAndXRmLTgnOlxuICAgICAgICByZXR1cm4gdXRmOFNsaWNlKHRoaXMsIHN0YXJ0LCBlbmQpXG5cbiAgICAgIGNhc2UgJ2FzY2lpJzpcbiAgICAgICAgcmV0dXJuIGFzY2lpU2xpY2UodGhpcywgc3RhcnQsIGVuZClcblxuICAgICAgY2FzZSAnYmluYXJ5JzpcbiAgICAgICAgcmV0dXJuIGJpbmFyeVNsaWNlKHRoaXMsIHN0YXJ0LCBlbmQpXG5cbiAgICAgIGNhc2UgJ2Jhc2U2NCc6XG4gICAgICAgIHJldHVybiBiYXNlNjRTbGljZSh0aGlzLCBzdGFydCwgZW5kKVxuXG4gICAgICBjYXNlICd1Y3MyJzpcbiAgICAgIGNhc2UgJ3Vjcy0yJzpcbiAgICAgIGNhc2UgJ3V0ZjE2bGUnOlxuICAgICAgY2FzZSAndXRmLTE2bGUnOlxuICAgICAgICByZXR1cm4gdXRmMTZsZVNsaWNlKHRoaXMsIHN0YXJ0LCBlbmQpXG5cbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIGlmIChsb3dlcmVkQ2FzZSkgdGhyb3cgbmV3IFR5cGVFcnJvcignVW5rbm93biBlbmNvZGluZzogJyArIGVuY29kaW5nKVxuICAgICAgICBlbmNvZGluZyA9IChlbmNvZGluZyArICcnKS50b0xvd2VyQ2FzZSgpXG4gICAgICAgIGxvd2VyZWRDYXNlID0gdHJ1ZVxuICAgIH1cbiAgfVxufVxuXG5CdWZmZXIucHJvdG90eXBlLnRvU3RyaW5nID0gZnVuY3Rpb24gdG9TdHJpbmcgKCkge1xuICB2YXIgbGVuZ3RoID0gdGhpcy5sZW5ndGggfCAwXG4gIGlmIChsZW5ndGggPT09IDApIHJldHVybiAnJ1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHV0ZjhTbGljZSh0aGlzLCAwLCBsZW5ndGgpXG4gIHJldHVybiBzbG93VG9TdHJpbmcuYXBwbHkodGhpcywgYXJndW1lbnRzKVxufVxuXG5CdWZmZXIucHJvdG90eXBlLmVxdWFscyA9IGZ1bmN0aW9uIGVxdWFscyAoYikge1xuICBpZiAoIUJ1ZmZlci5pc0J1ZmZlcihiKSkgdGhyb3cgbmV3IFR5cGVFcnJvcignQXJndW1lbnQgbXVzdCBiZSBhIEJ1ZmZlcicpXG4gIGlmICh0aGlzID09PSBiKSByZXR1cm4gdHJ1ZVxuICByZXR1cm4gQnVmZmVyLmNvbXBhcmUodGhpcywgYikgPT09IDBcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5pbnNwZWN0ID0gZnVuY3Rpb24gaW5zcGVjdCAoKSB7XG4gIHZhciBzdHIgPSAnJ1xuICB2YXIgbWF4ID0gZXhwb3J0cy5JTlNQRUNUX01BWF9CWVRFU1xuICBpZiAodGhpcy5sZW5ndGggPiAwKSB7XG4gICAgc3RyID0gdGhpcy50b1N0cmluZygnaGV4JywgMCwgbWF4KS5tYXRjaCgvLnsyfS9nKS5qb2luKCcgJylcbiAgICBpZiAodGhpcy5sZW5ndGggPiBtYXgpIHN0ciArPSAnIC4uLiAnXG4gIH1cbiAgcmV0dXJuICc8QnVmZmVyICcgKyBzdHIgKyAnPidcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5jb21wYXJlID0gZnVuY3Rpb24gY29tcGFyZSAoYikge1xuICBpZiAoIUJ1ZmZlci5pc0J1ZmZlcihiKSkgdGhyb3cgbmV3IFR5cGVFcnJvcignQXJndW1lbnQgbXVzdCBiZSBhIEJ1ZmZlcicpXG4gIGlmICh0aGlzID09PSBiKSByZXR1cm4gMFxuICByZXR1cm4gQnVmZmVyLmNvbXBhcmUodGhpcywgYilcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5pbmRleE9mID0gZnVuY3Rpb24gaW5kZXhPZiAodmFsLCBieXRlT2Zmc2V0KSB7XG4gIGlmIChieXRlT2Zmc2V0ID4gMHg3ZmZmZmZmZikgYnl0ZU9mZnNldCA9IDB4N2ZmZmZmZmZcbiAgZWxzZSBpZiAoYnl0ZU9mZnNldCA8IC0weDgwMDAwMDAwKSBieXRlT2Zmc2V0ID0gLTB4ODAwMDAwMDBcbiAgYnl0ZU9mZnNldCA+Pj0gMFxuXG4gIGlmICh0aGlzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIC0xXG4gIGlmIChieXRlT2Zmc2V0ID49IHRoaXMubGVuZ3RoKSByZXR1cm4gLTFcblxuICAvLyBOZWdhdGl2ZSBvZmZzZXRzIHN0YXJ0IGZyb20gdGhlIGVuZCBvZiB0aGUgYnVmZmVyXG4gIGlmIChieXRlT2Zmc2V0IDwgMCkgYnl0ZU9mZnNldCA9IE1hdGgubWF4KHRoaXMubGVuZ3RoICsgYnl0ZU9mZnNldCwgMClcblxuICBpZiAodHlwZW9mIHZhbCA9PT0gJ3N0cmluZycpIHtcbiAgICBpZiAodmFsLmxlbmd0aCA9PT0gMCkgcmV0dXJuIC0xIC8vIHNwZWNpYWwgY2FzZTogbG9va2luZyBmb3IgZW1wdHkgc3RyaW5nIGFsd2F5cyBmYWlsc1xuICAgIHJldHVybiBTdHJpbmcucHJvdG90eXBlLmluZGV4T2YuY2FsbCh0aGlzLCB2YWwsIGJ5dGVPZmZzZXQpXG4gIH1cbiAgaWYgKEJ1ZmZlci5pc0J1ZmZlcih2YWwpKSB7XG4gICAgcmV0dXJuIGFycmF5SW5kZXhPZih0aGlzLCB2YWwsIGJ5dGVPZmZzZXQpXG4gIH1cbiAgaWYgKHR5cGVvZiB2YWwgPT09ICdudW1iZXInKSB7XG4gICAgaWYgKEJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUICYmIFVpbnQ4QXJyYXkucHJvdG90eXBlLmluZGV4T2YgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiBVaW50OEFycmF5LnByb3RvdHlwZS5pbmRleE9mLmNhbGwodGhpcywgdmFsLCBieXRlT2Zmc2V0KVxuICAgIH1cbiAgICByZXR1cm4gYXJyYXlJbmRleE9mKHRoaXMsIFsgdmFsIF0sIGJ5dGVPZmZzZXQpXG4gIH1cblxuICBmdW5jdGlvbiBhcnJheUluZGV4T2YgKGFyciwgdmFsLCBieXRlT2Zmc2V0KSB7XG4gICAgdmFyIGZvdW5kSW5kZXggPSAtMVxuICAgIGZvciAodmFyIGkgPSAwOyBieXRlT2Zmc2V0ICsgaSA8IGFyci5sZW5ndGg7IGkrKykge1xuICAgICAgaWYgKGFycltieXRlT2Zmc2V0ICsgaV0gPT09IHZhbFtmb3VuZEluZGV4ID09PSAtMSA/IDAgOiBpIC0gZm91bmRJbmRleF0pIHtcbiAgICAgICAgaWYgKGZvdW5kSW5kZXggPT09IC0xKSBmb3VuZEluZGV4ID0gaVxuICAgICAgICBpZiAoaSAtIGZvdW5kSW5kZXggKyAxID09PSB2YWwubGVuZ3RoKSByZXR1cm4gYnl0ZU9mZnNldCArIGZvdW5kSW5kZXhcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGZvdW5kSW5kZXggPSAtMVxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gLTFcbiAgfVxuXG4gIHRocm93IG5ldyBUeXBlRXJyb3IoJ3ZhbCBtdXN0IGJlIHN0cmluZywgbnVtYmVyIG9yIEJ1ZmZlcicpXG59XG5cbi8vIGBnZXRgIGlzIGRlcHJlY2F0ZWRcbkJ1ZmZlci5wcm90b3R5cGUuZ2V0ID0gZnVuY3Rpb24gZ2V0IChvZmZzZXQpIHtcbiAgY29uc29sZS5sb2coJy5nZXQoKSBpcyBkZXByZWNhdGVkLiBBY2Nlc3MgdXNpbmcgYXJyYXkgaW5kZXhlcyBpbnN0ZWFkLicpXG4gIHJldHVybiB0aGlzLnJlYWRVSW50OChvZmZzZXQpXG59XG5cbi8vIGBzZXRgIGlzIGRlcHJlY2F0ZWRcbkJ1ZmZlci5wcm90b3R5cGUuc2V0ID0gZnVuY3Rpb24gc2V0ICh2LCBvZmZzZXQpIHtcbiAgY29uc29sZS5sb2coJy5zZXQoKSBpcyBkZXByZWNhdGVkLiBBY2Nlc3MgdXNpbmcgYXJyYXkgaW5kZXhlcyBpbnN0ZWFkLicpXG4gIHJldHVybiB0aGlzLndyaXRlVUludDgodiwgb2Zmc2V0KVxufVxuXG5mdW5jdGlvbiBoZXhXcml0ZSAoYnVmLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKSB7XG4gIG9mZnNldCA9IE51bWJlcihvZmZzZXQpIHx8IDBcbiAgdmFyIHJlbWFpbmluZyA9IGJ1Zi5sZW5ndGggLSBvZmZzZXRcbiAgaWYgKCFsZW5ndGgpIHtcbiAgICBsZW5ndGggPSByZW1haW5pbmdcbiAgfSBlbHNlIHtcbiAgICBsZW5ndGggPSBOdW1iZXIobGVuZ3RoKVxuICAgIGlmIChsZW5ndGggPiByZW1haW5pbmcpIHtcbiAgICAgIGxlbmd0aCA9IHJlbWFpbmluZ1xuICAgIH1cbiAgfVxuXG4gIC8vIG11c3QgYmUgYW4gZXZlbiBudW1iZXIgb2YgZGlnaXRzXG4gIHZhciBzdHJMZW4gPSBzdHJpbmcubGVuZ3RoXG4gIGlmIChzdHJMZW4gJSAyICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgaGV4IHN0cmluZycpXG5cbiAgaWYgKGxlbmd0aCA+IHN0ckxlbiAvIDIpIHtcbiAgICBsZW5ndGggPSBzdHJMZW4gLyAyXG4gIH1cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW5ndGg7IGkrKykge1xuICAgIHZhciBwYXJzZWQgPSBwYXJzZUludChzdHJpbmcuc3Vic3RyKGkgKiAyLCAyKSwgMTYpXG4gICAgaWYgKGlzTmFOKHBhcnNlZCkpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBoZXggc3RyaW5nJylcbiAgICBidWZbb2Zmc2V0ICsgaV0gPSBwYXJzZWRcbiAgfVxuICByZXR1cm4gaVxufVxuXG5mdW5jdGlvbiB1dGY4V3JpdGUgKGJ1Ziwgc3RyaW5nLCBvZmZzZXQsIGxlbmd0aCkge1xuICByZXR1cm4gYmxpdEJ1ZmZlcih1dGY4VG9CeXRlcyhzdHJpbmcsIGJ1Zi5sZW5ndGggLSBvZmZzZXQpLCBidWYsIG9mZnNldCwgbGVuZ3RoKVxufVxuXG5mdW5jdGlvbiBhc2NpaVdyaXRlIChidWYsIHN0cmluZywgb2Zmc2V0LCBsZW5ndGgpIHtcbiAgcmV0dXJuIGJsaXRCdWZmZXIoYXNjaWlUb0J5dGVzKHN0cmluZyksIGJ1Ziwgb2Zmc2V0LCBsZW5ndGgpXG59XG5cbmZ1bmN0aW9uIGJpbmFyeVdyaXRlIChidWYsIHN0cmluZywgb2Zmc2V0LCBsZW5ndGgpIHtcbiAgcmV0dXJuIGFzY2lpV3JpdGUoYnVmLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKVxufVxuXG5mdW5jdGlvbiBiYXNlNjRXcml0ZSAoYnVmLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKSB7XG4gIHJldHVybiBibGl0QnVmZmVyKGJhc2U2NFRvQnl0ZXMoc3RyaW5nKSwgYnVmLCBvZmZzZXQsIGxlbmd0aClcbn1cblxuZnVuY3Rpb24gdWNzMldyaXRlIChidWYsIHN0cmluZywgb2Zmc2V0LCBsZW5ndGgpIHtcbiAgcmV0dXJuIGJsaXRCdWZmZXIodXRmMTZsZVRvQnl0ZXMoc3RyaW5nLCBidWYubGVuZ3RoIC0gb2Zmc2V0KSwgYnVmLCBvZmZzZXQsIGxlbmd0aClcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZSA9IGZ1bmN0aW9uIHdyaXRlIChzdHJpbmcsIG9mZnNldCwgbGVuZ3RoLCBlbmNvZGluZykge1xuICAvLyBCdWZmZXIjd3JpdGUoc3RyaW5nKVxuICBpZiAob2Zmc2V0ID09PSB1bmRlZmluZWQpIHtcbiAgICBlbmNvZGluZyA9ICd1dGY4J1xuICAgIGxlbmd0aCA9IHRoaXMubGVuZ3RoXG4gICAgb2Zmc2V0ID0gMFxuICAvLyBCdWZmZXIjd3JpdGUoc3RyaW5nLCBlbmNvZGluZylcbiAgfSBlbHNlIGlmIChsZW5ndGggPT09IHVuZGVmaW5lZCAmJiB0eXBlb2Ygb2Zmc2V0ID09PSAnc3RyaW5nJykge1xuICAgIGVuY29kaW5nID0gb2Zmc2V0XG4gICAgbGVuZ3RoID0gdGhpcy5sZW5ndGhcbiAgICBvZmZzZXQgPSAwXG4gIC8vIEJ1ZmZlciN3cml0ZShzdHJpbmcsIG9mZnNldFssIGxlbmd0aF1bLCBlbmNvZGluZ10pXG4gIH0gZWxzZSBpZiAoaXNGaW5pdGUob2Zmc2V0KSkge1xuICAgIG9mZnNldCA9IG9mZnNldCB8IDBcbiAgICBpZiAoaXNGaW5pdGUobGVuZ3RoKSkge1xuICAgICAgbGVuZ3RoID0gbGVuZ3RoIHwgMFxuICAgICAgaWYgKGVuY29kaW5nID09PSB1bmRlZmluZWQpIGVuY29kaW5nID0gJ3V0ZjgnXG4gICAgfSBlbHNlIHtcbiAgICAgIGVuY29kaW5nID0gbGVuZ3RoXG4gICAgICBsZW5ndGggPSB1bmRlZmluZWRcbiAgICB9XG4gIC8vIGxlZ2FjeSB3cml0ZShzdHJpbmcsIGVuY29kaW5nLCBvZmZzZXQsIGxlbmd0aCkgLSByZW1vdmUgaW4gdjAuMTNcbiAgfSBlbHNlIHtcbiAgICB2YXIgc3dhcCA9IGVuY29kaW5nXG4gICAgZW5jb2RpbmcgPSBvZmZzZXRcbiAgICBvZmZzZXQgPSBsZW5ndGggfCAwXG4gICAgbGVuZ3RoID0gc3dhcFxuICB9XG5cbiAgdmFyIHJlbWFpbmluZyA9IHRoaXMubGVuZ3RoIC0gb2Zmc2V0XG4gIGlmIChsZW5ndGggPT09IHVuZGVmaW5lZCB8fCBsZW5ndGggPiByZW1haW5pbmcpIGxlbmd0aCA9IHJlbWFpbmluZ1xuXG4gIGlmICgoc3RyaW5nLmxlbmd0aCA+IDAgJiYgKGxlbmd0aCA8IDAgfHwgb2Zmc2V0IDwgMCkpIHx8IG9mZnNldCA+IHRoaXMubGVuZ3RoKSB7XG4gICAgdGhyb3cgbmV3IFJhbmdlRXJyb3IoJ2F0dGVtcHQgdG8gd3JpdGUgb3V0c2lkZSBidWZmZXIgYm91bmRzJylcbiAgfVxuXG4gIGlmICghZW5jb2RpbmcpIGVuY29kaW5nID0gJ3V0ZjgnXG5cbiAgdmFyIGxvd2VyZWRDYXNlID0gZmFsc2VcbiAgZm9yICg7Oykge1xuICAgIHN3aXRjaCAoZW5jb2RpbmcpIHtcbiAgICAgIGNhc2UgJ2hleCc6XG4gICAgICAgIHJldHVybiBoZXhXcml0ZSh0aGlzLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKVxuXG4gICAgICBjYXNlICd1dGY4JzpcbiAgICAgIGNhc2UgJ3V0Zi04JzpcbiAgICAgICAgcmV0dXJuIHV0ZjhXcml0ZSh0aGlzLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKVxuXG4gICAgICBjYXNlICdhc2NpaSc6XG4gICAgICAgIHJldHVybiBhc2NpaVdyaXRlKHRoaXMsIHN0cmluZywgb2Zmc2V0LCBsZW5ndGgpXG5cbiAgICAgIGNhc2UgJ2JpbmFyeSc6XG4gICAgICAgIHJldHVybiBiaW5hcnlXcml0ZSh0aGlzLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKVxuXG4gICAgICBjYXNlICdiYXNlNjQnOlxuICAgICAgICAvLyBXYXJuaW5nOiBtYXhMZW5ndGggbm90IHRha2VuIGludG8gYWNjb3VudCBpbiBiYXNlNjRXcml0ZVxuICAgICAgICByZXR1cm4gYmFzZTY0V3JpdGUodGhpcywgc3RyaW5nLCBvZmZzZXQsIGxlbmd0aClcblxuICAgICAgY2FzZSAndWNzMic6XG4gICAgICBjYXNlICd1Y3MtMic6XG4gICAgICBjYXNlICd1dGYxNmxlJzpcbiAgICAgIGNhc2UgJ3V0Zi0xNmxlJzpcbiAgICAgICAgcmV0dXJuIHVjczJXcml0ZSh0aGlzLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKVxuXG4gICAgICBkZWZhdWx0OlxuICAgICAgICBpZiAobG93ZXJlZENhc2UpIHRocm93IG5ldyBUeXBlRXJyb3IoJ1Vua25vd24gZW5jb2Rpbmc6ICcgKyBlbmNvZGluZylcbiAgICAgICAgZW5jb2RpbmcgPSAoJycgKyBlbmNvZGluZykudG9Mb3dlckNhc2UoKVxuICAgICAgICBsb3dlcmVkQ2FzZSA9IHRydWVcbiAgICB9XG4gIH1cbn1cblxuQnVmZmVyLnByb3RvdHlwZS50b0pTT04gPSBmdW5jdGlvbiB0b0pTT04gKCkge1xuICByZXR1cm4ge1xuICAgIHR5cGU6ICdCdWZmZXInLFxuICAgIGRhdGE6IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKHRoaXMuX2FyciB8fCB0aGlzLCAwKVxuICB9XG59XG5cbmZ1bmN0aW9uIGJhc2U2NFNsaWNlIChidWYsIHN0YXJ0LCBlbmQpIHtcbiAgaWYgKHN0YXJ0ID09PSAwICYmIGVuZCA9PT0gYnVmLmxlbmd0aCkge1xuICAgIHJldHVybiBiYXNlNjQuZnJvbUJ5dGVBcnJheShidWYpXG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIGJhc2U2NC5mcm9tQnl0ZUFycmF5KGJ1Zi5zbGljZShzdGFydCwgZW5kKSlcbiAgfVxufVxuXG5mdW5jdGlvbiB1dGY4U2xpY2UgKGJ1Ziwgc3RhcnQsIGVuZCkge1xuICBlbmQgPSBNYXRoLm1pbihidWYubGVuZ3RoLCBlbmQpXG4gIHZhciByZXMgPSBbXVxuXG4gIHZhciBpID0gc3RhcnRcbiAgd2hpbGUgKGkgPCBlbmQpIHtcbiAgICB2YXIgZmlyc3RCeXRlID0gYnVmW2ldXG4gICAgdmFyIGNvZGVQb2ludCA9IG51bGxcbiAgICB2YXIgYnl0ZXNQZXJTZXF1ZW5jZSA9IChmaXJzdEJ5dGUgPiAweEVGKSA/IDRcbiAgICAgIDogKGZpcnN0Qnl0ZSA+IDB4REYpID8gM1xuICAgICAgOiAoZmlyc3RCeXRlID4gMHhCRikgPyAyXG4gICAgICA6IDFcblxuICAgIGlmIChpICsgYnl0ZXNQZXJTZXF1ZW5jZSA8PSBlbmQpIHtcbiAgICAgIHZhciBzZWNvbmRCeXRlLCB0aGlyZEJ5dGUsIGZvdXJ0aEJ5dGUsIHRlbXBDb2RlUG9pbnRcblxuICAgICAgc3dpdGNoIChieXRlc1BlclNlcXVlbmNlKSB7XG4gICAgICAgIGNhc2UgMTpcbiAgICAgICAgICBpZiAoZmlyc3RCeXRlIDwgMHg4MCkge1xuICAgICAgICAgICAgY29kZVBvaW50ID0gZmlyc3RCeXRlXG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrXG4gICAgICAgIGNhc2UgMjpcbiAgICAgICAgICBzZWNvbmRCeXRlID0gYnVmW2kgKyAxXVxuICAgICAgICAgIGlmICgoc2Vjb25kQnl0ZSAmIDB4QzApID09PSAweDgwKSB7XG4gICAgICAgICAgICB0ZW1wQ29kZVBvaW50ID0gKGZpcnN0Qnl0ZSAmIDB4MUYpIDw8IDB4NiB8IChzZWNvbmRCeXRlICYgMHgzRilcbiAgICAgICAgICAgIGlmICh0ZW1wQ29kZVBvaW50ID4gMHg3Rikge1xuICAgICAgICAgICAgICBjb2RlUG9pbnQgPSB0ZW1wQ29kZVBvaW50XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrXG4gICAgICAgIGNhc2UgMzpcbiAgICAgICAgICBzZWNvbmRCeXRlID0gYnVmW2kgKyAxXVxuICAgICAgICAgIHRoaXJkQnl0ZSA9IGJ1ZltpICsgMl1cbiAgICAgICAgICBpZiAoKHNlY29uZEJ5dGUgJiAweEMwKSA9PT0gMHg4MCAmJiAodGhpcmRCeXRlICYgMHhDMCkgPT09IDB4ODApIHtcbiAgICAgICAgICAgIHRlbXBDb2RlUG9pbnQgPSAoZmlyc3RCeXRlICYgMHhGKSA8PCAweEMgfCAoc2Vjb25kQnl0ZSAmIDB4M0YpIDw8IDB4NiB8ICh0aGlyZEJ5dGUgJiAweDNGKVxuICAgICAgICAgICAgaWYgKHRlbXBDb2RlUG9pbnQgPiAweDdGRiAmJiAodGVtcENvZGVQb2ludCA8IDB4RDgwMCB8fCB0ZW1wQ29kZVBvaW50ID4gMHhERkZGKSkge1xuICAgICAgICAgICAgICBjb2RlUG9pbnQgPSB0ZW1wQ29kZVBvaW50XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrXG4gICAgICAgIGNhc2UgNDpcbiAgICAgICAgICBzZWNvbmRCeXRlID0gYnVmW2kgKyAxXVxuICAgICAgICAgIHRoaXJkQnl0ZSA9IGJ1ZltpICsgMl1cbiAgICAgICAgICBmb3VydGhCeXRlID0gYnVmW2kgKyAzXVxuICAgICAgICAgIGlmICgoc2Vjb25kQnl0ZSAmIDB4QzApID09PSAweDgwICYmICh0aGlyZEJ5dGUgJiAweEMwKSA9PT0gMHg4MCAmJiAoZm91cnRoQnl0ZSAmIDB4QzApID09PSAweDgwKSB7XG4gICAgICAgICAgICB0ZW1wQ29kZVBvaW50ID0gKGZpcnN0Qnl0ZSAmIDB4RikgPDwgMHgxMiB8IChzZWNvbmRCeXRlICYgMHgzRikgPDwgMHhDIHwgKHRoaXJkQnl0ZSAmIDB4M0YpIDw8IDB4NiB8IChmb3VydGhCeXRlICYgMHgzRilcbiAgICAgICAgICAgIGlmICh0ZW1wQ29kZVBvaW50ID4gMHhGRkZGICYmIHRlbXBDb2RlUG9pbnQgPCAweDExMDAwMCkge1xuICAgICAgICAgICAgICBjb2RlUG9pbnQgPSB0ZW1wQ29kZVBvaW50XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChjb2RlUG9pbnQgPT09IG51bGwpIHtcbiAgICAgIC8vIHdlIGRpZCBub3QgZ2VuZXJhdGUgYSB2YWxpZCBjb2RlUG9pbnQgc28gaW5zZXJ0IGFcbiAgICAgIC8vIHJlcGxhY2VtZW50IGNoYXIgKFUrRkZGRCkgYW5kIGFkdmFuY2Ugb25seSAxIGJ5dGVcbiAgICAgIGNvZGVQb2ludCA9IDB4RkZGRFxuICAgICAgYnl0ZXNQZXJTZXF1ZW5jZSA9IDFcbiAgICB9IGVsc2UgaWYgKGNvZGVQb2ludCA+IDB4RkZGRikge1xuICAgICAgLy8gZW5jb2RlIHRvIHV0ZjE2IChzdXJyb2dhdGUgcGFpciBkYW5jZSlcbiAgICAgIGNvZGVQb2ludCAtPSAweDEwMDAwXG4gICAgICByZXMucHVzaChjb2RlUG9pbnQgPj4+IDEwICYgMHgzRkYgfCAweEQ4MDApXG4gICAgICBjb2RlUG9pbnQgPSAweERDMDAgfCBjb2RlUG9pbnQgJiAweDNGRlxuICAgIH1cblxuICAgIHJlcy5wdXNoKGNvZGVQb2ludClcbiAgICBpICs9IGJ5dGVzUGVyU2VxdWVuY2VcbiAgfVxuXG4gIHJldHVybiBkZWNvZGVDb2RlUG9pbnRzQXJyYXkocmVzKVxufVxuXG4vLyBCYXNlZCBvbiBodHRwOi8vc3RhY2tvdmVyZmxvdy5jb20vYS8yMjc0NzI3Mi82ODA3NDIsIHRoZSBicm93c2VyIHdpdGhcbi8vIHRoZSBsb3dlc3QgbGltaXQgaXMgQ2hyb21lLCB3aXRoIDB4MTAwMDAgYXJncy5cbi8vIFdlIGdvIDEgbWFnbml0dWRlIGxlc3MsIGZvciBzYWZldHlcbnZhciBNQVhfQVJHVU1FTlRTX0xFTkdUSCA9IDB4MTAwMFxuXG5mdW5jdGlvbiBkZWNvZGVDb2RlUG9pbnRzQXJyYXkgKGNvZGVQb2ludHMpIHtcbiAgdmFyIGxlbiA9IGNvZGVQb2ludHMubGVuZ3RoXG4gIGlmIChsZW4gPD0gTUFYX0FSR1VNRU5UU19MRU5HVEgpIHtcbiAgICByZXR1cm4gU3RyaW5nLmZyb21DaGFyQ29kZS5hcHBseShTdHJpbmcsIGNvZGVQb2ludHMpIC8vIGF2b2lkIGV4dHJhIHNsaWNlKClcbiAgfVxuXG4gIC8vIERlY29kZSBpbiBjaHVua3MgdG8gYXZvaWQgXCJjYWxsIHN0YWNrIHNpemUgZXhjZWVkZWRcIi5cbiAgdmFyIHJlcyA9ICcnXG4gIHZhciBpID0gMFxuICB3aGlsZSAoaSA8IGxlbikge1xuICAgIHJlcyArPSBTdHJpbmcuZnJvbUNoYXJDb2RlLmFwcGx5KFxuICAgICAgU3RyaW5nLFxuICAgICAgY29kZVBvaW50cy5zbGljZShpLCBpICs9IE1BWF9BUkdVTUVOVFNfTEVOR1RIKVxuICAgIClcbiAgfVxuICByZXR1cm4gcmVzXG59XG5cbmZ1bmN0aW9uIGFzY2lpU2xpY2UgKGJ1Ziwgc3RhcnQsIGVuZCkge1xuICB2YXIgcmV0ID0gJydcbiAgZW5kID0gTWF0aC5taW4oYnVmLmxlbmd0aCwgZW5kKVxuXG4gIGZvciAodmFyIGkgPSBzdGFydDsgaSA8IGVuZDsgaSsrKSB7XG4gICAgcmV0ICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYnVmW2ldICYgMHg3RilcbiAgfVxuICByZXR1cm4gcmV0XG59XG5cbmZ1bmN0aW9uIGJpbmFyeVNsaWNlIChidWYsIHN0YXJ0LCBlbmQpIHtcbiAgdmFyIHJldCA9ICcnXG4gIGVuZCA9IE1hdGgubWluKGJ1Zi5sZW5ndGgsIGVuZClcblxuICBmb3IgKHZhciBpID0gc3RhcnQ7IGkgPCBlbmQ7IGkrKykge1xuICAgIHJldCArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGJ1ZltpXSlcbiAgfVxuICByZXR1cm4gcmV0XG59XG5cbmZ1bmN0aW9uIGhleFNsaWNlIChidWYsIHN0YXJ0LCBlbmQpIHtcbiAgdmFyIGxlbiA9IGJ1Zi5sZW5ndGhcblxuICBpZiAoIXN0YXJ0IHx8IHN0YXJ0IDwgMCkgc3RhcnQgPSAwXG4gIGlmICghZW5kIHx8IGVuZCA8IDAgfHwgZW5kID4gbGVuKSBlbmQgPSBsZW5cblxuICB2YXIgb3V0ID0gJydcbiAgZm9yICh2YXIgaSA9IHN0YXJ0OyBpIDwgZW5kOyBpKyspIHtcbiAgICBvdXQgKz0gdG9IZXgoYnVmW2ldKVxuICB9XG4gIHJldHVybiBvdXRcbn1cblxuZnVuY3Rpb24gdXRmMTZsZVNsaWNlIChidWYsIHN0YXJ0LCBlbmQpIHtcbiAgdmFyIGJ5dGVzID0gYnVmLnNsaWNlKHN0YXJ0LCBlbmQpXG4gIHZhciByZXMgPSAnJ1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAyKSB7XG4gICAgcmVzICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYnl0ZXNbaV0gKyBieXRlc1tpICsgMV0gKiAyNTYpXG4gIH1cbiAgcmV0dXJuIHJlc1xufVxuXG5CdWZmZXIucHJvdG90eXBlLnNsaWNlID0gZnVuY3Rpb24gc2xpY2UgKHN0YXJ0LCBlbmQpIHtcbiAgdmFyIGxlbiA9IHRoaXMubGVuZ3RoXG4gIHN0YXJ0ID0gfn5zdGFydFxuICBlbmQgPSBlbmQgPT09IHVuZGVmaW5lZCA/IGxlbiA6IH5+ZW5kXG5cbiAgaWYgKHN0YXJ0IDwgMCkge1xuICAgIHN0YXJ0ICs9IGxlblxuICAgIGlmIChzdGFydCA8IDApIHN0YXJ0ID0gMFxuICB9IGVsc2UgaWYgKHN0YXJ0ID4gbGVuKSB7XG4gICAgc3RhcnQgPSBsZW5cbiAgfVxuXG4gIGlmIChlbmQgPCAwKSB7XG4gICAgZW5kICs9IGxlblxuICAgIGlmIChlbmQgPCAwKSBlbmQgPSAwXG4gIH0gZWxzZSBpZiAoZW5kID4gbGVuKSB7XG4gICAgZW5kID0gbGVuXG4gIH1cblxuICBpZiAoZW5kIDwgc3RhcnQpIGVuZCA9IHN0YXJ0XG5cbiAgdmFyIG5ld0J1ZlxuICBpZiAoQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHtcbiAgICBuZXdCdWYgPSBCdWZmZXIuX2F1Z21lbnQodGhpcy5zdWJhcnJheShzdGFydCwgZW5kKSlcbiAgfSBlbHNlIHtcbiAgICB2YXIgc2xpY2VMZW4gPSBlbmQgLSBzdGFydFxuICAgIG5ld0J1ZiA9IG5ldyBCdWZmZXIoc2xpY2VMZW4sIHVuZGVmaW5lZClcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHNsaWNlTGVuOyBpKyspIHtcbiAgICAgIG5ld0J1ZltpXSA9IHRoaXNbaSArIHN0YXJ0XVxuICAgIH1cbiAgfVxuXG4gIGlmIChuZXdCdWYubGVuZ3RoKSBuZXdCdWYucGFyZW50ID0gdGhpcy5wYXJlbnQgfHwgdGhpc1xuXG4gIHJldHVybiBuZXdCdWZcbn1cblxuLypcbiAqIE5lZWQgdG8gbWFrZSBzdXJlIHRoYXQgYnVmZmVyIGlzbid0IHRyeWluZyB0byB3cml0ZSBvdXQgb2YgYm91bmRzLlxuICovXG5mdW5jdGlvbiBjaGVja09mZnNldCAob2Zmc2V0LCBleHQsIGxlbmd0aCkge1xuICBpZiAoKG9mZnNldCAlIDEpICE9PSAwIHx8IG9mZnNldCA8IDApIHRocm93IG5ldyBSYW5nZUVycm9yKCdvZmZzZXQgaXMgbm90IHVpbnQnKVxuICBpZiAob2Zmc2V0ICsgZXh0ID4gbGVuZ3RoKSB0aHJvdyBuZXcgUmFuZ2VFcnJvcignVHJ5aW5nIHRvIGFjY2VzcyBiZXlvbmQgYnVmZmVyIGxlbmd0aCcpXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZFVJbnRMRSA9IGZ1bmN0aW9uIHJlYWRVSW50TEUgKG9mZnNldCwgYnl0ZUxlbmd0aCwgbm9Bc3NlcnQpIHtcbiAgb2Zmc2V0ID0gb2Zmc2V0IHwgMFxuICBieXRlTGVuZ3RoID0gYnl0ZUxlbmd0aCB8IDBcbiAgaWYgKCFub0Fzc2VydCkgY2hlY2tPZmZzZXQob2Zmc2V0LCBieXRlTGVuZ3RoLCB0aGlzLmxlbmd0aClcblxuICB2YXIgdmFsID0gdGhpc1tvZmZzZXRdXG4gIHZhciBtdWwgPSAxXG4gIHZhciBpID0gMFxuICB3aGlsZSAoKytpIDwgYnl0ZUxlbmd0aCAmJiAobXVsICo9IDB4MTAwKSkge1xuICAgIHZhbCArPSB0aGlzW29mZnNldCArIGldICogbXVsXG4gIH1cblxuICByZXR1cm4gdmFsXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZFVJbnRCRSA9IGZ1bmN0aW9uIHJlYWRVSW50QkUgKG9mZnNldCwgYnl0ZUxlbmd0aCwgbm9Bc3NlcnQpIHtcbiAgb2Zmc2V0ID0gb2Zmc2V0IHwgMFxuICBieXRlTGVuZ3RoID0gYnl0ZUxlbmd0aCB8IDBcbiAgaWYgKCFub0Fzc2VydCkge1xuICAgIGNoZWNrT2Zmc2V0KG9mZnNldCwgYnl0ZUxlbmd0aCwgdGhpcy5sZW5ndGgpXG4gIH1cblxuICB2YXIgdmFsID0gdGhpc1tvZmZzZXQgKyAtLWJ5dGVMZW5ndGhdXG4gIHZhciBtdWwgPSAxXG4gIHdoaWxlIChieXRlTGVuZ3RoID4gMCAmJiAobXVsICo9IDB4MTAwKSkge1xuICAgIHZhbCArPSB0aGlzW29mZnNldCArIC0tYnl0ZUxlbmd0aF0gKiBtdWxcbiAgfVxuXG4gIHJldHVybiB2YWxcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5yZWFkVUludDggPSBmdW5jdGlvbiByZWFkVUludDggKG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydCkgY2hlY2tPZmZzZXQob2Zmc2V0LCAxLCB0aGlzLmxlbmd0aClcbiAgcmV0dXJuIHRoaXNbb2Zmc2V0XVxufVxuXG5CdWZmZXIucHJvdG90eXBlLnJlYWRVSW50MTZMRSA9IGZ1bmN0aW9uIHJlYWRVSW50MTZMRSAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KSBjaGVja09mZnNldChvZmZzZXQsIDIsIHRoaXMubGVuZ3RoKVxuICByZXR1cm4gdGhpc1tvZmZzZXRdIHwgKHRoaXNbb2Zmc2V0ICsgMV0gPDwgOClcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5yZWFkVUludDE2QkUgPSBmdW5jdGlvbiByZWFkVUludDE2QkUgKG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydCkgY2hlY2tPZmZzZXQob2Zmc2V0LCAyLCB0aGlzLmxlbmd0aClcbiAgcmV0dXJuICh0aGlzW29mZnNldF0gPDwgOCkgfCB0aGlzW29mZnNldCArIDFdXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZFVJbnQzMkxFID0gZnVuY3Rpb24gcmVhZFVJbnQzMkxFIChvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIGlmICghbm9Bc3NlcnQpIGNoZWNrT2Zmc2V0KG9mZnNldCwgNCwgdGhpcy5sZW5ndGgpXG5cbiAgcmV0dXJuICgodGhpc1tvZmZzZXRdKSB8XG4gICAgICAodGhpc1tvZmZzZXQgKyAxXSA8PCA4KSB8XG4gICAgICAodGhpc1tvZmZzZXQgKyAyXSA8PCAxNikpICtcbiAgICAgICh0aGlzW29mZnNldCArIDNdICogMHgxMDAwMDAwKVxufVxuXG5CdWZmZXIucHJvdG90eXBlLnJlYWRVSW50MzJCRSA9IGZ1bmN0aW9uIHJlYWRVSW50MzJCRSAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KSBjaGVja09mZnNldChvZmZzZXQsIDQsIHRoaXMubGVuZ3RoKVxuXG4gIHJldHVybiAodGhpc1tvZmZzZXRdICogMHgxMDAwMDAwKSArXG4gICAgKCh0aGlzW29mZnNldCArIDFdIDw8IDE2KSB8XG4gICAgKHRoaXNbb2Zmc2V0ICsgMl0gPDwgOCkgfFxuICAgIHRoaXNbb2Zmc2V0ICsgM10pXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZEludExFID0gZnVuY3Rpb24gcmVhZEludExFIChvZmZzZXQsIGJ5dGVMZW5ndGgsIG5vQXNzZXJ0KSB7XG4gIG9mZnNldCA9IG9mZnNldCB8IDBcbiAgYnl0ZUxlbmd0aCA9IGJ5dGVMZW5ndGggfCAwXG4gIGlmICghbm9Bc3NlcnQpIGNoZWNrT2Zmc2V0KG9mZnNldCwgYnl0ZUxlbmd0aCwgdGhpcy5sZW5ndGgpXG5cbiAgdmFyIHZhbCA9IHRoaXNbb2Zmc2V0XVxuICB2YXIgbXVsID0gMVxuICB2YXIgaSA9IDBcbiAgd2hpbGUgKCsraSA8IGJ5dGVMZW5ndGggJiYgKG11bCAqPSAweDEwMCkpIHtcbiAgICB2YWwgKz0gdGhpc1tvZmZzZXQgKyBpXSAqIG11bFxuICB9XG4gIG11bCAqPSAweDgwXG5cbiAgaWYgKHZhbCA+PSBtdWwpIHZhbCAtPSBNYXRoLnBvdygyLCA4ICogYnl0ZUxlbmd0aClcblxuICByZXR1cm4gdmFsXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZEludEJFID0gZnVuY3Rpb24gcmVhZEludEJFIChvZmZzZXQsIGJ5dGVMZW5ndGgsIG5vQXNzZXJ0KSB7XG4gIG9mZnNldCA9IG9mZnNldCB8IDBcbiAgYnl0ZUxlbmd0aCA9IGJ5dGVMZW5ndGggfCAwXG4gIGlmICghbm9Bc3NlcnQpIGNoZWNrT2Zmc2V0KG9mZnNldCwgYnl0ZUxlbmd0aCwgdGhpcy5sZW5ndGgpXG5cbiAgdmFyIGkgPSBieXRlTGVuZ3RoXG4gIHZhciBtdWwgPSAxXG4gIHZhciB2YWwgPSB0aGlzW29mZnNldCArIC0taV1cbiAgd2hpbGUgKGkgPiAwICYmIChtdWwgKj0gMHgxMDApKSB7XG4gICAgdmFsICs9IHRoaXNbb2Zmc2V0ICsgLS1pXSAqIG11bFxuICB9XG4gIG11bCAqPSAweDgwXG5cbiAgaWYgKHZhbCA+PSBtdWwpIHZhbCAtPSBNYXRoLnBvdygyLCA4ICogYnl0ZUxlbmd0aClcblxuICByZXR1cm4gdmFsXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZEludDggPSBmdW5jdGlvbiByZWFkSW50OCAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KSBjaGVja09mZnNldChvZmZzZXQsIDEsIHRoaXMubGVuZ3RoKVxuICBpZiAoISh0aGlzW29mZnNldF0gJiAweDgwKSkgcmV0dXJuICh0aGlzW29mZnNldF0pXG4gIHJldHVybiAoKDB4ZmYgLSB0aGlzW29mZnNldF0gKyAxKSAqIC0xKVxufVxuXG5CdWZmZXIucHJvdG90eXBlLnJlYWRJbnQxNkxFID0gZnVuY3Rpb24gcmVhZEludDE2TEUgKG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydCkgY2hlY2tPZmZzZXQob2Zmc2V0LCAyLCB0aGlzLmxlbmd0aClcbiAgdmFyIHZhbCA9IHRoaXNbb2Zmc2V0XSB8ICh0aGlzW29mZnNldCArIDFdIDw8IDgpXG4gIHJldHVybiAodmFsICYgMHg4MDAwKSA/IHZhbCB8IDB4RkZGRjAwMDAgOiB2YWxcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5yZWFkSW50MTZCRSA9IGZ1bmN0aW9uIHJlYWRJbnQxNkJFIChvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIGlmICghbm9Bc3NlcnQpIGNoZWNrT2Zmc2V0KG9mZnNldCwgMiwgdGhpcy5sZW5ndGgpXG4gIHZhciB2YWwgPSB0aGlzW29mZnNldCArIDFdIHwgKHRoaXNbb2Zmc2V0XSA8PCA4KVxuICByZXR1cm4gKHZhbCAmIDB4ODAwMCkgPyB2YWwgfCAweEZGRkYwMDAwIDogdmFsXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZEludDMyTEUgPSBmdW5jdGlvbiByZWFkSW50MzJMRSAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KSBjaGVja09mZnNldChvZmZzZXQsIDQsIHRoaXMubGVuZ3RoKVxuXG4gIHJldHVybiAodGhpc1tvZmZzZXRdKSB8XG4gICAgKHRoaXNbb2Zmc2V0ICsgMV0gPDwgOCkgfFxuICAgICh0aGlzW29mZnNldCArIDJdIDw8IDE2KSB8XG4gICAgKHRoaXNbb2Zmc2V0ICsgM10gPDwgMjQpXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZEludDMyQkUgPSBmdW5jdGlvbiByZWFkSW50MzJCRSAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KSBjaGVja09mZnNldChvZmZzZXQsIDQsIHRoaXMubGVuZ3RoKVxuXG4gIHJldHVybiAodGhpc1tvZmZzZXRdIDw8IDI0KSB8XG4gICAgKHRoaXNbb2Zmc2V0ICsgMV0gPDwgMTYpIHxcbiAgICAodGhpc1tvZmZzZXQgKyAyXSA8PCA4KSB8XG4gICAgKHRoaXNbb2Zmc2V0ICsgM10pXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZEZsb2F0TEUgPSBmdW5jdGlvbiByZWFkRmxvYXRMRSAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KSBjaGVja09mZnNldChvZmZzZXQsIDQsIHRoaXMubGVuZ3RoKVxuICByZXR1cm4gaWVlZTc1NC5yZWFkKHRoaXMsIG9mZnNldCwgdHJ1ZSwgMjMsIDQpXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZEZsb2F0QkUgPSBmdW5jdGlvbiByZWFkRmxvYXRCRSAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KSBjaGVja09mZnNldChvZmZzZXQsIDQsIHRoaXMubGVuZ3RoKVxuICByZXR1cm4gaWVlZTc1NC5yZWFkKHRoaXMsIG9mZnNldCwgZmFsc2UsIDIzLCA0KVxufVxuXG5CdWZmZXIucHJvdG90eXBlLnJlYWREb3VibGVMRSA9IGZ1bmN0aW9uIHJlYWREb3VibGVMRSAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KSBjaGVja09mZnNldChvZmZzZXQsIDgsIHRoaXMubGVuZ3RoKVxuICByZXR1cm4gaWVlZTc1NC5yZWFkKHRoaXMsIG9mZnNldCwgdHJ1ZSwgNTIsIDgpXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZERvdWJsZUJFID0gZnVuY3Rpb24gcmVhZERvdWJsZUJFIChvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIGlmICghbm9Bc3NlcnQpIGNoZWNrT2Zmc2V0KG9mZnNldCwgOCwgdGhpcy5sZW5ndGgpXG4gIHJldHVybiBpZWVlNzU0LnJlYWQodGhpcywgb2Zmc2V0LCBmYWxzZSwgNTIsIDgpXG59XG5cbmZ1bmN0aW9uIGNoZWNrSW50IChidWYsIHZhbHVlLCBvZmZzZXQsIGV4dCwgbWF4LCBtaW4pIHtcbiAgaWYgKCFCdWZmZXIuaXNCdWZmZXIoYnVmKSkgdGhyb3cgbmV3IFR5cGVFcnJvcignYnVmZmVyIG11c3QgYmUgYSBCdWZmZXIgaW5zdGFuY2UnKVxuICBpZiAodmFsdWUgPiBtYXggfHwgdmFsdWUgPCBtaW4pIHRocm93IG5ldyBSYW5nZUVycm9yKCd2YWx1ZSBpcyBvdXQgb2YgYm91bmRzJylcbiAgaWYgKG9mZnNldCArIGV4dCA+IGJ1Zi5sZW5ndGgpIHRocm93IG5ldyBSYW5nZUVycm9yKCdpbmRleCBvdXQgb2YgcmFuZ2UnKVxufVxuXG5CdWZmZXIucHJvdG90eXBlLndyaXRlVUludExFID0gZnVuY3Rpb24gd3JpdGVVSW50TEUgKHZhbHVlLCBvZmZzZXQsIGJ5dGVMZW5ndGgsIG5vQXNzZXJ0KSB7XG4gIHZhbHVlID0gK3ZhbHVlXG4gIG9mZnNldCA9IG9mZnNldCB8IDBcbiAgYnl0ZUxlbmd0aCA9IGJ5dGVMZW5ndGggfCAwXG4gIGlmICghbm9Bc3NlcnQpIGNoZWNrSW50KHRoaXMsIHZhbHVlLCBvZmZzZXQsIGJ5dGVMZW5ndGgsIE1hdGgucG93KDIsIDggKiBieXRlTGVuZ3RoKSwgMClcblxuICB2YXIgbXVsID0gMVxuICB2YXIgaSA9IDBcbiAgdGhpc1tvZmZzZXRdID0gdmFsdWUgJiAweEZGXG4gIHdoaWxlICgrK2kgPCBieXRlTGVuZ3RoICYmIChtdWwgKj0gMHgxMDApKSB7XG4gICAgdGhpc1tvZmZzZXQgKyBpXSA9ICh2YWx1ZSAvIG11bCkgJiAweEZGXG4gIH1cblxuICByZXR1cm4gb2Zmc2V0ICsgYnl0ZUxlbmd0aFxufVxuXG5CdWZmZXIucHJvdG90eXBlLndyaXRlVUludEJFID0gZnVuY3Rpb24gd3JpdGVVSW50QkUgKHZhbHVlLCBvZmZzZXQsIGJ5dGVMZW5ndGgsIG5vQXNzZXJ0KSB7XG4gIHZhbHVlID0gK3ZhbHVlXG4gIG9mZnNldCA9IG9mZnNldCB8IDBcbiAgYnl0ZUxlbmd0aCA9IGJ5dGVMZW5ndGggfCAwXG4gIGlmICghbm9Bc3NlcnQpIGNoZWNrSW50KHRoaXMsIHZhbHVlLCBvZmZzZXQsIGJ5dGVMZW5ndGgsIE1hdGgucG93KDIsIDggKiBieXRlTGVuZ3RoKSwgMClcblxuICB2YXIgaSA9IGJ5dGVMZW5ndGggLSAxXG4gIHZhciBtdWwgPSAxXG4gIHRoaXNbb2Zmc2V0ICsgaV0gPSB2YWx1ZSAmIDB4RkZcbiAgd2hpbGUgKC0taSA+PSAwICYmIChtdWwgKj0gMHgxMDApKSB7XG4gICAgdGhpc1tvZmZzZXQgKyBpXSA9ICh2YWx1ZSAvIG11bCkgJiAweEZGXG4gIH1cblxuICByZXR1cm4gb2Zmc2V0ICsgYnl0ZUxlbmd0aFxufVxuXG5CdWZmZXIucHJvdG90eXBlLndyaXRlVUludDggPSBmdW5jdGlvbiB3cml0ZVVJbnQ4ICh2YWx1ZSwgb2Zmc2V0LCBub0Fzc2VydCkge1xuICB2YWx1ZSA9ICt2YWx1ZVxuICBvZmZzZXQgPSBvZmZzZXQgfCAwXG4gIGlmICghbm9Bc3NlcnQpIGNoZWNrSW50KHRoaXMsIHZhbHVlLCBvZmZzZXQsIDEsIDB4ZmYsIDApXG4gIGlmICghQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHZhbHVlID0gTWF0aC5mbG9vcih2YWx1ZSlcbiAgdGhpc1tvZmZzZXRdID0gKHZhbHVlICYgMHhmZilcbiAgcmV0dXJuIG9mZnNldCArIDFcbn1cblxuZnVuY3Rpb24gb2JqZWN0V3JpdGVVSW50MTYgKGJ1ZiwgdmFsdWUsIG9mZnNldCwgbGl0dGxlRW5kaWFuKSB7XG4gIGlmICh2YWx1ZSA8IDApIHZhbHVlID0gMHhmZmZmICsgdmFsdWUgKyAxXG4gIGZvciAodmFyIGkgPSAwLCBqID0gTWF0aC5taW4oYnVmLmxlbmd0aCAtIG9mZnNldCwgMik7IGkgPCBqOyBpKyspIHtcbiAgICBidWZbb2Zmc2V0ICsgaV0gPSAodmFsdWUgJiAoMHhmZiA8PCAoOCAqIChsaXR0bGVFbmRpYW4gPyBpIDogMSAtIGkpKSkpID4+PlxuICAgICAgKGxpdHRsZUVuZGlhbiA/IGkgOiAxIC0gaSkgKiA4XG4gIH1cbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZVVJbnQxNkxFID0gZnVuY3Rpb24gd3JpdGVVSW50MTZMRSAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgdmFsdWUgPSArdmFsdWVcbiAgb2Zmc2V0ID0gb2Zmc2V0IHwgMFxuICBpZiAoIW5vQXNzZXJ0KSBjaGVja0ludCh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCAyLCAweGZmZmYsIDApXG4gIGlmIChCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkge1xuICAgIHRoaXNbb2Zmc2V0XSA9ICh2YWx1ZSAmIDB4ZmYpXG4gICAgdGhpc1tvZmZzZXQgKyAxXSA9ICh2YWx1ZSA+Pj4gOClcbiAgfSBlbHNlIHtcbiAgICBvYmplY3RXcml0ZVVJbnQxNih0aGlzLCB2YWx1ZSwgb2Zmc2V0LCB0cnVlKVxuICB9XG4gIHJldHVybiBvZmZzZXQgKyAyXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUud3JpdGVVSW50MTZCRSA9IGZ1bmN0aW9uIHdyaXRlVUludDE2QkUgKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHZhbHVlID0gK3ZhbHVlXG4gIG9mZnNldCA9IG9mZnNldCB8IDBcbiAgaWYgKCFub0Fzc2VydCkgY2hlY2tJbnQodGhpcywgdmFsdWUsIG9mZnNldCwgMiwgMHhmZmZmLCAwKVxuICBpZiAoQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHtcbiAgICB0aGlzW29mZnNldF0gPSAodmFsdWUgPj4+IDgpXG4gICAgdGhpc1tvZmZzZXQgKyAxXSA9ICh2YWx1ZSAmIDB4ZmYpXG4gIH0gZWxzZSB7XG4gICAgb2JqZWN0V3JpdGVVSW50MTYodGhpcywgdmFsdWUsIG9mZnNldCwgZmFsc2UpXG4gIH1cbiAgcmV0dXJuIG9mZnNldCArIDJcbn1cblxuZnVuY3Rpb24gb2JqZWN0V3JpdGVVSW50MzIgKGJ1ZiwgdmFsdWUsIG9mZnNldCwgbGl0dGxlRW5kaWFuKSB7XG4gIGlmICh2YWx1ZSA8IDApIHZhbHVlID0gMHhmZmZmZmZmZiArIHZhbHVlICsgMVxuICBmb3IgKHZhciBpID0gMCwgaiA9IE1hdGgubWluKGJ1Zi5sZW5ndGggLSBvZmZzZXQsIDQpOyBpIDwgajsgaSsrKSB7XG4gICAgYnVmW29mZnNldCArIGldID0gKHZhbHVlID4+PiAobGl0dGxlRW5kaWFuID8gaSA6IDMgLSBpKSAqIDgpICYgMHhmZlxuICB9XG59XG5cbkJ1ZmZlci5wcm90b3R5cGUud3JpdGVVSW50MzJMRSA9IGZ1bmN0aW9uIHdyaXRlVUludDMyTEUgKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHZhbHVlID0gK3ZhbHVlXG4gIG9mZnNldCA9IG9mZnNldCB8IDBcbiAgaWYgKCFub0Fzc2VydCkgY2hlY2tJbnQodGhpcywgdmFsdWUsIG9mZnNldCwgNCwgMHhmZmZmZmZmZiwgMClcbiAgaWYgKEJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUKSB7XG4gICAgdGhpc1tvZmZzZXQgKyAzXSA9ICh2YWx1ZSA+Pj4gMjQpXG4gICAgdGhpc1tvZmZzZXQgKyAyXSA9ICh2YWx1ZSA+Pj4gMTYpXG4gICAgdGhpc1tvZmZzZXQgKyAxXSA9ICh2YWx1ZSA+Pj4gOClcbiAgICB0aGlzW29mZnNldF0gPSAodmFsdWUgJiAweGZmKVxuICB9IGVsc2Uge1xuICAgIG9iamVjdFdyaXRlVUludDMyKHRoaXMsIHZhbHVlLCBvZmZzZXQsIHRydWUpXG4gIH1cbiAgcmV0dXJuIG9mZnNldCArIDRcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZVVJbnQzMkJFID0gZnVuY3Rpb24gd3JpdGVVSW50MzJCRSAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgdmFsdWUgPSArdmFsdWVcbiAgb2Zmc2V0ID0gb2Zmc2V0IHwgMFxuICBpZiAoIW5vQXNzZXJ0KSBjaGVja0ludCh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCA0LCAweGZmZmZmZmZmLCAwKVxuICBpZiAoQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHtcbiAgICB0aGlzW29mZnNldF0gPSAodmFsdWUgPj4+IDI0KVxuICAgIHRoaXNbb2Zmc2V0ICsgMV0gPSAodmFsdWUgPj4+IDE2KVxuICAgIHRoaXNbb2Zmc2V0ICsgMl0gPSAodmFsdWUgPj4+IDgpXG4gICAgdGhpc1tvZmZzZXQgKyAzXSA9ICh2YWx1ZSAmIDB4ZmYpXG4gIH0gZWxzZSB7XG4gICAgb2JqZWN0V3JpdGVVSW50MzIodGhpcywgdmFsdWUsIG9mZnNldCwgZmFsc2UpXG4gIH1cbiAgcmV0dXJuIG9mZnNldCArIDRcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZUludExFID0gZnVuY3Rpb24gd3JpdGVJbnRMRSAodmFsdWUsIG9mZnNldCwgYnl0ZUxlbmd0aCwgbm9Bc3NlcnQpIHtcbiAgdmFsdWUgPSArdmFsdWVcbiAgb2Zmc2V0ID0gb2Zmc2V0IHwgMFxuICBpZiAoIW5vQXNzZXJ0KSB7XG4gICAgdmFyIGxpbWl0ID0gTWF0aC5wb3coMiwgOCAqIGJ5dGVMZW5ndGggLSAxKVxuXG4gICAgY2hlY2tJbnQodGhpcywgdmFsdWUsIG9mZnNldCwgYnl0ZUxlbmd0aCwgbGltaXQgLSAxLCAtbGltaXQpXG4gIH1cblxuICB2YXIgaSA9IDBcbiAgdmFyIG11bCA9IDFcbiAgdmFyIHN1YiA9IHZhbHVlIDwgMCA/IDEgOiAwXG4gIHRoaXNbb2Zmc2V0XSA9IHZhbHVlICYgMHhGRlxuICB3aGlsZSAoKytpIDwgYnl0ZUxlbmd0aCAmJiAobXVsICo9IDB4MTAwKSkge1xuICAgIHRoaXNbb2Zmc2V0ICsgaV0gPSAoKHZhbHVlIC8gbXVsKSA+PiAwKSAtIHN1YiAmIDB4RkZcbiAgfVxuXG4gIHJldHVybiBvZmZzZXQgKyBieXRlTGVuZ3RoXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUud3JpdGVJbnRCRSA9IGZ1bmN0aW9uIHdyaXRlSW50QkUgKHZhbHVlLCBvZmZzZXQsIGJ5dGVMZW5ndGgsIG5vQXNzZXJ0KSB7XG4gIHZhbHVlID0gK3ZhbHVlXG4gIG9mZnNldCA9IG9mZnNldCB8IDBcbiAgaWYgKCFub0Fzc2VydCkge1xuICAgIHZhciBsaW1pdCA9IE1hdGgucG93KDIsIDggKiBieXRlTGVuZ3RoIC0gMSlcblxuICAgIGNoZWNrSW50KHRoaXMsIHZhbHVlLCBvZmZzZXQsIGJ5dGVMZW5ndGgsIGxpbWl0IC0gMSwgLWxpbWl0KVxuICB9XG5cbiAgdmFyIGkgPSBieXRlTGVuZ3RoIC0gMVxuICB2YXIgbXVsID0gMVxuICB2YXIgc3ViID0gdmFsdWUgPCAwID8gMSA6IDBcbiAgdGhpc1tvZmZzZXQgKyBpXSA9IHZhbHVlICYgMHhGRlxuICB3aGlsZSAoLS1pID49IDAgJiYgKG11bCAqPSAweDEwMCkpIHtcbiAgICB0aGlzW29mZnNldCArIGldID0gKCh2YWx1ZSAvIG11bCkgPj4gMCkgLSBzdWIgJiAweEZGXG4gIH1cblxuICByZXR1cm4gb2Zmc2V0ICsgYnl0ZUxlbmd0aFxufVxuXG5CdWZmZXIucHJvdG90eXBlLndyaXRlSW50OCA9IGZ1bmN0aW9uIHdyaXRlSW50OCAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgdmFsdWUgPSArdmFsdWVcbiAgb2Zmc2V0ID0gb2Zmc2V0IHwgMFxuICBpZiAoIW5vQXNzZXJ0KSBjaGVja0ludCh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCAxLCAweDdmLCAtMHg4MClcbiAgaWYgKCFCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkgdmFsdWUgPSBNYXRoLmZsb29yKHZhbHVlKVxuICBpZiAodmFsdWUgPCAwKSB2YWx1ZSA9IDB4ZmYgKyB2YWx1ZSArIDFcbiAgdGhpc1tvZmZzZXRdID0gKHZhbHVlICYgMHhmZilcbiAgcmV0dXJuIG9mZnNldCArIDFcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZUludDE2TEUgPSBmdW5jdGlvbiB3cml0ZUludDE2TEUgKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHZhbHVlID0gK3ZhbHVlXG4gIG9mZnNldCA9IG9mZnNldCB8IDBcbiAgaWYgKCFub0Fzc2VydCkgY2hlY2tJbnQodGhpcywgdmFsdWUsIG9mZnNldCwgMiwgMHg3ZmZmLCAtMHg4MDAwKVxuICBpZiAoQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHtcbiAgICB0aGlzW29mZnNldF0gPSAodmFsdWUgJiAweGZmKVxuICAgIHRoaXNbb2Zmc2V0ICsgMV0gPSAodmFsdWUgPj4+IDgpXG4gIH0gZWxzZSB7XG4gICAgb2JqZWN0V3JpdGVVSW50MTYodGhpcywgdmFsdWUsIG9mZnNldCwgdHJ1ZSlcbiAgfVxuICByZXR1cm4gb2Zmc2V0ICsgMlxufVxuXG5CdWZmZXIucHJvdG90eXBlLndyaXRlSW50MTZCRSA9IGZ1bmN0aW9uIHdyaXRlSW50MTZCRSAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgdmFsdWUgPSArdmFsdWVcbiAgb2Zmc2V0ID0gb2Zmc2V0IHwgMFxuICBpZiAoIW5vQXNzZXJ0KSBjaGVja0ludCh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCAyLCAweDdmZmYsIC0weDgwMDApXG4gIGlmIChCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkge1xuICAgIHRoaXNbb2Zmc2V0XSA9ICh2YWx1ZSA+Pj4gOClcbiAgICB0aGlzW29mZnNldCArIDFdID0gKHZhbHVlICYgMHhmZilcbiAgfSBlbHNlIHtcbiAgICBvYmplY3RXcml0ZVVJbnQxNih0aGlzLCB2YWx1ZSwgb2Zmc2V0LCBmYWxzZSlcbiAgfVxuICByZXR1cm4gb2Zmc2V0ICsgMlxufVxuXG5CdWZmZXIucHJvdG90eXBlLndyaXRlSW50MzJMRSA9IGZ1bmN0aW9uIHdyaXRlSW50MzJMRSAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgdmFsdWUgPSArdmFsdWVcbiAgb2Zmc2V0ID0gb2Zmc2V0IHwgMFxuICBpZiAoIW5vQXNzZXJ0KSBjaGVja0ludCh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCA0LCAweDdmZmZmZmZmLCAtMHg4MDAwMDAwMClcbiAgaWYgKEJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUKSB7XG4gICAgdGhpc1tvZmZzZXRdID0gKHZhbHVlICYgMHhmZilcbiAgICB0aGlzW29mZnNldCArIDFdID0gKHZhbHVlID4+PiA4KVxuICAgIHRoaXNbb2Zmc2V0ICsgMl0gPSAodmFsdWUgPj4+IDE2KVxuICAgIHRoaXNbb2Zmc2V0ICsgM10gPSAodmFsdWUgPj4+IDI0KVxuICB9IGVsc2Uge1xuICAgIG9iamVjdFdyaXRlVUludDMyKHRoaXMsIHZhbHVlLCBvZmZzZXQsIHRydWUpXG4gIH1cbiAgcmV0dXJuIG9mZnNldCArIDRcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZUludDMyQkUgPSBmdW5jdGlvbiB3cml0ZUludDMyQkUgKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHZhbHVlID0gK3ZhbHVlXG4gIG9mZnNldCA9IG9mZnNldCB8IDBcbiAgaWYgKCFub0Fzc2VydCkgY2hlY2tJbnQodGhpcywgdmFsdWUsIG9mZnNldCwgNCwgMHg3ZmZmZmZmZiwgLTB4ODAwMDAwMDApXG4gIGlmICh2YWx1ZSA8IDApIHZhbHVlID0gMHhmZmZmZmZmZiArIHZhbHVlICsgMVxuICBpZiAoQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHtcbiAgICB0aGlzW29mZnNldF0gPSAodmFsdWUgPj4+IDI0KVxuICAgIHRoaXNbb2Zmc2V0ICsgMV0gPSAodmFsdWUgPj4+IDE2KVxuICAgIHRoaXNbb2Zmc2V0ICsgMl0gPSAodmFsdWUgPj4+IDgpXG4gICAgdGhpc1tvZmZzZXQgKyAzXSA9ICh2YWx1ZSAmIDB4ZmYpXG4gIH0gZWxzZSB7XG4gICAgb2JqZWN0V3JpdGVVSW50MzIodGhpcywgdmFsdWUsIG9mZnNldCwgZmFsc2UpXG4gIH1cbiAgcmV0dXJuIG9mZnNldCArIDRcbn1cblxuZnVuY3Rpb24gY2hlY2tJRUVFNzU0IChidWYsIHZhbHVlLCBvZmZzZXQsIGV4dCwgbWF4LCBtaW4pIHtcbiAgaWYgKHZhbHVlID4gbWF4IHx8IHZhbHVlIDwgbWluKSB0aHJvdyBuZXcgUmFuZ2VFcnJvcigndmFsdWUgaXMgb3V0IG9mIGJvdW5kcycpXG4gIGlmIChvZmZzZXQgKyBleHQgPiBidWYubGVuZ3RoKSB0aHJvdyBuZXcgUmFuZ2VFcnJvcignaW5kZXggb3V0IG9mIHJhbmdlJylcbiAgaWYgKG9mZnNldCA8IDApIHRocm93IG5ldyBSYW5nZUVycm9yKCdpbmRleCBvdXQgb2YgcmFuZ2UnKVxufVxuXG5mdW5jdGlvbiB3cml0ZUZsb2F0IChidWYsIHZhbHVlLCBvZmZzZXQsIGxpdHRsZUVuZGlhbiwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydCkge1xuICAgIGNoZWNrSUVFRTc1NChidWYsIHZhbHVlLCBvZmZzZXQsIDQsIDMuNDAyODIzNDY2Mzg1Mjg4NmUrMzgsIC0zLjQwMjgyMzQ2NjM4NTI4ODZlKzM4KVxuICB9XG4gIGllZWU3NTQud3JpdGUoYnVmLCB2YWx1ZSwgb2Zmc2V0LCBsaXR0bGVFbmRpYW4sIDIzLCA0KVxuICByZXR1cm4gb2Zmc2V0ICsgNFxufVxuXG5CdWZmZXIucHJvdG90eXBlLndyaXRlRmxvYXRMRSA9IGZ1bmN0aW9uIHdyaXRlRmxvYXRMRSAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgcmV0dXJuIHdyaXRlRmxvYXQodGhpcywgdmFsdWUsIG9mZnNldCwgdHJ1ZSwgbm9Bc3NlcnQpXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUud3JpdGVGbG9hdEJFID0gZnVuY3Rpb24gd3JpdGVGbG9hdEJFICh2YWx1ZSwgb2Zmc2V0LCBub0Fzc2VydCkge1xuICByZXR1cm4gd3JpdGVGbG9hdCh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCBmYWxzZSwgbm9Bc3NlcnQpXG59XG5cbmZ1bmN0aW9uIHdyaXRlRG91YmxlIChidWYsIHZhbHVlLCBvZmZzZXQsIGxpdHRsZUVuZGlhbiwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydCkge1xuICAgIGNoZWNrSUVFRTc1NChidWYsIHZhbHVlLCBvZmZzZXQsIDgsIDEuNzk3NjkzMTM0ODYyMzE1N0UrMzA4LCAtMS43OTc2OTMxMzQ4NjIzMTU3RSszMDgpXG4gIH1cbiAgaWVlZTc1NC53cml0ZShidWYsIHZhbHVlLCBvZmZzZXQsIGxpdHRsZUVuZGlhbiwgNTIsIDgpXG4gIHJldHVybiBvZmZzZXQgKyA4XG59XG5cbkJ1ZmZlci5wcm90b3R5cGUud3JpdGVEb3VibGVMRSA9IGZ1bmN0aW9uIHdyaXRlRG91YmxlTEUgKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHJldHVybiB3cml0ZURvdWJsZSh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCB0cnVlLCBub0Fzc2VydClcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZURvdWJsZUJFID0gZnVuY3Rpb24gd3JpdGVEb3VibGVCRSAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgcmV0dXJuIHdyaXRlRG91YmxlKHRoaXMsIHZhbHVlLCBvZmZzZXQsIGZhbHNlLCBub0Fzc2VydClcbn1cblxuLy8gY29weSh0YXJnZXRCdWZmZXIsIHRhcmdldFN0YXJ0PTAsIHNvdXJjZVN0YXJ0PTAsIHNvdXJjZUVuZD1idWZmZXIubGVuZ3RoKVxuQnVmZmVyLnByb3RvdHlwZS5jb3B5ID0gZnVuY3Rpb24gY29weSAodGFyZ2V0LCB0YXJnZXRTdGFydCwgc3RhcnQsIGVuZCkge1xuICBpZiAoIXN0YXJ0KSBzdGFydCA9IDBcbiAgaWYgKCFlbmQgJiYgZW5kICE9PSAwKSBlbmQgPSB0aGlzLmxlbmd0aFxuICBpZiAodGFyZ2V0U3RhcnQgPj0gdGFyZ2V0Lmxlbmd0aCkgdGFyZ2V0U3RhcnQgPSB0YXJnZXQubGVuZ3RoXG4gIGlmICghdGFyZ2V0U3RhcnQpIHRhcmdldFN0YXJ0ID0gMFxuICBpZiAoZW5kID4gMCAmJiBlbmQgPCBzdGFydCkgZW5kID0gc3RhcnRcblxuICAvLyBDb3B5IDAgYnl0ZXM7IHdlJ3JlIGRvbmVcbiAgaWYgKGVuZCA9PT0gc3RhcnQpIHJldHVybiAwXG4gIGlmICh0YXJnZXQubGVuZ3RoID09PSAwIHx8IHRoaXMubGVuZ3RoID09PSAwKSByZXR1cm4gMFxuXG4gIC8vIEZhdGFsIGVycm9yIGNvbmRpdGlvbnNcbiAgaWYgKHRhcmdldFN0YXJ0IDwgMCkge1xuICAgIHRocm93IG5ldyBSYW5nZUVycm9yKCd0YXJnZXRTdGFydCBvdXQgb2YgYm91bmRzJylcbiAgfVxuICBpZiAoc3RhcnQgPCAwIHx8IHN0YXJ0ID49IHRoaXMubGVuZ3RoKSB0aHJvdyBuZXcgUmFuZ2VFcnJvcignc291cmNlU3RhcnQgb3V0IG9mIGJvdW5kcycpXG4gIGlmIChlbmQgPCAwKSB0aHJvdyBuZXcgUmFuZ2VFcnJvcignc291cmNlRW5kIG91dCBvZiBib3VuZHMnKVxuXG4gIC8vIEFyZSB3ZSBvb2I/XG4gIGlmIChlbmQgPiB0aGlzLmxlbmd0aCkgZW5kID0gdGhpcy5sZW5ndGhcbiAgaWYgKHRhcmdldC5sZW5ndGggLSB0YXJnZXRTdGFydCA8IGVuZCAtIHN0YXJ0KSB7XG4gICAgZW5kID0gdGFyZ2V0Lmxlbmd0aCAtIHRhcmdldFN0YXJ0ICsgc3RhcnRcbiAgfVxuXG4gIHZhciBsZW4gPSBlbmQgLSBzdGFydFxuICB2YXIgaVxuXG4gIGlmICh0aGlzID09PSB0YXJnZXQgJiYgc3RhcnQgPCB0YXJnZXRTdGFydCAmJiB0YXJnZXRTdGFydCA8IGVuZCkge1xuICAgIC8vIGRlc2NlbmRpbmcgY29weSBmcm9tIGVuZFxuICAgIGZvciAoaSA9IGxlbiAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgICB0YXJnZXRbaSArIHRhcmdldFN0YXJ0XSA9IHRoaXNbaSArIHN0YXJ0XVxuICAgIH1cbiAgfSBlbHNlIGlmIChsZW4gPCAxMDAwIHx8ICFCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkge1xuICAgIC8vIGFzY2VuZGluZyBjb3B5IGZyb20gc3RhcnRcbiAgICBmb3IgKGkgPSAwOyBpIDwgbGVuOyBpKyspIHtcbiAgICAgIHRhcmdldFtpICsgdGFyZ2V0U3RhcnRdID0gdGhpc1tpICsgc3RhcnRdXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHRhcmdldC5fc2V0KHRoaXMuc3ViYXJyYXkoc3RhcnQsIHN0YXJ0ICsgbGVuKSwgdGFyZ2V0U3RhcnQpXG4gIH1cblxuICByZXR1cm4gbGVuXG59XG5cbi8vIGZpbGwodmFsdWUsIHN0YXJ0PTAsIGVuZD1idWZmZXIubGVuZ3RoKVxuQnVmZmVyLnByb3RvdHlwZS5maWxsID0gZnVuY3Rpb24gZmlsbCAodmFsdWUsIHN0YXJ0LCBlbmQpIHtcbiAgaWYgKCF2YWx1ZSkgdmFsdWUgPSAwXG4gIGlmICghc3RhcnQpIHN0YXJ0ID0gMFxuICBpZiAoIWVuZCkgZW5kID0gdGhpcy5sZW5ndGhcblxuICBpZiAoZW5kIDwgc3RhcnQpIHRocm93IG5ldyBSYW5nZUVycm9yKCdlbmQgPCBzdGFydCcpXG5cbiAgLy8gRmlsbCAwIGJ5dGVzOyB3ZSdyZSBkb25lXG4gIGlmIChlbmQgPT09IHN0YXJ0KSByZXR1cm5cbiAgaWYgKHRoaXMubGVuZ3RoID09PSAwKSByZXR1cm5cblxuICBpZiAoc3RhcnQgPCAwIHx8IHN0YXJ0ID49IHRoaXMubGVuZ3RoKSB0aHJvdyBuZXcgUmFuZ2VFcnJvcignc3RhcnQgb3V0IG9mIGJvdW5kcycpXG4gIGlmIChlbmQgPCAwIHx8IGVuZCA+IHRoaXMubGVuZ3RoKSB0aHJvdyBuZXcgUmFuZ2VFcnJvcignZW5kIG91dCBvZiBib3VuZHMnKVxuXG4gIHZhciBpXG4gIGlmICh0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInKSB7XG4gICAgZm9yIChpID0gc3RhcnQ7IGkgPCBlbmQ7IGkrKykge1xuICAgICAgdGhpc1tpXSA9IHZhbHVlXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHZhciBieXRlcyA9IHV0ZjhUb0J5dGVzKHZhbHVlLnRvU3RyaW5nKCkpXG4gICAgdmFyIGxlbiA9IGJ5dGVzLmxlbmd0aFxuICAgIGZvciAoaSA9IHN0YXJ0OyBpIDwgZW5kOyBpKyspIHtcbiAgICAgIHRoaXNbaV0gPSBieXRlc1tpICUgbGVuXVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB0aGlzXG59XG5cbi8qKlxuICogQ3JlYXRlcyBhIG5ldyBgQXJyYXlCdWZmZXJgIHdpdGggdGhlICpjb3BpZWQqIG1lbW9yeSBvZiB0aGUgYnVmZmVyIGluc3RhbmNlLlxuICogQWRkZWQgaW4gTm9kZSAwLjEyLiBPbmx5IGF2YWlsYWJsZSBpbiBicm93c2VycyB0aGF0IHN1cHBvcnQgQXJyYXlCdWZmZXIuXG4gKi9cbkJ1ZmZlci5wcm90b3R5cGUudG9BcnJheUJ1ZmZlciA9IGZ1bmN0aW9uIHRvQXJyYXlCdWZmZXIgKCkge1xuICBpZiAodHlwZW9mIFVpbnQ4QXJyYXkgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgaWYgKEJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUKSB7XG4gICAgICByZXR1cm4gKG5ldyBCdWZmZXIodGhpcykpLmJ1ZmZlclxuICAgIH0gZWxzZSB7XG4gICAgICB2YXIgYnVmID0gbmV3IFVpbnQ4QXJyYXkodGhpcy5sZW5ndGgpXG4gICAgICBmb3IgKHZhciBpID0gMCwgbGVuID0gYnVmLmxlbmd0aDsgaSA8IGxlbjsgaSArPSAxKSB7XG4gICAgICAgIGJ1ZltpXSA9IHRoaXNbaV1cbiAgICAgIH1cbiAgICAgIHJldHVybiBidWYuYnVmZmVyXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0J1ZmZlci50b0FycmF5QnVmZmVyIG5vdCBzdXBwb3J0ZWQgaW4gdGhpcyBicm93c2VyJylcbiAgfVxufVxuXG4vLyBIRUxQRVIgRlVOQ1RJT05TXG4vLyA9PT09PT09PT09PT09PT09XG5cbnZhciBCUCA9IEJ1ZmZlci5wcm90b3R5cGVcblxuLyoqXG4gKiBBdWdtZW50IGEgVWludDhBcnJheSAqaW5zdGFuY2UqIChub3QgdGhlIFVpbnQ4QXJyYXkgY2xhc3MhKSB3aXRoIEJ1ZmZlciBtZXRob2RzXG4gKi9cbkJ1ZmZlci5fYXVnbWVudCA9IGZ1bmN0aW9uIF9hdWdtZW50IChhcnIpIHtcbiAgYXJyLmNvbnN0cnVjdG9yID0gQnVmZmVyXG4gIGFyci5faXNCdWZmZXIgPSB0cnVlXG5cbiAgLy8gc2F2ZSByZWZlcmVuY2UgdG8gb3JpZ2luYWwgVWludDhBcnJheSBzZXQgbWV0aG9kIGJlZm9yZSBvdmVyd3JpdGluZ1xuICBhcnIuX3NldCA9IGFyci5zZXRcblxuICAvLyBkZXByZWNhdGVkXG4gIGFyci5nZXQgPSBCUC5nZXRcbiAgYXJyLnNldCA9IEJQLnNldFxuXG4gIGFyci53cml0ZSA9IEJQLndyaXRlXG4gIGFyci50b1N0cmluZyA9IEJQLnRvU3RyaW5nXG4gIGFyci50b0xvY2FsZVN0cmluZyA9IEJQLnRvU3RyaW5nXG4gIGFyci50b0pTT04gPSBCUC50b0pTT05cbiAgYXJyLmVxdWFscyA9IEJQLmVxdWFsc1xuICBhcnIuY29tcGFyZSA9IEJQLmNvbXBhcmVcbiAgYXJyLmluZGV4T2YgPSBCUC5pbmRleE9mXG4gIGFyci5jb3B5ID0gQlAuY29weVxuICBhcnIuc2xpY2UgPSBCUC5zbGljZVxuICBhcnIucmVhZFVJbnRMRSA9IEJQLnJlYWRVSW50TEVcbiAgYXJyLnJlYWRVSW50QkUgPSBCUC5yZWFkVUludEJFXG4gIGFyci5yZWFkVUludDggPSBCUC5yZWFkVUludDhcbiAgYXJyLnJlYWRVSW50MTZMRSA9IEJQLnJlYWRVSW50MTZMRVxuICBhcnIucmVhZFVJbnQxNkJFID0gQlAucmVhZFVJbnQxNkJFXG4gIGFyci5yZWFkVUludDMyTEUgPSBCUC5yZWFkVUludDMyTEVcbiAgYXJyLnJlYWRVSW50MzJCRSA9IEJQLnJlYWRVSW50MzJCRVxuICBhcnIucmVhZEludExFID0gQlAucmVhZEludExFXG4gIGFyci5yZWFkSW50QkUgPSBCUC5yZWFkSW50QkVcbiAgYXJyLnJlYWRJbnQ4ID0gQlAucmVhZEludDhcbiAgYXJyLnJlYWRJbnQxNkxFID0gQlAucmVhZEludDE2TEVcbiAgYXJyLnJlYWRJbnQxNkJFID0gQlAucmVhZEludDE2QkVcbiAgYXJyLnJlYWRJbnQzMkxFID0gQlAucmVhZEludDMyTEVcbiAgYXJyLnJlYWRJbnQzMkJFID0gQlAucmVhZEludDMyQkVcbiAgYXJyLnJlYWRGbG9hdExFID0gQlAucmVhZEZsb2F0TEVcbiAgYXJyLnJlYWRGbG9hdEJFID0gQlAucmVhZEZsb2F0QkVcbiAgYXJyLnJlYWREb3VibGVMRSA9IEJQLnJlYWREb3VibGVMRVxuICBhcnIucmVhZERvdWJsZUJFID0gQlAucmVhZERvdWJsZUJFXG4gIGFyci53cml0ZVVJbnQ4ID0gQlAud3JpdGVVSW50OFxuICBhcnIud3JpdGVVSW50TEUgPSBCUC53cml0ZVVJbnRMRVxuICBhcnIud3JpdGVVSW50QkUgPSBCUC53cml0ZVVJbnRCRVxuICBhcnIud3JpdGVVSW50MTZMRSA9IEJQLndyaXRlVUludDE2TEVcbiAgYXJyLndyaXRlVUludDE2QkUgPSBCUC53cml0ZVVJbnQxNkJFXG4gIGFyci53cml0ZVVJbnQzMkxFID0gQlAud3JpdGVVSW50MzJMRVxuICBhcnIud3JpdGVVSW50MzJCRSA9IEJQLndyaXRlVUludDMyQkVcbiAgYXJyLndyaXRlSW50TEUgPSBCUC53cml0ZUludExFXG4gIGFyci53cml0ZUludEJFID0gQlAud3JpdGVJbnRCRVxuICBhcnIud3JpdGVJbnQ4ID0gQlAud3JpdGVJbnQ4XG4gIGFyci53cml0ZUludDE2TEUgPSBCUC53cml0ZUludDE2TEVcbiAgYXJyLndyaXRlSW50MTZCRSA9IEJQLndyaXRlSW50MTZCRVxuICBhcnIud3JpdGVJbnQzMkxFID0gQlAud3JpdGVJbnQzMkxFXG4gIGFyci53cml0ZUludDMyQkUgPSBCUC53cml0ZUludDMyQkVcbiAgYXJyLndyaXRlRmxvYXRMRSA9IEJQLndyaXRlRmxvYXRMRVxuICBhcnIud3JpdGVGbG9hdEJFID0gQlAud3JpdGVGbG9hdEJFXG4gIGFyci53cml0ZURvdWJsZUxFID0gQlAud3JpdGVEb3VibGVMRVxuICBhcnIud3JpdGVEb3VibGVCRSA9IEJQLndyaXRlRG91YmxlQkVcbiAgYXJyLmZpbGwgPSBCUC5maWxsXG4gIGFyci5pbnNwZWN0ID0gQlAuaW5zcGVjdFxuICBhcnIudG9BcnJheUJ1ZmZlciA9IEJQLnRvQXJyYXlCdWZmZXJcblxuICByZXR1cm4gYXJyXG59XG5cbnZhciBJTlZBTElEX0JBU0U2NF9SRSA9IC9bXitcXC8wLTlBLVphLXotX10vZ1xuXG5mdW5jdGlvbiBiYXNlNjRjbGVhbiAoc3RyKSB7XG4gIC8vIE5vZGUgc3RyaXBzIG91dCBpbnZhbGlkIGNoYXJhY3RlcnMgbGlrZSBcXG4gYW5kIFxcdCBmcm9tIHRoZSBzdHJpbmcsIGJhc2U2NC1qcyBkb2VzIG5vdFxuICBzdHIgPSBzdHJpbmd0cmltKHN0cikucmVwbGFjZShJTlZBTElEX0JBU0U2NF9SRSwgJycpXG4gIC8vIE5vZGUgY29udmVydHMgc3RyaW5ncyB3aXRoIGxlbmd0aCA8IDIgdG8gJydcbiAgaWYgKHN0ci5sZW5ndGggPCAyKSByZXR1cm4gJydcbiAgLy8gTm9kZSBhbGxvd3MgZm9yIG5vbi1wYWRkZWQgYmFzZTY0IHN0cmluZ3MgKG1pc3NpbmcgdHJhaWxpbmcgPT09KSwgYmFzZTY0LWpzIGRvZXMgbm90XG4gIHdoaWxlIChzdHIubGVuZ3RoICUgNCAhPT0gMCkge1xuICAgIHN0ciA9IHN0ciArICc9J1xuICB9XG4gIHJldHVybiBzdHJcbn1cblxuZnVuY3Rpb24gc3RyaW5ndHJpbSAoc3RyKSB7XG4gIGlmIChzdHIudHJpbSkgcmV0dXJuIHN0ci50cmltKClcbiAgcmV0dXJuIHN0ci5yZXBsYWNlKC9eXFxzK3xcXHMrJC9nLCAnJylcbn1cblxuZnVuY3Rpb24gdG9IZXggKG4pIHtcbiAgaWYgKG4gPCAxNikgcmV0dXJuICcwJyArIG4udG9TdHJpbmcoMTYpXG4gIHJldHVybiBuLnRvU3RyaW5nKDE2KVxufVxuXG5mdW5jdGlvbiB1dGY4VG9CeXRlcyAoc3RyaW5nLCB1bml0cykge1xuICB1bml0cyA9IHVuaXRzIHx8IEluZmluaXR5XG4gIHZhciBjb2RlUG9pbnRcbiAgdmFyIGxlbmd0aCA9IHN0cmluZy5sZW5ndGhcbiAgdmFyIGxlYWRTdXJyb2dhdGUgPSBudWxsXG4gIHZhciBieXRlcyA9IFtdXG5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW5ndGg7IGkrKykge1xuICAgIGNvZGVQb2ludCA9IHN0cmluZy5jaGFyQ29kZUF0KGkpXG5cbiAgICAvLyBpcyBzdXJyb2dhdGUgY29tcG9uZW50XG4gICAgaWYgKGNvZGVQb2ludCA+IDB4RDdGRiAmJiBjb2RlUG9pbnQgPCAweEUwMDApIHtcbiAgICAgIC8vIGxhc3QgY2hhciB3YXMgYSBsZWFkXG4gICAgICBpZiAoIWxlYWRTdXJyb2dhdGUpIHtcbiAgICAgICAgLy8gbm8gbGVhZCB5ZXRcbiAgICAgICAgaWYgKGNvZGVQb2ludCA+IDB4REJGRikge1xuICAgICAgICAgIC8vIHVuZXhwZWN0ZWQgdHJhaWxcbiAgICAgICAgICBpZiAoKHVuaXRzIC09IDMpID4gLTEpIGJ5dGVzLnB1c2goMHhFRiwgMHhCRiwgMHhCRClcbiAgICAgICAgICBjb250aW51ZVxuICAgICAgICB9IGVsc2UgaWYgKGkgKyAxID09PSBsZW5ndGgpIHtcbiAgICAgICAgICAvLyB1bnBhaXJlZCBsZWFkXG4gICAgICAgICAgaWYgKCh1bml0cyAtPSAzKSA+IC0xKSBieXRlcy5wdXNoKDB4RUYsIDB4QkYsIDB4QkQpXG4gICAgICAgICAgY29udGludWVcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIHZhbGlkIGxlYWRcbiAgICAgICAgbGVhZFN1cnJvZ2F0ZSA9IGNvZGVQb2ludFxuXG4gICAgICAgIGNvbnRpbnVlXG4gICAgICB9XG5cbiAgICAgIC8vIDIgbGVhZHMgaW4gYSByb3dcbiAgICAgIGlmIChjb2RlUG9pbnQgPCAweERDMDApIHtcbiAgICAgICAgaWYgKCh1bml0cyAtPSAzKSA+IC0xKSBieXRlcy5wdXNoKDB4RUYsIDB4QkYsIDB4QkQpXG4gICAgICAgIGxlYWRTdXJyb2dhdGUgPSBjb2RlUG9pbnRcbiAgICAgICAgY29udGludWVcbiAgICAgIH1cblxuICAgICAgLy8gdmFsaWQgc3Vycm9nYXRlIHBhaXJcbiAgICAgIGNvZGVQb2ludCA9IGxlYWRTdXJyb2dhdGUgLSAweEQ4MDAgPDwgMTAgfCBjb2RlUG9pbnQgLSAweERDMDAgfCAweDEwMDAwXG4gICAgfSBlbHNlIGlmIChsZWFkU3Vycm9nYXRlKSB7XG4gICAgICAvLyB2YWxpZCBibXAgY2hhciwgYnV0IGxhc3QgY2hhciB3YXMgYSBsZWFkXG4gICAgICBpZiAoKHVuaXRzIC09IDMpID4gLTEpIGJ5dGVzLnB1c2goMHhFRiwgMHhCRiwgMHhCRClcbiAgICB9XG5cbiAgICBsZWFkU3Vycm9nYXRlID0gbnVsbFxuXG4gICAgLy8gZW5jb2RlIHV0ZjhcbiAgICBpZiAoY29kZVBvaW50IDwgMHg4MCkge1xuICAgICAgaWYgKCh1bml0cyAtPSAxKSA8IDApIGJyZWFrXG4gICAgICBieXRlcy5wdXNoKGNvZGVQb2ludClcbiAgICB9IGVsc2UgaWYgKGNvZGVQb2ludCA8IDB4ODAwKSB7XG4gICAgICBpZiAoKHVuaXRzIC09IDIpIDwgMCkgYnJlYWtcbiAgICAgIGJ5dGVzLnB1c2goXG4gICAgICAgIGNvZGVQb2ludCA+PiAweDYgfCAweEMwLFxuICAgICAgICBjb2RlUG9pbnQgJiAweDNGIHwgMHg4MFxuICAgICAgKVxuICAgIH0gZWxzZSBpZiAoY29kZVBvaW50IDwgMHgxMDAwMCkge1xuICAgICAgaWYgKCh1bml0cyAtPSAzKSA8IDApIGJyZWFrXG4gICAgICBieXRlcy5wdXNoKFxuICAgICAgICBjb2RlUG9pbnQgPj4gMHhDIHwgMHhFMCxcbiAgICAgICAgY29kZVBvaW50ID4+IDB4NiAmIDB4M0YgfCAweDgwLFxuICAgICAgICBjb2RlUG9pbnQgJiAweDNGIHwgMHg4MFxuICAgICAgKVxuICAgIH0gZWxzZSBpZiAoY29kZVBvaW50IDwgMHgxMTAwMDApIHtcbiAgICAgIGlmICgodW5pdHMgLT0gNCkgPCAwKSBicmVha1xuICAgICAgYnl0ZXMucHVzaChcbiAgICAgICAgY29kZVBvaW50ID4+IDB4MTIgfCAweEYwLFxuICAgICAgICBjb2RlUG9pbnQgPj4gMHhDICYgMHgzRiB8IDB4ODAsXG4gICAgICAgIGNvZGVQb2ludCA+PiAweDYgJiAweDNGIHwgMHg4MCxcbiAgICAgICAgY29kZVBvaW50ICYgMHgzRiB8IDB4ODBcbiAgICAgIClcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIGNvZGUgcG9pbnQnKVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBieXRlc1xufVxuXG5mdW5jdGlvbiBhc2NpaVRvQnl0ZXMgKHN0cikge1xuICB2YXIgYnl0ZUFycmF5ID0gW11cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBzdHIubGVuZ3RoOyBpKyspIHtcbiAgICAvLyBOb2RlJ3MgY29kZSBzZWVtcyB0byBiZSBkb2luZyB0aGlzIGFuZCBub3QgJiAweDdGLi5cbiAgICBieXRlQXJyYXkucHVzaChzdHIuY2hhckNvZGVBdChpKSAmIDB4RkYpXG4gIH1cbiAgcmV0dXJuIGJ5dGVBcnJheVxufVxuXG5mdW5jdGlvbiB1dGYxNmxlVG9CeXRlcyAoc3RyLCB1bml0cykge1xuICB2YXIgYywgaGksIGxvXG4gIHZhciBieXRlQXJyYXkgPSBbXVxuICBmb3IgKHZhciBpID0gMDsgaSA8IHN0ci5sZW5ndGg7IGkrKykge1xuICAgIGlmICgodW5pdHMgLT0gMikgPCAwKSBicmVha1xuXG4gICAgYyA9IHN0ci5jaGFyQ29kZUF0KGkpXG4gICAgaGkgPSBjID4+IDhcbiAgICBsbyA9IGMgJSAyNTZcbiAgICBieXRlQXJyYXkucHVzaChsbylcbiAgICBieXRlQXJyYXkucHVzaChoaSlcbiAgfVxuXG4gIHJldHVybiBieXRlQXJyYXlcbn1cblxuZnVuY3Rpb24gYmFzZTY0VG9CeXRlcyAoc3RyKSB7XG4gIHJldHVybiBiYXNlNjQudG9CeXRlQXJyYXkoYmFzZTY0Y2xlYW4oc3RyKSlcbn1cblxuZnVuY3Rpb24gYmxpdEJ1ZmZlciAoc3JjLCBkc3QsIG9mZnNldCwgbGVuZ3RoKSB7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuZ3RoOyBpKyspIHtcbiAgICBpZiAoKGkgKyBvZmZzZXQgPj0gZHN0Lmxlbmd0aCkgfHwgKGkgPj0gc3JjLmxlbmd0aCkpIGJyZWFrXG4gICAgZHN0W2kgKyBvZmZzZXRdID0gc3JjW2ldXG4gIH1cbiAgcmV0dXJuIGlcbn1cbiIsInZhciBsb29rdXAgPSAnQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkrLyc7XG5cbjsoZnVuY3Rpb24gKGV4cG9ydHMpIHtcblx0J3VzZSBzdHJpY3QnO1xuXG4gIHZhciBBcnIgPSAodHlwZW9mIFVpbnQ4QXJyYXkgIT09ICd1bmRlZmluZWQnKVxuICAgID8gVWludDhBcnJheVxuICAgIDogQXJyYXlcblxuXHR2YXIgUExVUyAgID0gJysnLmNoYXJDb2RlQXQoMClcblx0dmFyIFNMQVNIICA9ICcvJy5jaGFyQ29kZUF0KDApXG5cdHZhciBOVU1CRVIgPSAnMCcuY2hhckNvZGVBdCgwKVxuXHR2YXIgTE9XRVIgID0gJ2EnLmNoYXJDb2RlQXQoMClcblx0dmFyIFVQUEVSICA9ICdBJy5jaGFyQ29kZUF0KDApXG5cdHZhciBQTFVTX1VSTF9TQUZFID0gJy0nLmNoYXJDb2RlQXQoMClcblx0dmFyIFNMQVNIX1VSTF9TQUZFID0gJ18nLmNoYXJDb2RlQXQoMClcblxuXHRmdW5jdGlvbiBkZWNvZGUgKGVsdCkge1xuXHRcdHZhciBjb2RlID0gZWx0LmNoYXJDb2RlQXQoMClcblx0XHRpZiAoY29kZSA9PT0gUExVUyB8fFxuXHRcdCAgICBjb2RlID09PSBQTFVTX1VSTF9TQUZFKVxuXHRcdFx0cmV0dXJuIDYyIC8vICcrJ1xuXHRcdGlmIChjb2RlID09PSBTTEFTSCB8fFxuXHRcdCAgICBjb2RlID09PSBTTEFTSF9VUkxfU0FGRSlcblx0XHRcdHJldHVybiA2MyAvLyAnLydcblx0XHRpZiAoY29kZSA8IE5VTUJFUilcblx0XHRcdHJldHVybiAtMSAvL25vIG1hdGNoXG5cdFx0aWYgKGNvZGUgPCBOVU1CRVIgKyAxMClcblx0XHRcdHJldHVybiBjb2RlIC0gTlVNQkVSICsgMjYgKyAyNlxuXHRcdGlmIChjb2RlIDwgVVBQRVIgKyAyNilcblx0XHRcdHJldHVybiBjb2RlIC0gVVBQRVJcblx0XHRpZiAoY29kZSA8IExPV0VSICsgMjYpXG5cdFx0XHRyZXR1cm4gY29kZSAtIExPV0VSICsgMjZcblx0fVxuXG5cdGZ1bmN0aW9uIGI2NFRvQnl0ZUFycmF5IChiNjQpIHtcblx0XHR2YXIgaSwgaiwgbCwgdG1wLCBwbGFjZUhvbGRlcnMsIGFyclxuXG5cdFx0aWYgKGI2NC5sZW5ndGggJSA0ID4gMCkge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIHN0cmluZy4gTGVuZ3RoIG11c3QgYmUgYSBtdWx0aXBsZSBvZiA0Jylcblx0XHR9XG5cblx0XHQvLyB0aGUgbnVtYmVyIG9mIGVxdWFsIHNpZ25zIChwbGFjZSBob2xkZXJzKVxuXHRcdC8vIGlmIHRoZXJlIGFyZSB0d28gcGxhY2Vob2xkZXJzLCB0aGFuIHRoZSB0d28gY2hhcmFjdGVycyBiZWZvcmUgaXRcblx0XHQvLyByZXByZXNlbnQgb25lIGJ5dGVcblx0XHQvLyBpZiB0aGVyZSBpcyBvbmx5IG9uZSwgdGhlbiB0aGUgdGhyZWUgY2hhcmFjdGVycyBiZWZvcmUgaXQgcmVwcmVzZW50IDIgYnl0ZXNcblx0XHQvLyB0aGlzIGlzIGp1c3QgYSBjaGVhcCBoYWNrIHRvIG5vdCBkbyBpbmRleE9mIHR3aWNlXG5cdFx0dmFyIGxlbiA9IGI2NC5sZW5ndGhcblx0XHRwbGFjZUhvbGRlcnMgPSAnPScgPT09IGI2NC5jaGFyQXQobGVuIC0gMikgPyAyIDogJz0nID09PSBiNjQuY2hhckF0KGxlbiAtIDEpID8gMSA6IDBcblxuXHRcdC8vIGJhc2U2NCBpcyA0LzMgKyB1cCB0byB0d28gY2hhcmFjdGVycyBvZiB0aGUgb3JpZ2luYWwgZGF0YVxuXHRcdGFyciA9IG5ldyBBcnIoYjY0Lmxlbmd0aCAqIDMgLyA0IC0gcGxhY2VIb2xkZXJzKVxuXG5cdFx0Ly8gaWYgdGhlcmUgYXJlIHBsYWNlaG9sZGVycywgb25seSBnZXQgdXAgdG8gdGhlIGxhc3QgY29tcGxldGUgNCBjaGFyc1xuXHRcdGwgPSBwbGFjZUhvbGRlcnMgPiAwID8gYjY0Lmxlbmd0aCAtIDQgOiBiNjQubGVuZ3RoXG5cblx0XHR2YXIgTCA9IDBcblxuXHRcdGZ1bmN0aW9uIHB1c2ggKHYpIHtcblx0XHRcdGFycltMKytdID0gdlxuXHRcdH1cblxuXHRcdGZvciAoaSA9IDAsIGogPSAwOyBpIDwgbDsgaSArPSA0LCBqICs9IDMpIHtcblx0XHRcdHRtcCA9IChkZWNvZGUoYjY0LmNoYXJBdChpKSkgPDwgMTgpIHwgKGRlY29kZShiNjQuY2hhckF0KGkgKyAxKSkgPDwgMTIpIHwgKGRlY29kZShiNjQuY2hhckF0KGkgKyAyKSkgPDwgNikgfCBkZWNvZGUoYjY0LmNoYXJBdChpICsgMykpXG5cdFx0XHRwdXNoKCh0bXAgJiAweEZGMDAwMCkgPj4gMTYpXG5cdFx0XHRwdXNoKCh0bXAgJiAweEZGMDApID4+IDgpXG5cdFx0XHRwdXNoKHRtcCAmIDB4RkYpXG5cdFx0fVxuXG5cdFx0aWYgKHBsYWNlSG9sZGVycyA9PT0gMikge1xuXHRcdFx0dG1wID0gKGRlY29kZShiNjQuY2hhckF0KGkpKSA8PCAyKSB8IChkZWNvZGUoYjY0LmNoYXJBdChpICsgMSkpID4+IDQpXG5cdFx0XHRwdXNoKHRtcCAmIDB4RkYpXG5cdFx0fSBlbHNlIGlmIChwbGFjZUhvbGRlcnMgPT09IDEpIHtcblx0XHRcdHRtcCA9IChkZWNvZGUoYjY0LmNoYXJBdChpKSkgPDwgMTApIHwgKGRlY29kZShiNjQuY2hhckF0KGkgKyAxKSkgPDwgNCkgfCAoZGVjb2RlKGI2NC5jaGFyQXQoaSArIDIpKSA+PiAyKVxuXHRcdFx0cHVzaCgodG1wID4+IDgpICYgMHhGRilcblx0XHRcdHB1c2godG1wICYgMHhGRilcblx0XHR9XG5cblx0XHRyZXR1cm4gYXJyXG5cdH1cblxuXHRmdW5jdGlvbiB1aW50OFRvQmFzZTY0ICh1aW50OCkge1xuXHRcdHZhciBpLFxuXHRcdFx0ZXh0cmFCeXRlcyA9IHVpbnQ4Lmxlbmd0aCAlIDMsIC8vIGlmIHdlIGhhdmUgMSBieXRlIGxlZnQsIHBhZCAyIGJ5dGVzXG5cdFx0XHRvdXRwdXQgPSBcIlwiLFxuXHRcdFx0dGVtcCwgbGVuZ3RoXG5cblx0XHRmdW5jdGlvbiBlbmNvZGUgKG51bSkge1xuXHRcdFx0cmV0dXJuIGxvb2t1cC5jaGFyQXQobnVtKVxuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIHRyaXBsZXRUb0Jhc2U2NCAobnVtKSB7XG5cdFx0XHRyZXR1cm4gZW5jb2RlKG51bSA+PiAxOCAmIDB4M0YpICsgZW5jb2RlKG51bSA+PiAxMiAmIDB4M0YpICsgZW5jb2RlKG51bSA+PiA2ICYgMHgzRikgKyBlbmNvZGUobnVtICYgMHgzRilcblx0XHR9XG5cblx0XHQvLyBnbyB0aHJvdWdoIHRoZSBhcnJheSBldmVyeSB0aHJlZSBieXRlcywgd2UnbGwgZGVhbCB3aXRoIHRyYWlsaW5nIHN0dWZmIGxhdGVyXG5cdFx0Zm9yIChpID0gMCwgbGVuZ3RoID0gdWludDgubGVuZ3RoIC0gZXh0cmFCeXRlczsgaSA8IGxlbmd0aDsgaSArPSAzKSB7XG5cdFx0XHR0ZW1wID0gKHVpbnQ4W2ldIDw8IDE2KSArICh1aW50OFtpICsgMV0gPDwgOCkgKyAodWludDhbaSArIDJdKVxuXHRcdFx0b3V0cHV0ICs9IHRyaXBsZXRUb0Jhc2U2NCh0ZW1wKVxuXHRcdH1cblxuXHRcdC8vIHBhZCB0aGUgZW5kIHdpdGggemVyb3MsIGJ1dCBtYWtlIHN1cmUgdG8gbm90IGZvcmdldCB0aGUgZXh0cmEgYnl0ZXNcblx0XHRzd2l0Y2ggKGV4dHJhQnl0ZXMpIHtcblx0XHRcdGNhc2UgMTpcblx0XHRcdFx0dGVtcCA9IHVpbnQ4W3VpbnQ4Lmxlbmd0aCAtIDFdXG5cdFx0XHRcdG91dHB1dCArPSBlbmNvZGUodGVtcCA+PiAyKVxuXHRcdFx0XHRvdXRwdXQgKz0gZW5jb2RlKCh0ZW1wIDw8IDQpICYgMHgzRilcblx0XHRcdFx0b3V0cHV0ICs9ICc9PSdcblx0XHRcdFx0YnJlYWtcblx0XHRcdGNhc2UgMjpcblx0XHRcdFx0dGVtcCA9ICh1aW50OFt1aW50OC5sZW5ndGggLSAyXSA8PCA4KSArICh1aW50OFt1aW50OC5sZW5ndGggLSAxXSlcblx0XHRcdFx0b3V0cHV0ICs9IGVuY29kZSh0ZW1wID4+IDEwKVxuXHRcdFx0XHRvdXRwdXQgKz0gZW5jb2RlKCh0ZW1wID4+IDQpICYgMHgzRilcblx0XHRcdFx0b3V0cHV0ICs9IGVuY29kZSgodGVtcCA8PCAyKSAmIDB4M0YpXG5cdFx0XHRcdG91dHB1dCArPSAnPSdcblx0XHRcdFx0YnJlYWtcblx0XHR9XG5cblx0XHRyZXR1cm4gb3V0cHV0XG5cdH1cblxuXHRleHBvcnRzLnRvQnl0ZUFycmF5ID0gYjY0VG9CeXRlQXJyYXlcblx0ZXhwb3J0cy5mcm9tQnl0ZUFycmF5ID0gdWludDhUb0Jhc2U2NFxufSh0eXBlb2YgZXhwb3J0cyA9PT0gJ3VuZGVmaW5lZCcgPyAodGhpcy5iYXNlNjRqcyA9IHt9KSA6IGV4cG9ydHMpKVxuIiwiZXhwb3J0cy5yZWFkID0gZnVuY3Rpb24gKGJ1ZmZlciwgb2Zmc2V0LCBpc0xFLCBtTGVuLCBuQnl0ZXMpIHtcbiAgdmFyIGUsIG1cbiAgdmFyIGVMZW4gPSBuQnl0ZXMgKiA4IC0gbUxlbiAtIDFcbiAgdmFyIGVNYXggPSAoMSA8PCBlTGVuKSAtIDFcbiAgdmFyIGVCaWFzID0gZU1heCA+PiAxXG4gIHZhciBuQml0cyA9IC03XG4gIHZhciBpID0gaXNMRSA/IChuQnl0ZXMgLSAxKSA6IDBcbiAgdmFyIGQgPSBpc0xFID8gLTEgOiAxXG4gIHZhciBzID0gYnVmZmVyW29mZnNldCArIGldXG5cbiAgaSArPSBkXG5cbiAgZSA9IHMgJiAoKDEgPDwgKC1uQml0cykpIC0gMSlcbiAgcyA+Pj0gKC1uQml0cylcbiAgbkJpdHMgKz0gZUxlblxuICBmb3IgKDsgbkJpdHMgPiAwOyBlID0gZSAqIDI1NiArIGJ1ZmZlcltvZmZzZXQgKyBpXSwgaSArPSBkLCBuQml0cyAtPSA4KSB7fVxuXG4gIG0gPSBlICYgKCgxIDw8ICgtbkJpdHMpKSAtIDEpXG4gIGUgPj49ICgtbkJpdHMpXG4gIG5CaXRzICs9IG1MZW5cbiAgZm9yICg7IG5CaXRzID4gMDsgbSA9IG0gKiAyNTYgKyBidWZmZXJbb2Zmc2V0ICsgaV0sIGkgKz0gZCwgbkJpdHMgLT0gOCkge31cblxuICBpZiAoZSA9PT0gMCkge1xuICAgIGUgPSAxIC0gZUJpYXNcbiAgfSBlbHNlIGlmIChlID09PSBlTWF4KSB7XG4gICAgcmV0dXJuIG0gPyBOYU4gOiAoKHMgPyAtMSA6IDEpICogSW5maW5pdHkpXG4gIH0gZWxzZSB7XG4gICAgbSA9IG0gKyBNYXRoLnBvdygyLCBtTGVuKVxuICAgIGUgPSBlIC0gZUJpYXNcbiAgfVxuICByZXR1cm4gKHMgPyAtMSA6IDEpICogbSAqIE1hdGgucG93KDIsIGUgLSBtTGVuKVxufVxuXG5leHBvcnRzLndyaXRlID0gZnVuY3Rpb24gKGJ1ZmZlciwgdmFsdWUsIG9mZnNldCwgaXNMRSwgbUxlbiwgbkJ5dGVzKSB7XG4gIHZhciBlLCBtLCBjXG4gIHZhciBlTGVuID0gbkJ5dGVzICogOCAtIG1MZW4gLSAxXG4gIHZhciBlTWF4ID0gKDEgPDwgZUxlbikgLSAxXG4gIHZhciBlQmlhcyA9IGVNYXggPj4gMVxuICB2YXIgcnQgPSAobUxlbiA9PT0gMjMgPyBNYXRoLnBvdygyLCAtMjQpIC0gTWF0aC5wb3coMiwgLTc3KSA6IDApXG4gIHZhciBpID0gaXNMRSA/IDAgOiAobkJ5dGVzIC0gMSlcbiAgdmFyIGQgPSBpc0xFID8gMSA6IC0xXG4gIHZhciBzID0gdmFsdWUgPCAwIHx8ICh2YWx1ZSA9PT0gMCAmJiAxIC8gdmFsdWUgPCAwKSA/IDEgOiAwXG5cbiAgdmFsdWUgPSBNYXRoLmFicyh2YWx1ZSlcblxuICBpZiAoaXNOYU4odmFsdWUpIHx8IHZhbHVlID09PSBJbmZpbml0eSkge1xuICAgIG0gPSBpc05hTih2YWx1ZSkgPyAxIDogMFxuICAgIGUgPSBlTWF4XG4gIH0gZWxzZSB7XG4gICAgZSA9IE1hdGguZmxvb3IoTWF0aC5sb2codmFsdWUpIC8gTWF0aC5MTjIpXG4gICAgaWYgKHZhbHVlICogKGMgPSBNYXRoLnBvdygyLCAtZSkpIDwgMSkge1xuICAgICAgZS0tXG4gICAgICBjICo9IDJcbiAgICB9XG4gICAgaWYgKGUgKyBlQmlhcyA+PSAxKSB7XG4gICAgICB2YWx1ZSArPSBydCAvIGNcbiAgICB9IGVsc2Uge1xuICAgICAgdmFsdWUgKz0gcnQgKiBNYXRoLnBvdygyLCAxIC0gZUJpYXMpXG4gICAgfVxuICAgIGlmICh2YWx1ZSAqIGMgPj0gMikge1xuICAgICAgZSsrXG4gICAgICBjIC89IDJcbiAgICB9XG5cbiAgICBpZiAoZSArIGVCaWFzID49IGVNYXgpIHtcbiAgICAgIG0gPSAwXG4gICAgICBlID0gZU1heFxuICAgIH0gZWxzZSBpZiAoZSArIGVCaWFzID49IDEpIHtcbiAgICAgIG0gPSAodmFsdWUgKiBjIC0gMSkgKiBNYXRoLnBvdygyLCBtTGVuKVxuICAgICAgZSA9IGUgKyBlQmlhc1xuICAgIH0gZWxzZSB7XG4gICAgICBtID0gdmFsdWUgKiBNYXRoLnBvdygyLCBlQmlhcyAtIDEpICogTWF0aC5wb3coMiwgbUxlbilcbiAgICAgIGUgPSAwXG4gICAgfVxuICB9XG5cbiAgZm9yICg7IG1MZW4gPj0gODsgYnVmZmVyW29mZnNldCArIGldID0gbSAmIDB4ZmYsIGkgKz0gZCwgbSAvPSAyNTYsIG1MZW4gLT0gOCkge31cblxuICBlID0gKGUgPDwgbUxlbikgfCBtXG4gIGVMZW4gKz0gbUxlblxuICBmb3IgKDsgZUxlbiA+IDA7IGJ1ZmZlcltvZmZzZXQgKyBpXSA9IGUgJiAweGZmLCBpICs9IGQsIGUgLz0gMjU2LCBlTGVuIC09IDgpIHt9XG5cbiAgYnVmZmVyW29mZnNldCArIGkgLSBkXSB8PSBzICogMTI4XG59XG4iLCJcbi8qKlxuICogaXNBcnJheVxuICovXG5cbnZhciBpc0FycmF5ID0gQXJyYXkuaXNBcnJheTtcblxuLyoqXG4gKiB0b1N0cmluZ1xuICovXG5cbnZhciBzdHIgPSBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nO1xuXG4vKipcbiAqIFdoZXRoZXIgb3Igbm90IHRoZSBnaXZlbiBgdmFsYFxuICogaXMgYW4gYXJyYXkuXG4gKlxuICogZXhhbXBsZTpcbiAqXG4gKiAgICAgICAgaXNBcnJheShbXSk7XG4gKiAgICAgICAgLy8gPiB0cnVlXG4gKiAgICAgICAgaXNBcnJheShhcmd1bWVudHMpO1xuICogICAgICAgIC8vID4gZmFsc2VcbiAqICAgICAgICBpc0FycmF5KCcnKTtcbiAqICAgICAgICAvLyA+IGZhbHNlXG4gKlxuICogQHBhcmFtIHttaXhlZH0gdmFsXG4gKiBAcmV0dXJuIHtib29sfVxuICovXG5cbm1vZHVsZS5leHBvcnRzID0gaXNBcnJheSB8fCBmdW5jdGlvbiAodmFsKSB7XG4gIHJldHVybiAhISB2YWwgJiYgJ1tvYmplY3QgQXJyYXldJyA9PSBzdHIuY2FsbCh2YWwpO1xufTtcbiIsIi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG5mdW5jdGlvbiBFdmVudEVtaXR0ZXIoKSB7XG4gIHRoaXMuX2V2ZW50cyA9IHRoaXMuX2V2ZW50cyB8fCB7fTtcbiAgdGhpcy5fbWF4TGlzdGVuZXJzID0gdGhpcy5fbWF4TGlzdGVuZXJzIHx8IHVuZGVmaW5lZDtcbn1cbm1vZHVsZS5leHBvcnRzID0gRXZlbnRFbWl0dGVyO1xuXG4vLyBCYWNrd2FyZHMtY29tcGF0IHdpdGggbm9kZSAwLjEwLnhcbkV2ZW50RW1pdHRlci5FdmVudEVtaXR0ZXIgPSBFdmVudEVtaXR0ZXI7XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuX2V2ZW50cyA9IHVuZGVmaW5lZDtcbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuX21heExpc3RlbmVycyA9IHVuZGVmaW5lZDtcblxuLy8gQnkgZGVmYXVsdCBFdmVudEVtaXR0ZXJzIHdpbGwgcHJpbnQgYSB3YXJuaW5nIGlmIG1vcmUgdGhhbiAxMCBsaXN0ZW5lcnMgYXJlXG4vLyBhZGRlZCB0byBpdC4gVGhpcyBpcyBhIHVzZWZ1bCBkZWZhdWx0IHdoaWNoIGhlbHBzIGZpbmRpbmcgbWVtb3J5IGxlYWtzLlxuRXZlbnRFbWl0dGVyLmRlZmF1bHRNYXhMaXN0ZW5lcnMgPSAxMDtcblxuLy8gT2J2aW91c2x5IG5vdCBhbGwgRW1pdHRlcnMgc2hvdWxkIGJlIGxpbWl0ZWQgdG8gMTAuIFRoaXMgZnVuY3Rpb24gYWxsb3dzXG4vLyB0aGF0IHRvIGJlIGluY3JlYXNlZC4gU2V0IHRvIHplcm8gZm9yIHVubGltaXRlZC5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuc2V0TWF4TGlzdGVuZXJzID0gZnVuY3Rpb24obikge1xuICBpZiAoIWlzTnVtYmVyKG4pIHx8IG4gPCAwIHx8IGlzTmFOKG4pKVxuICAgIHRocm93IFR5cGVFcnJvcignbiBtdXN0IGJlIGEgcG9zaXRpdmUgbnVtYmVyJyk7XG4gIHRoaXMuX21heExpc3RlbmVycyA9IG47XG4gIHJldHVybiB0aGlzO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5lbWl0ID0gZnVuY3Rpb24odHlwZSkge1xuICB2YXIgZXIsIGhhbmRsZXIsIGxlbiwgYXJncywgaSwgbGlzdGVuZXJzO1xuXG4gIGlmICghdGhpcy5fZXZlbnRzKVxuICAgIHRoaXMuX2V2ZW50cyA9IHt9O1xuXG4gIC8vIElmIHRoZXJlIGlzIG5vICdlcnJvcicgZXZlbnQgbGlzdGVuZXIgdGhlbiB0aHJvdy5cbiAgaWYgKHR5cGUgPT09ICdlcnJvcicpIHtcbiAgICBpZiAoIXRoaXMuX2V2ZW50cy5lcnJvciB8fFxuICAgICAgICAoaXNPYmplY3QodGhpcy5fZXZlbnRzLmVycm9yKSAmJiAhdGhpcy5fZXZlbnRzLmVycm9yLmxlbmd0aCkpIHtcbiAgICAgIGVyID0gYXJndW1lbnRzWzFdO1xuICAgICAgaWYgKGVyIGluc3RhbmNlb2YgRXJyb3IpIHtcbiAgICAgICAgdGhyb3cgZXI7IC8vIFVuaGFuZGxlZCAnZXJyb3InIGV2ZW50XG4gICAgICB9XG4gICAgICB0aHJvdyBUeXBlRXJyb3IoJ1VuY2F1Z2h0LCB1bnNwZWNpZmllZCBcImVycm9yXCIgZXZlbnQuJyk7XG4gICAgfVxuICB9XG5cbiAgaGFuZGxlciA9IHRoaXMuX2V2ZW50c1t0eXBlXTtcblxuICBpZiAoaXNVbmRlZmluZWQoaGFuZGxlcikpXG4gICAgcmV0dXJuIGZhbHNlO1xuXG4gIGlmIChpc0Z1bmN0aW9uKGhhbmRsZXIpKSB7XG4gICAgc3dpdGNoIChhcmd1bWVudHMubGVuZ3RoKSB7XG4gICAgICAvLyBmYXN0IGNhc2VzXG4gICAgICBjYXNlIDE6XG4gICAgICAgIGhhbmRsZXIuY2FsbCh0aGlzKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDI6XG4gICAgICAgIGhhbmRsZXIuY2FsbCh0aGlzLCBhcmd1bWVudHNbMV0pO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgMzpcbiAgICAgICAgaGFuZGxlci5jYWxsKHRoaXMsIGFyZ3VtZW50c1sxXSwgYXJndW1lbnRzWzJdKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICAvLyBzbG93ZXJcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIGxlbiA9IGFyZ3VtZW50cy5sZW5ndGg7XG4gICAgICAgIGFyZ3MgPSBuZXcgQXJyYXkobGVuIC0gMSk7XG4gICAgICAgIGZvciAoaSA9IDE7IGkgPCBsZW47IGkrKylcbiAgICAgICAgICBhcmdzW2kgLSAxXSA9IGFyZ3VtZW50c1tpXTtcbiAgICAgICAgaGFuZGxlci5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAoaXNPYmplY3QoaGFuZGxlcikpIHtcbiAgICBsZW4gPSBhcmd1bWVudHMubGVuZ3RoO1xuICAgIGFyZ3MgPSBuZXcgQXJyYXkobGVuIC0gMSk7XG4gICAgZm9yIChpID0gMTsgaSA8IGxlbjsgaSsrKVxuICAgICAgYXJnc1tpIC0gMV0gPSBhcmd1bWVudHNbaV07XG5cbiAgICBsaXN0ZW5lcnMgPSBoYW5kbGVyLnNsaWNlKCk7XG4gICAgbGVuID0gbGlzdGVuZXJzLmxlbmd0aDtcbiAgICBmb3IgKGkgPSAwOyBpIDwgbGVuOyBpKyspXG4gICAgICBsaXN0ZW5lcnNbaV0uYXBwbHkodGhpcywgYXJncyk7XG4gIH1cblxuICByZXR1cm4gdHJ1ZTtcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuYWRkTGlzdGVuZXIgPSBmdW5jdGlvbih0eXBlLCBsaXN0ZW5lcikge1xuICB2YXIgbTtcblxuICBpZiAoIWlzRnVuY3Rpb24obGlzdGVuZXIpKVxuICAgIHRocm93IFR5cGVFcnJvcignbGlzdGVuZXIgbXVzdCBiZSBhIGZ1bmN0aW9uJyk7XG5cbiAgaWYgKCF0aGlzLl9ldmVudHMpXG4gICAgdGhpcy5fZXZlbnRzID0ge307XG5cbiAgLy8gVG8gYXZvaWQgcmVjdXJzaW9uIGluIHRoZSBjYXNlIHRoYXQgdHlwZSA9PT0gXCJuZXdMaXN0ZW5lclwiISBCZWZvcmVcbiAgLy8gYWRkaW5nIGl0IHRvIHRoZSBsaXN0ZW5lcnMsIGZpcnN0IGVtaXQgXCJuZXdMaXN0ZW5lclwiLlxuICBpZiAodGhpcy5fZXZlbnRzLm5ld0xpc3RlbmVyKVxuICAgIHRoaXMuZW1pdCgnbmV3TGlzdGVuZXInLCB0eXBlLFxuICAgICAgICAgICAgICBpc0Z1bmN0aW9uKGxpc3RlbmVyLmxpc3RlbmVyKSA/XG4gICAgICAgICAgICAgIGxpc3RlbmVyLmxpc3RlbmVyIDogbGlzdGVuZXIpO1xuXG4gIGlmICghdGhpcy5fZXZlbnRzW3R5cGVdKVxuICAgIC8vIE9wdGltaXplIHRoZSBjYXNlIG9mIG9uZSBsaXN0ZW5lci4gRG9uJ3QgbmVlZCB0aGUgZXh0cmEgYXJyYXkgb2JqZWN0LlxuICAgIHRoaXMuX2V2ZW50c1t0eXBlXSA9IGxpc3RlbmVyO1xuICBlbHNlIGlmIChpc09iamVjdCh0aGlzLl9ldmVudHNbdHlwZV0pKVxuICAgIC8vIElmIHdlJ3ZlIGFscmVhZHkgZ290IGFuIGFycmF5LCBqdXN0IGFwcGVuZC5cbiAgICB0aGlzLl9ldmVudHNbdHlwZV0ucHVzaChsaXN0ZW5lcik7XG4gIGVsc2VcbiAgICAvLyBBZGRpbmcgdGhlIHNlY29uZCBlbGVtZW50LCBuZWVkIHRvIGNoYW5nZSB0byBhcnJheS5cbiAgICB0aGlzLl9ldmVudHNbdHlwZV0gPSBbdGhpcy5fZXZlbnRzW3R5cGVdLCBsaXN0ZW5lcl07XG5cbiAgLy8gQ2hlY2sgZm9yIGxpc3RlbmVyIGxlYWtcbiAgaWYgKGlzT2JqZWN0KHRoaXMuX2V2ZW50c1t0eXBlXSkgJiYgIXRoaXMuX2V2ZW50c1t0eXBlXS53YXJuZWQpIHtcbiAgICB2YXIgbTtcbiAgICBpZiAoIWlzVW5kZWZpbmVkKHRoaXMuX21heExpc3RlbmVycykpIHtcbiAgICAgIG0gPSB0aGlzLl9tYXhMaXN0ZW5lcnM7XG4gICAgfSBlbHNlIHtcbiAgICAgIG0gPSBFdmVudEVtaXR0ZXIuZGVmYXVsdE1heExpc3RlbmVycztcbiAgICB9XG5cbiAgICBpZiAobSAmJiBtID4gMCAmJiB0aGlzLl9ldmVudHNbdHlwZV0ubGVuZ3RoID4gbSkge1xuICAgICAgdGhpcy5fZXZlbnRzW3R5cGVdLndhcm5lZCA9IHRydWU7XG4gICAgICBjb25zb2xlLmVycm9yKCcobm9kZSkgd2FybmluZzogcG9zc2libGUgRXZlbnRFbWl0dGVyIG1lbW9yeSAnICtcbiAgICAgICAgICAgICAgICAgICAgJ2xlYWsgZGV0ZWN0ZWQuICVkIGxpc3RlbmVycyBhZGRlZC4gJyArXG4gICAgICAgICAgICAgICAgICAgICdVc2UgZW1pdHRlci5zZXRNYXhMaXN0ZW5lcnMoKSB0byBpbmNyZWFzZSBsaW1pdC4nLFxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudHNbdHlwZV0ubGVuZ3RoKTtcbiAgICAgIGlmICh0eXBlb2YgY29uc29sZS50cmFjZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAvLyBub3Qgc3VwcG9ydGVkIGluIElFIDEwXG4gICAgICAgIGNvbnNvbGUudHJhY2UoKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gdGhpcztcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUub24gPSBFdmVudEVtaXR0ZXIucHJvdG90eXBlLmFkZExpc3RlbmVyO1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLm9uY2UgPSBmdW5jdGlvbih0eXBlLCBsaXN0ZW5lcikge1xuICBpZiAoIWlzRnVuY3Rpb24obGlzdGVuZXIpKVxuICAgIHRocm93IFR5cGVFcnJvcignbGlzdGVuZXIgbXVzdCBiZSBhIGZ1bmN0aW9uJyk7XG5cbiAgdmFyIGZpcmVkID0gZmFsc2U7XG5cbiAgZnVuY3Rpb24gZygpIHtcbiAgICB0aGlzLnJlbW92ZUxpc3RlbmVyKHR5cGUsIGcpO1xuXG4gICAgaWYgKCFmaXJlZCkge1xuICAgICAgZmlyZWQgPSB0cnVlO1xuICAgICAgbGlzdGVuZXIuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICB9XG4gIH1cblxuICBnLmxpc3RlbmVyID0gbGlzdGVuZXI7XG4gIHRoaXMub24odHlwZSwgZyk7XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG4vLyBlbWl0cyBhICdyZW1vdmVMaXN0ZW5lcicgZXZlbnQgaWZmIHRoZSBsaXN0ZW5lciB3YXMgcmVtb3ZlZFxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5yZW1vdmVMaXN0ZW5lciA9IGZ1bmN0aW9uKHR5cGUsIGxpc3RlbmVyKSB7XG4gIHZhciBsaXN0LCBwb3NpdGlvbiwgbGVuZ3RoLCBpO1xuXG4gIGlmICghaXNGdW5jdGlvbihsaXN0ZW5lcikpXG4gICAgdGhyb3cgVHlwZUVycm9yKCdsaXN0ZW5lciBtdXN0IGJlIGEgZnVuY3Rpb24nKTtcblxuICBpZiAoIXRoaXMuX2V2ZW50cyB8fCAhdGhpcy5fZXZlbnRzW3R5cGVdKVxuICAgIHJldHVybiB0aGlzO1xuXG4gIGxpc3QgPSB0aGlzLl9ldmVudHNbdHlwZV07XG4gIGxlbmd0aCA9IGxpc3QubGVuZ3RoO1xuICBwb3NpdGlvbiA9IC0xO1xuXG4gIGlmIChsaXN0ID09PSBsaXN0ZW5lciB8fFxuICAgICAgKGlzRnVuY3Rpb24obGlzdC5saXN0ZW5lcikgJiYgbGlzdC5saXN0ZW5lciA9PT0gbGlzdGVuZXIpKSB7XG4gICAgZGVsZXRlIHRoaXMuX2V2ZW50c1t0eXBlXTtcbiAgICBpZiAodGhpcy5fZXZlbnRzLnJlbW92ZUxpc3RlbmVyKVxuICAgICAgdGhpcy5lbWl0KCdyZW1vdmVMaXN0ZW5lcicsIHR5cGUsIGxpc3RlbmVyKTtcblxuICB9IGVsc2UgaWYgKGlzT2JqZWN0KGxpc3QpKSB7XG4gICAgZm9yIChpID0gbGVuZ3RoOyBpLS0gPiAwOykge1xuICAgICAgaWYgKGxpc3RbaV0gPT09IGxpc3RlbmVyIHx8XG4gICAgICAgICAgKGxpc3RbaV0ubGlzdGVuZXIgJiYgbGlzdFtpXS5saXN0ZW5lciA9PT0gbGlzdGVuZXIpKSB7XG4gICAgICAgIHBvc2l0aW9uID0gaTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHBvc2l0aW9uIDwgMClcbiAgICAgIHJldHVybiB0aGlzO1xuXG4gICAgaWYgKGxpc3QubGVuZ3RoID09PSAxKSB7XG4gICAgICBsaXN0Lmxlbmd0aCA9IDA7XG4gICAgICBkZWxldGUgdGhpcy5fZXZlbnRzW3R5cGVdO1xuICAgIH0gZWxzZSB7XG4gICAgICBsaXN0LnNwbGljZShwb3NpdGlvbiwgMSk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuX2V2ZW50cy5yZW1vdmVMaXN0ZW5lcilcbiAgICAgIHRoaXMuZW1pdCgncmVtb3ZlTGlzdGVuZXInLCB0eXBlLCBsaXN0ZW5lcik7XG4gIH1cblxuICByZXR1cm4gdGhpcztcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUucmVtb3ZlQWxsTGlzdGVuZXJzID0gZnVuY3Rpb24odHlwZSkge1xuICB2YXIga2V5LCBsaXN0ZW5lcnM7XG5cbiAgaWYgKCF0aGlzLl9ldmVudHMpXG4gICAgcmV0dXJuIHRoaXM7XG5cbiAgLy8gbm90IGxpc3RlbmluZyBmb3IgcmVtb3ZlTGlzdGVuZXIsIG5vIG5lZWQgdG8gZW1pdFxuICBpZiAoIXRoaXMuX2V2ZW50cy5yZW1vdmVMaXN0ZW5lcikge1xuICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAwKVxuICAgICAgdGhpcy5fZXZlbnRzID0ge307XG4gICAgZWxzZSBpZiAodGhpcy5fZXZlbnRzW3R5cGVdKVxuICAgICAgZGVsZXRlIHRoaXMuX2V2ZW50c1t0eXBlXTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8vIGVtaXQgcmVtb3ZlTGlzdGVuZXIgZm9yIGFsbCBsaXN0ZW5lcnMgb24gYWxsIGV2ZW50c1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgIGZvciAoa2V5IGluIHRoaXMuX2V2ZW50cykge1xuICAgICAgaWYgKGtleSA9PT0gJ3JlbW92ZUxpc3RlbmVyJykgY29udGludWU7XG4gICAgICB0aGlzLnJlbW92ZUFsbExpc3RlbmVycyhrZXkpO1xuICAgIH1cbiAgICB0aGlzLnJlbW92ZUFsbExpc3RlbmVycygncmVtb3ZlTGlzdGVuZXInKTtcbiAgICB0aGlzLl9ldmVudHMgPSB7fTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGxpc3RlbmVycyA9IHRoaXMuX2V2ZW50c1t0eXBlXTtcblxuICBpZiAoaXNGdW5jdGlvbihsaXN0ZW5lcnMpKSB7XG4gICAgdGhpcy5yZW1vdmVMaXN0ZW5lcih0eXBlLCBsaXN0ZW5lcnMpO1xuICB9IGVsc2Uge1xuICAgIC8vIExJRk8gb3JkZXJcbiAgICB3aGlsZSAobGlzdGVuZXJzLmxlbmd0aClcbiAgICAgIHRoaXMucmVtb3ZlTGlzdGVuZXIodHlwZSwgbGlzdGVuZXJzW2xpc3RlbmVycy5sZW5ndGggLSAxXSk7XG4gIH1cbiAgZGVsZXRlIHRoaXMuX2V2ZW50c1t0eXBlXTtcblxuICByZXR1cm4gdGhpcztcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUubGlzdGVuZXJzID0gZnVuY3Rpb24odHlwZSkge1xuICB2YXIgcmV0O1xuICBpZiAoIXRoaXMuX2V2ZW50cyB8fCAhdGhpcy5fZXZlbnRzW3R5cGVdKVxuICAgIHJldCA9IFtdO1xuICBlbHNlIGlmIChpc0Z1bmN0aW9uKHRoaXMuX2V2ZW50c1t0eXBlXSkpXG4gICAgcmV0ID0gW3RoaXMuX2V2ZW50c1t0eXBlXV07XG4gIGVsc2VcbiAgICByZXQgPSB0aGlzLl9ldmVudHNbdHlwZV0uc2xpY2UoKTtcbiAgcmV0dXJuIHJldDtcbn07XG5cbkV2ZW50RW1pdHRlci5saXN0ZW5lckNvdW50ID0gZnVuY3Rpb24oZW1pdHRlciwgdHlwZSkge1xuICB2YXIgcmV0O1xuICBpZiAoIWVtaXR0ZXIuX2V2ZW50cyB8fCAhZW1pdHRlci5fZXZlbnRzW3R5cGVdKVxuICAgIHJldCA9IDA7XG4gIGVsc2UgaWYgKGlzRnVuY3Rpb24oZW1pdHRlci5fZXZlbnRzW3R5cGVdKSlcbiAgICByZXQgPSAxO1xuICBlbHNlXG4gICAgcmV0ID0gZW1pdHRlci5fZXZlbnRzW3R5cGVdLmxlbmd0aDtcbiAgcmV0dXJuIHJldDtcbn07XG5cbmZ1bmN0aW9uIGlzRnVuY3Rpb24oYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnZnVuY3Rpb24nO1xufVxuXG5mdW5jdGlvbiBpc051bWJlcihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdudW1iZXInO1xufVxuXG5mdW5jdGlvbiBpc09iamVjdChhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdvYmplY3QnICYmIGFyZyAhPT0gbnVsbDtcbn1cblxuZnVuY3Rpb24gaXNVbmRlZmluZWQoYXJnKSB7XG4gIHJldHVybiBhcmcgPT09IHZvaWQgMDtcbn1cbiIsIi8qKlxuICogRGV0ZXJtaW5lIGlmIGFuIG9iamVjdCBpcyBCdWZmZXJcbiAqXG4gKiBBdXRob3I6ICAgRmVyb3NzIEFib3VraGFkaWplaCA8ZmVyb3NzQGZlcm9zcy5vcmc+IDxodHRwOi8vZmVyb3NzLm9yZz5cbiAqIExpY2Vuc2U6ICBNSVRcbiAqXG4gKiBgbnBtIGluc3RhbGwgaXMtYnVmZmVyYFxuICovXG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKG9iaikge1xuICByZXR1cm4gISEob2JqICE9IG51bGwgJiZcbiAgICAob2JqLl9pc0J1ZmZlciB8fCAvLyBGb3IgU2FmYXJpIDUtNyAobWlzc2luZyBPYmplY3QucHJvdG90eXBlLmNvbnN0cnVjdG9yKVxuICAgICAgKG9iai5jb25zdHJ1Y3RvciAmJlxuICAgICAgdHlwZW9mIG9iai5jb25zdHJ1Y3Rvci5pc0J1ZmZlciA9PT0gJ2Z1bmN0aW9uJyAmJlxuICAgICAgb2JqLmNvbnN0cnVjdG9yLmlzQnVmZmVyKG9iaikpXG4gICAgKSlcbn1cbiIsIm1vZHVsZS5leHBvcnRzID0gQXJyYXkuaXNBcnJheSB8fCBmdW5jdGlvbiAoYXJyKSB7XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwoYXJyKSA9PSAnW29iamVjdCBBcnJheV0nO1xufTtcbiIsIi8vIHNoaW0gZm9yIHVzaW5nIHByb2Nlc3MgaW4gYnJvd3NlclxuXG52YXIgcHJvY2VzcyA9IG1vZHVsZS5leHBvcnRzID0ge307XG52YXIgcXVldWUgPSBbXTtcbnZhciBkcmFpbmluZyA9IGZhbHNlO1xudmFyIGN1cnJlbnRRdWV1ZTtcbnZhciBxdWV1ZUluZGV4ID0gLTE7XG5cbmZ1bmN0aW9uIGNsZWFuVXBOZXh0VGljaygpIHtcbiAgICBkcmFpbmluZyA9IGZhbHNlO1xuICAgIGlmIChjdXJyZW50UXVldWUubGVuZ3RoKSB7XG4gICAgICAgIHF1ZXVlID0gY3VycmVudFF1ZXVlLmNvbmNhdChxdWV1ZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcXVldWVJbmRleCA9IC0xO1xuICAgIH1cbiAgICBpZiAocXVldWUubGVuZ3RoKSB7XG4gICAgICAgIGRyYWluUXVldWUoKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGRyYWluUXVldWUoKSB7XG4gICAgaWYgKGRyYWluaW5nKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdmFyIHRpbWVvdXQgPSBzZXRUaW1lb3V0KGNsZWFuVXBOZXh0VGljayk7XG4gICAgZHJhaW5pbmcgPSB0cnVlO1xuXG4gICAgdmFyIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB3aGlsZShsZW4pIHtcbiAgICAgICAgY3VycmVudFF1ZXVlID0gcXVldWU7XG4gICAgICAgIHF1ZXVlID0gW107XG4gICAgICAgIHdoaWxlICgrK3F1ZXVlSW5kZXggPCBsZW4pIHtcbiAgICAgICAgICAgIGlmIChjdXJyZW50UXVldWUpIHtcbiAgICAgICAgICAgICAgICBjdXJyZW50UXVldWVbcXVldWVJbmRleF0ucnVuKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcXVldWVJbmRleCA9IC0xO1xuICAgICAgICBsZW4gPSBxdWV1ZS5sZW5ndGg7XG4gICAgfVxuICAgIGN1cnJlbnRRdWV1ZSA9IG51bGw7XG4gICAgZHJhaW5pbmcgPSBmYWxzZTtcbiAgICBjbGVhclRpbWVvdXQodGltZW91dCk7XG59XG5cbnByb2Nlc3MubmV4dFRpY2sgPSBmdW5jdGlvbiAoZnVuKSB7XG4gICAgdmFyIGFyZ3MgPSBuZXcgQXJyYXkoYXJndW1lbnRzLmxlbmd0aCAtIDEpO1xuICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID4gMSkge1xuICAgICAgICBmb3IgKHZhciBpID0gMTsgaSA8IGFyZ3VtZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgYXJnc1tpIC0gMV0gPSBhcmd1bWVudHNbaV07XG4gICAgICAgIH1cbiAgICB9XG4gICAgcXVldWUucHVzaChuZXcgSXRlbShmdW4sIGFyZ3MpKTtcbiAgICBpZiAocXVldWUubGVuZ3RoID09PSAxICYmICFkcmFpbmluZykge1xuICAgICAgICBzZXRUaW1lb3V0KGRyYWluUXVldWUsIDApO1xuICAgIH1cbn07XG5cbi8vIHY4IGxpa2VzIHByZWRpY3RpYmxlIG9iamVjdHNcbmZ1bmN0aW9uIEl0ZW0oZnVuLCBhcnJheSkge1xuICAgIHRoaXMuZnVuID0gZnVuO1xuICAgIHRoaXMuYXJyYXkgPSBhcnJheTtcbn1cbkl0ZW0ucHJvdG90eXBlLnJ1biA9IGZ1bmN0aW9uICgpIHtcbiAgICB0aGlzLmZ1bi5hcHBseShudWxsLCB0aGlzLmFycmF5KTtcbn07XG5wcm9jZXNzLnRpdGxlID0gJ2Jyb3dzZXInO1xucHJvY2Vzcy5icm93c2VyID0gdHJ1ZTtcbnByb2Nlc3MuZW52ID0ge307XG5wcm9jZXNzLmFyZ3YgPSBbXTtcbnByb2Nlc3MudmVyc2lvbiA9ICcnOyAvLyBlbXB0eSBzdHJpbmcgdG8gYXZvaWQgcmVnZXhwIGlzc3Vlc1xucHJvY2Vzcy52ZXJzaW9ucyA9IHt9O1xuXG5mdW5jdGlvbiBub29wKCkge31cblxucHJvY2Vzcy5vbiA9IG5vb3A7XG5wcm9jZXNzLmFkZExpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3Mub25jZSA9IG5vb3A7XG5wcm9jZXNzLm9mZiA9IG5vb3A7XG5wcm9jZXNzLnJlbW92ZUxpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlQWxsTGlzdGVuZXJzID0gbm9vcDtcbnByb2Nlc3MuZW1pdCA9IG5vb3A7XG5cbnByb2Nlc3MuYmluZGluZyA9IGZ1bmN0aW9uIChuYW1lKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwcm9jZXNzLmJpbmRpbmcgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcblxucHJvY2Vzcy5jd2QgPSBmdW5jdGlvbiAoKSB7IHJldHVybiAnLycgfTtcbnByb2Nlc3MuY2hkaXIgPSBmdW5jdGlvbiAoZGlyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwcm9jZXNzLmNoZGlyIGlzIG5vdCBzdXBwb3J0ZWQnKTtcbn07XG5wcm9jZXNzLnVtYXNrID0gZnVuY3Rpb24oKSB7IHJldHVybiAwOyB9O1xuIiwibW9kdWxlLmV4cG9ydHMgPSByZXF1aXJlKFwiLi9saWIvX3N0cmVhbV9kdXBsZXguanNcIilcbiIsIi8vIGEgZHVwbGV4IHN0cmVhbSBpcyBqdXN0IGEgc3RyZWFtIHRoYXQgaXMgYm90aCByZWFkYWJsZSBhbmQgd3JpdGFibGUuXG4vLyBTaW5jZSBKUyBkb2Vzbid0IGhhdmUgbXVsdGlwbGUgcHJvdG90eXBhbCBpbmhlcml0YW5jZSwgdGhpcyBjbGFzc1xuLy8gcHJvdG90eXBhbGx5IGluaGVyaXRzIGZyb20gUmVhZGFibGUsIGFuZCB0aGVuIHBhcmFzaXRpY2FsbHkgZnJvbVxuLy8gV3JpdGFibGUuXG5cbid1c2Ugc3RyaWN0JztcblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciBvYmplY3RLZXlzID0gT2JqZWN0LmtleXMgfHwgZnVuY3Rpb24gKG9iaikge1xuICB2YXIga2V5cyA9IFtdO1xuICBmb3IgKHZhciBrZXkgaW4gb2JqKSBrZXlzLnB1c2goa2V5KTtcbiAgcmV0dXJuIGtleXM7XG59XG4vKjwvcmVwbGFjZW1lbnQ+Ki9cblxuXG5tb2R1bGUuZXhwb3J0cyA9IER1cGxleDtcblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciBwcm9jZXNzTmV4dFRpY2sgPSByZXF1aXJlKCdwcm9jZXNzLW5leHRpY2stYXJncycpO1xuLyo8L3JlcGxhY2VtZW50PiovXG5cblxuXG4vKjxyZXBsYWNlbWVudD4qL1xudmFyIHV0aWwgPSByZXF1aXJlKCdjb3JlLXV0aWwtaXMnKTtcbnV0aWwuaW5oZXJpdHMgPSByZXF1aXJlKCdpbmhlcml0cycpO1xuLyo8L3JlcGxhY2VtZW50PiovXG5cbnZhciBSZWFkYWJsZSA9IHJlcXVpcmUoJy4vX3N0cmVhbV9yZWFkYWJsZScpO1xudmFyIFdyaXRhYmxlID0gcmVxdWlyZSgnLi9fc3RyZWFtX3dyaXRhYmxlJyk7XG5cbnV0aWwuaW5oZXJpdHMoRHVwbGV4LCBSZWFkYWJsZSk7XG5cbnZhciBrZXlzID0gb2JqZWN0S2V5cyhXcml0YWJsZS5wcm90b3R5cGUpO1xuZm9yICh2YXIgdiA9IDA7IHYgPCBrZXlzLmxlbmd0aDsgdisrKSB7XG4gIHZhciBtZXRob2QgPSBrZXlzW3ZdO1xuICBpZiAoIUR1cGxleC5wcm90b3R5cGVbbWV0aG9kXSlcbiAgICBEdXBsZXgucHJvdG90eXBlW21ldGhvZF0gPSBXcml0YWJsZS5wcm90b3R5cGVbbWV0aG9kXTtcbn1cblxuZnVuY3Rpb24gRHVwbGV4KG9wdGlvbnMpIHtcbiAgaWYgKCEodGhpcyBpbnN0YW5jZW9mIER1cGxleCkpXG4gICAgcmV0dXJuIG5ldyBEdXBsZXgob3B0aW9ucyk7XG5cbiAgUmVhZGFibGUuY2FsbCh0aGlzLCBvcHRpb25zKTtcbiAgV3JpdGFibGUuY2FsbCh0aGlzLCBvcHRpb25zKTtcblxuICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJlYWRhYmxlID09PSBmYWxzZSlcbiAgICB0aGlzLnJlYWRhYmxlID0gZmFsc2U7XG5cbiAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy53cml0YWJsZSA9PT0gZmFsc2UpXG4gICAgdGhpcy53cml0YWJsZSA9IGZhbHNlO1xuXG4gIHRoaXMuYWxsb3dIYWxmT3BlbiA9IHRydWU7XG4gIGlmIChvcHRpb25zICYmIG9wdGlvbnMuYWxsb3dIYWxmT3BlbiA9PT0gZmFsc2UpXG4gICAgdGhpcy5hbGxvd0hhbGZPcGVuID0gZmFsc2U7XG5cbiAgdGhpcy5vbmNlKCdlbmQnLCBvbmVuZCk7XG59XG5cbi8vIHRoZSBuby1oYWxmLW9wZW4gZW5mb3JjZXJcbmZ1bmN0aW9uIG9uZW5kKCkge1xuICAvLyBpZiB3ZSBhbGxvdyBoYWxmLW9wZW4gc3RhdGUsIG9yIGlmIHRoZSB3cml0YWJsZSBzaWRlIGVuZGVkLFxuICAvLyB0aGVuIHdlJ3JlIG9rLlxuICBpZiAodGhpcy5hbGxvd0hhbGZPcGVuIHx8IHRoaXMuX3dyaXRhYmxlU3RhdGUuZW5kZWQpXG4gICAgcmV0dXJuO1xuXG4gIC8vIG5vIG1vcmUgZGF0YSBjYW4gYmUgd3JpdHRlbi5cbiAgLy8gQnV0IGFsbG93IG1vcmUgd3JpdGVzIHRvIGhhcHBlbiBpbiB0aGlzIHRpY2suXG4gIHByb2Nlc3NOZXh0VGljayhvbkVuZE5ULCB0aGlzKTtcbn1cblxuZnVuY3Rpb24gb25FbmROVChzZWxmKSB7XG4gIHNlbGYuZW5kKCk7XG59XG5cbmZ1bmN0aW9uIGZvckVhY2ggKHhzLCBmKSB7XG4gIGZvciAodmFyIGkgPSAwLCBsID0geHMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgZih4c1tpXSwgaSk7XG4gIH1cbn1cbiIsIi8vIGEgcGFzc3Rocm91Z2ggc3RyZWFtLlxuLy8gYmFzaWNhbGx5IGp1c3QgdGhlIG1vc3QgbWluaW1hbCBzb3J0IG9mIFRyYW5zZm9ybSBzdHJlYW0uXG4vLyBFdmVyeSB3cml0dGVuIGNodW5rIGdldHMgb3V0cHV0IGFzLWlzLlxuXG4ndXNlIHN0cmljdCc7XG5cbm1vZHVsZS5leHBvcnRzID0gUGFzc1Rocm91Z2g7XG5cbnZhciBUcmFuc2Zvcm0gPSByZXF1aXJlKCcuL19zdHJlYW1fdHJhbnNmb3JtJyk7XG5cbi8qPHJlcGxhY2VtZW50PiovXG52YXIgdXRpbCA9IHJlcXVpcmUoJ2NvcmUtdXRpbC1pcycpO1xudXRpbC5pbmhlcml0cyA9IHJlcXVpcmUoJ2luaGVyaXRzJyk7XG4vKjwvcmVwbGFjZW1lbnQ+Ki9cblxudXRpbC5pbmhlcml0cyhQYXNzVGhyb3VnaCwgVHJhbnNmb3JtKTtcblxuZnVuY3Rpb24gUGFzc1Rocm91Z2gob3B0aW9ucykge1xuICBpZiAoISh0aGlzIGluc3RhbmNlb2YgUGFzc1Rocm91Z2gpKVxuICAgIHJldHVybiBuZXcgUGFzc1Rocm91Z2gob3B0aW9ucyk7XG5cbiAgVHJhbnNmb3JtLmNhbGwodGhpcywgb3B0aW9ucyk7XG59XG5cblBhc3NUaHJvdWdoLnByb3RvdHlwZS5fdHJhbnNmb3JtID0gZnVuY3Rpb24oY2h1bmssIGVuY29kaW5nLCBjYikge1xuICBjYihudWxsLCBjaHVuayk7XG59O1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG5tb2R1bGUuZXhwb3J0cyA9IFJlYWRhYmxlO1xuXG4vKjxyZXBsYWNlbWVudD4qL1xudmFyIHByb2Nlc3NOZXh0VGljayA9IHJlcXVpcmUoJ3Byb2Nlc3MtbmV4dGljay1hcmdzJyk7XG4vKjwvcmVwbGFjZW1lbnQ+Ki9cblxuXG4vKjxyZXBsYWNlbWVudD4qL1xudmFyIGlzQXJyYXkgPSByZXF1aXJlKCdpc2FycmF5Jyk7XG4vKjwvcmVwbGFjZW1lbnQ+Ki9cblxuXG4vKjxyZXBsYWNlbWVudD4qL1xudmFyIEJ1ZmZlciA9IHJlcXVpcmUoJ2J1ZmZlcicpLkJ1ZmZlcjtcbi8qPC9yZXBsYWNlbWVudD4qL1xuXG5SZWFkYWJsZS5SZWFkYWJsZVN0YXRlID0gUmVhZGFibGVTdGF0ZTtcblxudmFyIEVFID0gcmVxdWlyZSgnZXZlbnRzJykuRXZlbnRFbWl0dGVyO1xuXG4vKjxyZXBsYWNlbWVudD4qL1xuaWYgKCFFRS5saXN0ZW5lckNvdW50KSBFRS5saXN0ZW5lckNvdW50ID0gZnVuY3Rpb24oZW1pdHRlciwgdHlwZSkge1xuICByZXR1cm4gZW1pdHRlci5saXN0ZW5lcnModHlwZSkubGVuZ3RoO1xufTtcbi8qPC9yZXBsYWNlbWVudD4qL1xuXG5cblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciBTdHJlYW07XG4oZnVuY3Rpb24gKCl7dHJ5e1xuICBTdHJlYW0gPSByZXF1aXJlKCdzdCcgKyAncmVhbScpO1xufWNhdGNoKF8pe31maW5hbGx5e1xuICBpZiAoIVN0cmVhbSlcbiAgICBTdHJlYW0gPSByZXF1aXJlKCdldmVudHMnKS5FdmVudEVtaXR0ZXI7XG59fSgpKVxuLyo8L3JlcGxhY2VtZW50PiovXG5cbnZhciBCdWZmZXIgPSByZXF1aXJlKCdidWZmZXInKS5CdWZmZXI7XG5cbi8qPHJlcGxhY2VtZW50PiovXG52YXIgdXRpbCA9IHJlcXVpcmUoJ2NvcmUtdXRpbC1pcycpO1xudXRpbC5pbmhlcml0cyA9IHJlcXVpcmUoJ2luaGVyaXRzJyk7XG4vKjwvcmVwbGFjZW1lbnQ+Ki9cblxuXG5cbi8qPHJlcGxhY2VtZW50PiovXG52YXIgZGVidWcgPSByZXF1aXJlKCd1dGlsJyk7XG5pZiAoZGVidWcgJiYgZGVidWcuZGVidWdsb2cpIHtcbiAgZGVidWcgPSBkZWJ1Zy5kZWJ1Z2xvZygnc3RyZWFtJyk7XG59IGVsc2Uge1xuICBkZWJ1ZyA9IGZ1bmN0aW9uICgpIHt9O1xufVxuLyo8L3JlcGxhY2VtZW50PiovXG5cbnZhciBTdHJpbmdEZWNvZGVyO1xuXG51dGlsLmluaGVyaXRzKFJlYWRhYmxlLCBTdHJlYW0pO1xuXG5mdW5jdGlvbiBSZWFkYWJsZVN0YXRlKG9wdGlvbnMsIHN0cmVhbSkge1xuICB2YXIgRHVwbGV4ID0gcmVxdWlyZSgnLi9fc3RyZWFtX2R1cGxleCcpO1xuXG4gIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuXG4gIC8vIG9iamVjdCBzdHJlYW0gZmxhZy4gVXNlZCB0byBtYWtlIHJlYWQobikgaWdub3JlIG4gYW5kIHRvXG4gIC8vIG1ha2UgYWxsIHRoZSBidWZmZXIgbWVyZ2luZyBhbmQgbGVuZ3RoIGNoZWNrcyBnbyBhd2F5XG4gIHRoaXMub2JqZWN0TW9kZSA9ICEhb3B0aW9ucy5vYmplY3RNb2RlO1xuXG4gIGlmIChzdHJlYW0gaW5zdGFuY2VvZiBEdXBsZXgpXG4gICAgdGhpcy5vYmplY3RNb2RlID0gdGhpcy5vYmplY3RNb2RlIHx8ICEhb3B0aW9ucy5yZWFkYWJsZU9iamVjdE1vZGU7XG5cbiAgLy8gdGhlIHBvaW50IGF0IHdoaWNoIGl0IHN0b3BzIGNhbGxpbmcgX3JlYWQoKSB0byBmaWxsIHRoZSBidWZmZXJcbiAgLy8gTm90ZTogMCBpcyBhIHZhbGlkIHZhbHVlLCBtZWFucyBcImRvbid0IGNhbGwgX3JlYWQgcHJlZW1wdGl2ZWx5IGV2ZXJcIlxuICB2YXIgaHdtID0gb3B0aW9ucy5oaWdoV2F0ZXJNYXJrO1xuICB2YXIgZGVmYXVsdEh3bSA9IHRoaXMub2JqZWN0TW9kZSA/IDE2IDogMTYgKiAxMDI0O1xuICB0aGlzLmhpZ2hXYXRlck1hcmsgPSAoaHdtIHx8IGh3bSA9PT0gMCkgPyBod20gOiBkZWZhdWx0SHdtO1xuXG4gIC8vIGNhc3QgdG8gaW50cy5cbiAgdGhpcy5oaWdoV2F0ZXJNYXJrID0gfn50aGlzLmhpZ2hXYXRlck1hcms7XG5cbiAgdGhpcy5idWZmZXIgPSBbXTtcbiAgdGhpcy5sZW5ndGggPSAwO1xuICB0aGlzLnBpcGVzID0gbnVsbDtcbiAgdGhpcy5waXBlc0NvdW50ID0gMDtcbiAgdGhpcy5mbG93aW5nID0gbnVsbDtcbiAgdGhpcy5lbmRlZCA9IGZhbHNlO1xuICB0aGlzLmVuZEVtaXR0ZWQgPSBmYWxzZTtcbiAgdGhpcy5yZWFkaW5nID0gZmFsc2U7XG5cbiAgLy8gYSBmbGFnIHRvIGJlIGFibGUgdG8gdGVsbCBpZiB0aGUgb253cml0ZSBjYiBpcyBjYWxsZWQgaW1tZWRpYXRlbHksXG4gIC8vIG9yIG9uIGEgbGF0ZXIgdGljay4gIFdlIHNldCB0aGlzIHRvIHRydWUgYXQgZmlyc3QsIGJlY2F1c2UgYW55XG4gIC8vIGFjdGlvbnMgdGhhdCBzaG91bGRuJ3QgaGFwcGVuIHVudGlsIFwibGF0ZXJcIiBzaG91bGQgZ2VuZXJhbGx5IGFsc29cbiAgLy8gbm90IGhhcHBlbiBiZWZvcmUgdGhlIGZpcnN0IHdyaXRlIGNhbGwuXG4gIHRoaXMuc3luYyA9IHRydWU7XG5cbiAgLy8gd2hlbmV2ZXIgd2UgcmV0dXJuIG51bGwsIHRoZW4gd2Ugc2V0IGEgZmxhZyB0byBzYXlcbiAgLy8gdGhhdCB3ZSdyZSBhd2FpdGluZyBhICdyZWFkYWJsZScgZXZlbnQgZW1pc3Npb24uXG4gIHRoaXMubmVlZFJlYWRhYmxlID0gZmFsc2U7XG4gIHRoaXMuZW1pdHRlZFJlYWRhYmxlID0gZmFsc2U7XG4gIHRoaXMucmVhZGFibGVMaXN0ZW5pbmcgPSBmYWxzZTtcblxuICAvLyBDcnlwdG8gaXMga2luZCBvZiBvbGQgYW5kIGNydXN0eS4gIEhpc3RvcmljYWxseSwgaXRzIGRlZmF1bHQgc3RyaW5nXG4gIC8vIGVuY29kaW5nIGlzICdiaW5hcnknIHNvIHdlIGhhdmUgdG8gbWFrZSB0aGlzIGNvbmZpZ3VyYWJsZS5cbiAgLy8gRXZlcnl0aGluZyBlbHNlIGluIHRoZSB1bml2ZXJzZSB1c2VzICd1dGY4JywgdGhvdWdoLlxuICB0aGlzLmRlZmF1bHRFbmNvZGluZyA9IG9wdGlvbnMuZGVmYXVsdEVuY29kaW5nIHx8ICd1dGY4JztcblxuICAvLyB3aGVuIHBpcGluZywgd2Ugb25seSBjYXJlIGFib3V0ICdyZWFkYWJsZScgZXZlbnRzIHRoYXQgaGFwcGVuXG4gIC8vIGFmdGVyIHJlYWQoKWluZyBhbGwgdGhlIGJ5dGVzIGFuZCBub3QgZ2V0dGluZyBhbnkgcHVzaGJhY2suXG4gIHRoaXMucmFuT3V0ID0gZmFsc2U7XG5cbiAgLy8gdGhlIG51bWJlciBvZiB3cml0ZXJzIHRoYXQgYXJlIGF3YWl0aW5nIGEgZHJhaW4gZXZlbnQgaW4gLnBpcGUoKXNcbiAgdGhpcy5hd2FpdERyYWluID0gMDtcblxuICAvLyBpZiB0cnVlLCBhIG1heWJlUmVhZE1vcmUgaGFzIGJlZW4gc2NoZWR1bGVkXG4gIHRoaXMucmVhZGluZ01vcmUgPSBmYWxzZTtcblxuICB0aGlzLmRlY29kZXIgPSBudWxsO1xuICB0aGlzLmVuY29kaW5nID0gbnVsbDtcbiAgaWYgKG9wdGlvbnMuZW5jb2RpbmcpIHtcbiAgICBpZiAoIVN0cmluZ0RlY29kZXIpXG4gICAgICBTdHJpbmdEZWNvZGVyID0gcmVxdWlyZSgnc3RyaW5nX2RlY29kZXIvJykuU3RyaW5nRGVjb2RlcjtcbiAgICB0aGlzLmRlY29kZXIgPSBuZXcgU3RyaW5nRGVjb2RlcihvcHRpb25zLmVuY29kaW5nKTtcbiAgICB0aGlzLmVuY29kaW5nID0gb3B0aW9ucy5lbmNvZGluZztcbiAgfVxufVxuXG5mdW5jdGlvbiBSZWFkYWJsZShvcHRpb25zKSB7XG4gIHZhciBEdXBsZXggPSByZXF1aXJlKCcuL19zdHJlYW1fZHVwbGV4Jyk7XG5cbiAgaWYgKCEodGhpcyBpbnN0YW5jZW9mIFJlYWRhYmxlKSlcbiAgICByZXR1cm4gbmV3IFJlYWRhYmxlKG9wdGlvbnMpO1xuXG4gIHRoaXMuX3JlYWRhYmxlU3RhdGUgPSBuZXcgUmVhZGFibGVTdGF0ZShvcHRpb25zLCB0aGlzKTtcblxuICAvLyBsZWdhY3lcbiAgdGhpcy5yZWFkYWJsZSA9IHRydWU7XG5cbiAgaWYgKG9wdGlvbnMgJiYgdHlwZW9mIG9wdGlvbnMucmVhZCA9PT0gJ2Z1bmN0aW9uJylcbiAgICB0aGlzLl9yZWFkID0gb3B0aW9ucy5yZWFkO1xuXG4gIFN0cmVhbS5jYWxsKHRoaXMpO1xufVxuXG4vLyBNYW51YWxseSBzaG92ZSBzb21ldGhpbmcgaW50byB0aGUgcmVhZCgpIGJ1ZmZlci5cbi8vIFRoaXMgcmV0dXJucyB0cnVlIGlmIHRoZSBoaWdoV2F0ZXJNYXJrIGhhcyBub3QgYmVlbiBoaXQgeWV0LFxuLy8gc2ltaWxhciB0byBob3cgV3JpdGFibGUud3JpdGUoKSByZXR1cm5zIHRydWUgaWYgeW91IHNob3VsZFxuLy8gd3JpdGUoKSBzb21lIG1vcmUuXG5SZWFkYWJsZS5wcm90b3R5cGUucHVzaCA9IGZ1bmN0aW9uKGNodW5rLCBlbmNvZGluZykge1xuICB2YXIgc3RhdGUgPSB0aGlzLl9yZWFkYWJsZVN0YXRlO1xuXG4gIGlmICghc3RhdGUub2JqZWN0TW9kZSAmJiB0eXBlb2YgY2h1bmsgPT09ICdzdHJpbmcnKSB7XG4gICAgZW5jb2RpbmcgPSBlbmNvZGluZyB8fCBzdGF0ZS5kZWZhdWx0RW5jb2Rpbmc7XG4gICAgaWYgKGVuY29kaW5nICE9PSBzdGF0ZS5lbmNvZGluZykge1xuICAgICAgY2h1bmsgPSBuZXcgQnVmZmVyKGNodW5rLCBlbmNvZGluZyk7XG4gICAgICBlbmNvZGluZyA9ICcnO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZWFkYWJsZUFkZENodW5rKHRoaXMsIHN0YXRlLCBjaHVuaywgZW5jb2RpbmcsIGZhbHNlKTtcbn07XG5cbi8vIFVuc2hpZnQgc2hvdWxkICphbHdheXMqIGJlIHNvbWV0aGluZyBkaXJlY3RseSBvdXQgb2YgcmVhZCgpXG5SZWFkYWJsZS5wcm90b3R5cGUudW5zaGlmdCA9IGZ1bmN0aW9uKGNodW5rKSB7XG4gIHZhciBzdGF0ZSA9IHRoaXMuX3JlYWRhYmxlU3RhdGU7XG4gIHJldHVybiByZWFkYWJsZUFkZENodW5rKHRoaXMsIHN0YXRlLCBjaHVuaywgJycsIHRydWUpO1xufTtcblxuUmVhZGFibGUucHJvdG90eXBlLmlzUGF1c2VkID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiB0aGlzLl9yZWFkYWJsZVN0YXRlLmZsb3dpbmcgPT09IGZhbHNlO1xufTtcblxuZnVuY3Rpb24gcmVhZGFibGVBZGRDaHVuayhzdHJlYW0sIHN0YXRlLCBjaHVuaywgZW5jb2RpbmcsIGFkZFRvRnJvbnQpIHtcbiAgdmFyIGVyID0gY2h1bmtJbnZhbGlkKHN0YXRlLCBjaHVuayk7XG4gIGlmIChlcikge1xuICAgIHN0cmVhbS5lbWl0KCdlcnJvcicsIGVyKTtcbiAgfSBlbHNlIGlmIChjaHVuayA9PT0gbnVsbCkge1xuICAgIHN0YXRlLnJlYWRpbmcgPSBmYWxzZTtcbiAgICBvbkVvZkNodW5rKHN0cmVhbSwgc3RhdGUpO1xuICB9IGVsc2UgaWYgKHN0YXRlLm9iamVjdE1vZGUgfHwgY2h1bmsgJiYgY2h1bmsubGVuZ3RoID4gMCkge1xuICAgIGlmIChzdGF0ZS5lbmRlZCAmJiAhYWRkVG9Gcm9udCkge1xuICAgICAgdmFyIGUgPSBuZXcgRXJyb3IoJ3N0cmVhbS5wdXNoKCkgYWZ0ZXIgRU9GJyk7XG4gICAgICBzdHJlYW0uZW1pdCgnZXJyb3InLCBlKTtcbiAgICB9IGVsc2UgaWYgKHN0YXRlLmVuZEVtaXR0ZWQgJiYgYWRkVG9Gcm9udCkge1xuICAgICAgdmFyIGUgPSBuZXcgRXJyb3IoJ3N0cmVhbS51bnNoaWZ0KCkgYWZ0ZXIgZW5kIGV2ZW50Jyk7XG4gICAgICBzdHJlYW0uZW1pdCgnZXJyb3InLCBlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgaWYgKHN0YXRlLmRlY29kZXIgJiYgIWFkZFRvRnJvbnQgJiYgIWVuY29kaW5nKVxuICAgICAgICBjaHVuayA9IHN0YXRlLmRlY29kZXIud3JpdGUoY2h1bmspO1xuXG4gICAgICBpZiAoIWFkZFRvRnJvbnQpXG4gICAgICAgIHN0YXRlLnJlYWRpbmcgPSBmYWxzZTtcblxuICAgICAgLy8gaWYgd2Ugd2FudCB0aGUgZGF0YSBub3csIGp1c3QgZW1pdCBpdC5cbiAgICAgIGlmIChzdGF0ZS5mbG93aW5nICYmIHN0YXRlLmxlbmd0aCA9PT0gMCAmJiAhc3RhdGUuc3luYykge1xuICAgICAgICBzdHJlYW0uZW1pdCgnZGF0YScsIGNodW5rKTtcbiAgICAgICAgc3RyZWFtLnJlYWQoMCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyB1cGRhdGUgdGhlIGJ1ZmZlciBpbmZvLlxuICAgICAgICBzdGF0ZS5sZW5ndGggKz0gc3RhdGUub2JqZWN0TW9kZSA/IDEgOiBjaHVuay5sZW5ndGg7XG4gICAgICAgIGlmIChhZGRUb0Zyb250KVxuICAgICAgICAgIHN0YXRlLmJ1ZmZlci51bnNoaWZ0KGNodW5rKTtcbiAgICAgICAgZWxzZVxuICAgICAgICAgIHN0YXRlLmJ1ZmZlci5wdXNoKGNodW5rKTtcblxuICAgICAgICBpZiAoc3RhdGUubmVlZFJlYWRhYmxlKVxuICAgICAgICAgIGVtaXRSZWFkYWJsZShzdHJlYW0pO1xuICAgICAgfVxuXG4gICAgICBtYXliZVJlYWRNb3JlKHN0cmVhbSwgc3RhdGUpO1xuICAgIH1cbiAgfSBlbHNlIGlmICghYWRkVG9Gcm9udCkge1xuICAgIHN0YXRlLnJlYWRpbmcgPSBmYWxzZTtcbiAgfVxuXG4gIHJldHVybiBuZWVkTW9yZURhdGEoc3RhdGUpO1xufVxuXG5cblxuLy8gaWYgaXQncyBwYXN0IHRoZSBoaWdoIHdhdGVyIG1hcmssIHdlIGNhbiBwdXNoIGluIHNvbWUgbW9yZS5cbi8vIEFsc28sIGlmIHdlIGhhdmUgbm8gZGF0YSB5ZXQsIHdlIGNhbiBzdGFuZCBzb21lXG4vLyBtb3JlIGJ5dGVzLiAgVGhpcyBpcyB0byB3b3JrIGFyb3VuZCBjYXNlcyB3aGVyZSBod209MCxcbi8vIHN1Y2ggYXMgdGhlIHJlcGwuICBBbHNvLCBpZiB0aGUgcHVzaCgpIHRyaWdnZXJlZCBhXG4vLyByZWFkYWJsZSBldmVudCwgYW5kIHRoZSB1c2VyIGNhbGxlZCByZWFkKGxhcmdlTnVtYmVyKSBzdWNoIHRoYXRcbi8vIG5lZWRSZWFkYWJsZSB3YXMgc2V0LCB0aGVuIHdlIG91Z2h0IHRvIHB1c2ggbW9yZSwgc28gdGhhdCBhbm90aGVyXG4vLyAncmVhZGFibGUnIGV2ZW50IHdpbGwgYmUgdHJpZ2dlcmVkLlxuZnVuY3Rpb24gbmVlZE1vcmVEYXRhKHN0YXRlKSB7XG4gIHJldHVybiAhc3RhdGUuZW5kZWQgJiZcbiAgICAgICAgIChzdGF0ZS5uZWVkUmVhZGFibGUgfHxcbiAgICAgICAgICBzdGF0ZS5sZW5ndGggPCBzdGF0ZS5oaWdoV2F0ZXJNYXJrIHx8XG4gICAgICAgICAgc3RhdGUubGVuZ3RoID09PSAwKTtcbn1cblxuLy8gYmFja3dhcmRzIGNvbXBhdGliaWxpdHkuXG5SZWFkYWJsZS5wcm90b3R5cGUuc2V0RW5jb2RpbmcgPSBmdW5jdGlvbihlbmMpIHtcbiAgaWYgKCFTdHJpbmdEZWNvZGVyKVxuICAgIFN0cmluZ0RlY29kZXIgPSByZXF1aXJlKCdzdHJpbmdfZGVjb2Rlci8nKS5TdHJpbmdEZWNvZGVyO1xuICB0aGlzLl9yZWFkYWJsZVN0YXRlLmRlY29kZXIgPSBuZXcgU3RyaW5nRGVjb2RlcihlbmMpO1xuICB0aGlzLl9yZWFkYWJsZVN0YXRlLmVuY29kaW5nID0gZW5jO1xuICByZXR1cm4gdGhpcztcbn07XG5cbi8vIERvbid0IHJhaXNlIHRoZSBod20gPiAxMjhNQlxudmFyIE1BWF9IV00gPSAweDgwMDAwMDtcbmZ1bmN0aW9uIHJvdW5kVXBUb05leHRQb3dlck9mMihuKSB7XG4gIGlmIChuID49IE1BWF9IV00pIHtcbiAgICBuID0gTUFYX0hXTTtcbiAgfSBlbHNlIHtcbiAgICAvLyBHZXQgdGhlIG5leHQgaGlnaGVzdCBwb3dlciBvZiAyXG4gICAgbi0tO1xuICAgIGZvciAodmFyIHAgPSAxOyBwIDwgMzI7IHAgPDw9IDEpIG4gfD0gbiA+PiBwO1xuICAgIG4rKztcbiAgfVxuICByZXR1cm4gbjtcbn1cblxuZnVuY3Rpb24gaG93TXVjaFRvUmVhZChuLCBzdGF0ZSkge1xuICBpZiAoc3RhdGUubGVuZ3RoID09PSAwICYmIHN0YXRlLmVuZGVkKVxuICAgIHJldHVybiAwO1xuXG4gIGlmIChzdGF0ZS5vYmplY3RNb2RlKVxuICAgIHJldHVybiBuID09PSAwID8gMCA6IDE7XG5cbiAgaWYgKG4gPT09IG51bGwgfHwgaXNOYU4obikpIHtcbiAgICAvLyBvbmx5IGZsb3cgb25lIGJ1ZmZlciBhdCBhIHRpbWVcbiAgICBpZiAoc3RhdGUuZmxvd2luZyAmJiBzdGF0ZS5idWZmZXIubGVuZ3RoKVxuICAgICAgcmV0dXJuIHN0YXRlLmJ1ZmZlclswXS5sZW5ndGg7XG4gICAgZWxzZVxuICAgICAgcmV0dXJuIHN0YXRlLmxlbmd0aDtcbiAgfVxuXG4gIGlmIChuIDw9IDApXG4gICAgcmV0dXJuIDA7XG5cbiAgLy8gSWYgd2UncmUgYXNraW5nIGZvciBtb3JlIHRoYW4gdGhlIHRhcmdldCBidWZmZXIgbGV2ZWwsXG4gIC8vIHRoZW4gcmFpc2UgdGhlIHdhdGVyIG1hcmsuICBCdW1wIHVwIHRvIHRoZSBuZXh0IGhpZ2hlc3RcbiAgLy8gcG93ZXIgb2YgMiwgdG8gcHJldmVudCBpbmNyZWFzaW5nIGl0IGV4Y2Vzc2l2ZWx5IGluIHRpbnlcbiAgLy8gYW1vdW50cy5cbiAgaWYgKG4gPiBzdGF0ZS5oaWdoV2F0ZXJNYXJrKVxuICAgIHN0YXRlLmhpZ2hXYXRlck1hcmsgPSByb3VuZFVwVG9OZXh0UG93ZXJPZjIobik7XG5cbiAgLy8gZG9uJ3QgaGF2ZSB0aGF0IG11Y2guICByZXR1cm4gbnVsbCwgdW5sZXNzIHdlJ3ZlIGVuZGVkLlxuICBpZiAobiA+IHN0YXRlLmxlbmd0aCkge1xuICAgIGlmICghc3RhdGUuZW5kZWQpIHtcbiAgICAgIHN0YXRlLm5lZWRSZWFkYWJsZSA9IHRydWU7XG4gICAgICByZXR1cm4gMDtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIHN0YXRlLmxlbmd0aDtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gbjtcbn1cblxuLy8geW91IGNhbiBvdmVycmlkZSBlaXRoZXIgdGhpcyBtZXRob2QsIG9yIHRoZSBhc3luYyBfcmVhZChuKSBiZWxvdy5cblJlYWRhYmxlLnByb3RvdHlwZS5yZWFkID0gZnVuY3Rpb24obikge1xuICBkZWJ1ZygncmVhZCcsIG4pO1xuICB2YXIgc3RhdGUgPSB0aGlzLl9yZWFkYWJsZVN0YXRlO1xuICB2YXIgbk9yaWcgPSBuO1xuXG4gIGlmICh0eXBlb2YgbiAhPT0gJ251bWJlcicgfHwgbiA+IDApXG4gICAgc3RhdGUuZW1pdHRlZFJlYWRhYmxlID0gZmFsc2U7XG5cbiAgLy8gaWYgd2UncmUgZG9pbmcgcmVhZCgwKSB0byB0cmlnZ2VyIGEgcmVhZGFibGUgZXZlbnQsIGJ1dCB3ZVxuICAvLyBhbHJlYWR5IGhhdmUgYSBidW5jaCBvZiBkYXRhIGluIHRoZSBidWZmZXIsIHRoZW4ganVzdCB0cmlnZ2VyXG4gIC8vIHRoZSAncmVhZGFibGUnIGV2ZW50IGFuZCBtb3ZlIG9uLlxuICBpZiAobiA9PT0gMCAmJlxuICAgICAgc3RhdGUubmVlZFJlYWRhYmxlICYmXG4gICAgICAoc3RhdGUubGVuZ3RoID49IHN0YXRlLmhpZ2hXYXRlck1hcmsgfHwgc3RhdGUuZW5kZWQpKSB7XG4gICAgZGVidWcoJ3JlYWQ6IGVtaXRSZWFkYWJsZScsIHN0YXRlLmxlbmd0aCwgc3RhdGUuZW5kZWQpO1xuICAgIGlmIChzdGF0ZS5sZW5ndGggPT09IDAgJiYgc3RhdGUuZW5kZWQpXG4gICAgICBlbmRSZWFkYWJsZSh0aGlzKTtcbiAgICBlbHNlXG4gICAgICBlbWl0UmVhZGFibGUodGhpcyk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBuID0gaG93TXVjaFRvUmVhZChuLCBzdGF0ZSk7XG5cbiAgLy8gaWYgd2UndmUgZW5kZWQsIGFuZCB3ZSdyZSBub3cgY2xlYXIsIHRoZW4gZmluaXNoIGl0IHVwLlxuICBpZiAobiA9PT0gMCAmJiBzdGF0ZS5lbmRlZCkge1xuICAgIGlmIChzdGF0ZS5sZW5ndGggPT09IDApXG4gICAgICBlbmRSZWFkYWJsZSh0aGlzKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIC8vIEFsbCB0aGUgYWN0dWFsIGNodW5rIGdlbmVyYXRpb24gbG9naWMgbmVlZHMgdG8gYmVcbiAgLy8gKmJlbG93KiB0aGUgY2FsbCB0byBfcmVhZC4gIFRoZSByZWFzb24gaXMgdGhhdCBpbiBjZXJ0YWluXG4gIC8vIHN5bnRoZXRpYyBzdHJlYW0gY2FzZXMsIHN1Y2ggYXMgcGFzc3Rocm91Z2ggc3RyZWFtcywgX3JlYWRcbiAgLy8gbWF5IGJlIGEgY29tcGxldGVseSBzeW5jaHJvbm91cyBvcGVyYXRpb24gd2hpY2ggbWF5IGNoYW5nZVxuICAvLyB0aGUgc3RhdGUgb2YgdGhlIHJlYWQgYnVmZmVyLCBwcm92aWRpbmcgZW5vdWdoIGRhdGEgd2hlblxuICAvLyBiZWZvcmUgdGhlcmUgd2FzICpub3QqIGVub3VnaC5cbiAgLy9cbiAgLy8gU28sIHRoZSBzdGVwcyBhcmU6XG4gIC8vIDEuIEZpZ3VyZSBvdXQgd2hhdCB0aGUgc3RhdGUgb2YgdGhpbmdzIHdpbGwgYmUgYWZ0ZXIgd2UgZG9cbiAgLy8gYSByZWFkIGZyb20gdGhlIGJ1ZmZlci5cbiAgLy9cbiAgLy8gMi4gSWYgdGhhdCByZXN1bHRpbmcgc3RhdGUgd2lsbCB0cmlnZ2VyIGEgX3JlYWQsIHRoZW4gY2FsbCBfcmVhZC5cbiAgLy8gTm90ZSB0aGF0IHRoaXMgbWF5IGJlIGFzeW5jaHJvbm91cywgb3Igc3luY2hyb25vdXMuICBZZXMsIGl0IGlzXG4gIC8vIGRlZXBseSB1Z2x5IHRvIHdyaXRlIEFQSXMgdGhpcyB3YXksIGJ1dCB0aGF0IHN0aWxsIGRvZXNuJ3QgbWVhblxuICAvLyB0aGF0IHRoZSBSZWFkYWJsZSBjbGFzcyBzaG91bGQgYmVoYXZlIGltcHJvcGVybHksIGFzIHN0cmVhbXMgYXJlXG4gIC8vIGRlc2lnbmVkIHRvIGJlIHN5bmMvYXN5bmMgYWdub3N0aWMuXG4gIC8vIFRha2Ugbm90ZSBpZiB0aGUgX3JlYWQgY2FsbCBpcyBzeW5jIG9yIGFzeW5jIChpZSwgaWYgdGhlIHJlYWQgY2FsbFxuICAvLyBoYXMgcmV0dXJuZWQgeWV0KSwgc28gdGhhdCB3ZSBrbm93IHdoZXRoZXIgb3Igbm90IGl0J3Mgc2FmZSB0byBlbWl0XG4gIC8vICdyZWFkYWJsZScgZXRjLlxuICAvL1xuICAvLyAzLiBBY3R1YWxseSBwdWxsIHRoZSByZXF1ZXN0ZWQgY2h1bmtzIG91dCBvZiB0aGUgYnVmZmVyIGFuZCByZXR1cm4uXG5cbiAgLy8gaWYgd2UgbmVlZCBhIHJlYWRhYmxlIGV2ZW50LCB0aGVuIHdlIG5lZWQgdG8gZG8gc29tZSByZWFkaW5nLlxuICB2YXIgZG9SZWFkID0gc3RhdGUubmVlZFJlYWRhYmxlO1xuICBkZWJ1ZygnbmVlZCByZWFkYWJsZScsIGRvUmVhZCk7XG5cbiAgLy8gaWYgd2UgY3VycmVudGx5IGhhdmUgbGVzcyB0aGFuIHRoZSBoaWdoV2F0ZXJNYXJrLCB0aGVuIGFsc28gcmVhZCBzb21lXG4gIGlmIChzdGF0ZS5sZW5ndGggPT09IDAgfHwgc3RhdGUubGVuZ3RoIC0gbiA8IHN0YXRlLmhpZ2hXYXRlck1hcmspIHtcbiAgICBkb1JlYWQgPSB0cnVlO1xuICAgIGRlYnVnKCdsZW5ndGggbGVzcyB0aGFuIHdhdGVybWFyaycsIGRvUmVhZCk7XG4gIH1cblxuICAvLyBob3dldmVyLCBpZiB3ZSd2ZSBlbmRlZCwgdGhlbiB0aGVyZSdzIG5vIHBvaW50LCBhbmQgaWYgd2UncmUgYWxyZWFkeVxuICAvLyByZWFkaW5nLCB0aGVuIGl0J3MgdW5uZWNlc3NhcnkuXG4gIGlmIChzdGF0ZS5lbmRlZCB8fCBzdGF0ZS5yZWFkaW5nKSB7XG4gICAgZG9SZWFkID0gZmFsc2U7XG4gICAgZGVidWcoJ3JlYWRpbmcgb3IgZW5kZWQnLCBkb1JlYWQpO1xuICB9XG5cbiAgaWYgKGRvUmVhZCkge1xuICAgIGRlYnVnKCdkbyByZWFkJyk7XG4gICAgc3RhdGUucmVhZGluZyA9IHRydWU7XG4gICAgc3RhdGUuc3luYyA9IHRydWU7XG4gICAgLy8gaWYgdGhlIGxlbmd0aCBpcyBjdXJyZW50bHkgemVybywgdGhlbiB3ZSAqbmVlZCogYSByZWFkYWJsZSBldmVudC5cbiAgICBpZiAoc3RhdGUubGVuZ3RoID09PSAwKVxuICAgICAgc3RhdGUubmVlZFJlYWRhYmxlID0gdHJ1ZTtcbiAgICAvLyBjYWxsIGludGVybmFsIHJlYWQgbWV0aG9kXG4gICAgdGhpcy5fcmVhZChzdGF0ZS5oaWdoV2F0ZXJNYXJrKTtcbiAgICBzdGF0ZS5zeW5jID0gZmFsc2U7XG4gIH1cblxuICAvLyBJZiBfcmVhZCBwdXNoZWQgZGF0YSBzeW5jaHJvbm91c2x5LCB0aGVuIGByZWFkaW5nYCB3aWxsIGJlIGZhbHNlLFxuICAvLyBhbmQgd2UgbmVlZCB0byByZS1ldmFsdWF0ZSBob3cgbXVjaCBkYXRhIHdlIGNhbiByZXR1cm4gdG8gdGhlIHVzZXIuXG4gIGlmIChkb1JlYWQgJiYgIXN0YXRlLnJlYWRpbmcpXG4gICAgbiA9IGhvd011Y2hUb1JlYWQobk9yaWcsIHN0YXRlKTtcblxuICB2YXIgcmV0O1xuICBpZiAobiA+IDApXG4gICAgcmV0ID0gZnJvbUxpc3Qobiwgc3RhdGUpO1xuICBlbHNlXG4gICAgcmV0ID0gbnVsbDtcblxuICBpZiAocmV0ID09PSBudWxsKSB7XG4gICAgc3RhdGUubmVlZFJlYWRhYmxlID0gdHJ1ZTtcbiAgICBuID0gMDtcbiAgfVxuXG4gIHN0YXRlLmxlbmd0aCAtPSBuO1xuXG4gIC8vIElmIHdlIGhhdmUgbm90aGluZyBpbiB0aGUgYnVmZmVyLCB0aGVuIHdlIHdhbnQgdG8ga25vd1xuICAvLyBhcyBzb29uIGFzIHdlICpkbyogZ2V0IHNvbWV0aGluZyBpbnRvIHRoZSBidWZmZXIuXG4gIGlmIChzdGF0ZS5sZW5ndGggPT09IDAgJiYgIXN0YXRlLmVuZGVkKVxuICAgIHN0YXRlLm5lZWRSZWFkYWJsZSA9IHRydWU7XG5cbiAgLy8gSWYgd2UgdHJpZWQgdG8gcmVhZCgpIHBhc3QgdGhlIEVPRiwgdGhlbiBlbWl0IGVuZCBvbiB0aGUgbmV4dCB0aWNrLlxuICBpZiAobk9yaWcgIT09IG4gJiYgc3RhdGUuZW5kZWQgJiYgc3RhdGUubGVuZ3RoID09PSAwKVxuICAgIGVuZFJlYWRhYmxlKHRoaXMpO1xuXG4gIGlmIChyZXQgIT09IG51bGwpXG4gICAgdGhpcy5lbWl0KCdkYXRhJywgcmV0KTtcblxuICByZXR1cm4gcmV0O1xufTtcblxuZnVuY3Rpb24gY2h1bmtJbnZhbGlkKHN0YXRlLCBjaHVuaykge1xuICB2YXIgZXIgPSBudWxsO1xuICBpZiAoIShCdWZmZXIuaXNCdWZmZXIoY2h1bmspKSAmJlxuICAgICAgdHlwZW9mIGNodW5rICE9PSAnc3RyaW5nJyAmJlxuICAgICAgY2h1bmsgIT09IG51bGwgJiZcbiAgICAgIGNodW5rICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICFzdGF0ZS5vYmplY3RNb2RlKSB7XG4gICAgZXIgPSBuZXcgVHlwZUVycm9yKCdJbnZhbGlkIG5vbi1zdHJpbmcvYnVmZmVyIGNodW5rJyk7XG4gIH1cbiAgcmV0dXJuIGVyO1xufVxuXG5cbmZ1bmN0aW9uIG9uRW9mQ2h1bmsoc3RyZWFtLCBzdGF0ZSkge1xuICBpZiAoc3RhdGUuZW5kZWQpIHJldHVybjtcbiAgaWYgKHN0YXRlLmRlY29kZXIpIHtcbiAgICB2YXIgY2h1bmsgPSBzdGF0ZS5kZWNvZGVyLmVuZCgpO1xuICAgIGlmIChjaHVuayAmJiBjaHVuay5sZW5ndGgpIHtcbiAgICAgIHN0YXRlLmJ1ZmZlci5wdXNoKGNodW5rKTtcbiAgICAgIHN0YXRlLmxlbmd0aCArPSBzdGF0ZS5vYmplY3RNb2RlID8gMSA6IGNodW5rLmxlbmd0aDtcbiAgICB9XG4gIH1cbiAgc3RhdGUuZW5kZWQgPSB0cnVlO1xuXG4gIC8vIGVtaXQgJ3JlYWRhYmxlJyBub3cgdG8gbWFrZSBzdXJlIGl0IGdldHMgcGlja2VkIHVwLlxuICBlbWl0UmVhZGFibGUoc3RyZWFtKTtcbn1cblxuLy8gRG9uJ3QgZW1pdCByZWFkYWJsZSByaWdodCBhd2F5IGluIHN5bmMgbW9kZSwgYmVjYXVzZSB0aGlzIGNhbiB0cmlnZ2VyXG4vLyBhbm90aGVyIHJlYWQoKSBjYWxsID0+IHN0YWNrIG92ZXJmbG93LiAgVGhpcyB3YXksIGl0IG1pZ2h0IHRyaWdnZXJcbi8vIGEgbmV4dFRpY2sgcmVjdXJzaW9uIHdhcm5pbmcsIGJ1dCB0aGF0J3Mgbm90IHNvIGJhZC5cbmZ1bmN0aW9uIGVtaXRSZWFkYWJsZShzdHJlYW0pIHtcbiAgdmFyIHN0YXRlID0gc3RyZWFtLl9yZWFkYWJsZVN0YXRlO1xuICBzdGF0ZS5uZWVkUmVhZGFibGUgPSBmYWxzZTtcbiAgaWYgKCFzdGF0ZS5lbWl0dGVkUmVhZGFibGUpIHtcbiAgICBkZWJ1ZygnZW1pdFJlYWRhYmxlJywgc3RhdGUuZmxvd2luZyk7XG4gICAgc3RhdGUuZW1pdHRlZFJlYWRhYmxlID0gdHJ1ZTtcbiAgICBpZiAoc3RhdGUuc3luYylcbiAgICAgIHByb2Nlc3NOZXh0VGljayhlbWl0UmVhZGFibGVfLCBzdHJlYW0pO1xuICAgIGVsc2VcbiAgICAgIGVtaXRSZWFkYWJsZV8oc3RyZWFtKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBlbWl0UmVhZGFibGVfKHN0cmVhbSkge1xuICBkZWJ1ZygnZW1pdCByZWFkYWJsZScpO1xuICBzdHJlYW0uZW1pdCgncmVhZGFibGUnKTtcbiAgZmxvdyhzdHJlYW0pO1xufVxuXG5cbi8vIGF0IHRoaXMgcG9pbnQsIHRoZSB1c2VyIGhhcyBwcmVzdW1hYmx5IHNlZW4gdGhlICdyZWFkYWJsZScgZXZlbnQsXG4vLyBhbmQgY2FsbGVkIHJlYWQoKSB0byBjb25zdW1lIHNvbWUgZGF0YS4gIHRoYXQgbWF5IGhhdmUgdHJpZ2dlcmVkXG4vLyBpbiB0dXJuIGFub3RoZXIgX3JlYWQobikgY2FsbCwgaW4gd2hpY2ggY2FzZSByZWFkaW5nID0gdHJ1ZSBpZlxuLy8gaXQncyBpbiBwcm9ncmVzcy5cbi8vIEhvd2V2ZXIsIGlmIHdlJ3JlIG5vdCBlbmRlZCwgb3IgcmVhZGluZywgYW5kIHRoZSBsZW5ndGggPCBod20sXG4vLyB0aGVuIGdvIGFoZWFkIGFuZCB0cnkgdG8gcmVhZCBzb21lIG1vcmUgcHJlZW1wdGl2ZWx5LlxuZnVuY3Rpb24gbWF5YmVSZWFkTW9yZShzdHJlYW0sIHN0YXRlKSB7XG4gIGlmICghc3RhdGUucmVhZGluZ01vcmUpIHtcbiAgICBzdGF0ZS5yZWFkaW5nTW9yZSA9IHRydWU7XG4gICAgcHJvY2Vzc05leHRUaWNrKG1heWJlUmVhZE1vcmVfLCBzdHJlYW0sIHN0YXRlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBtYXliZVJlYWRNb3JlXyhzdHJlYW0sIHN0YXRlKSB7XG4gIHZhciBsZW4gPSBzdGF0ZS5sZW5ndGg7XG4gIHdoaWxlICghc3RhdGUucmVhZGluZyAmJiAhc3RhdGUuZmxvd2luZyAmJiAhc3RhdGUuZW5kZWQgJiZcbiAgICAgICAgIHN0YXRlLmxlbmd0aCA8IHN0YXRlLmhpZ2hXYXRlck1hcmspIHtcbiAgICBkZWJ1ZygnbWF5YmVSZWFkTW9yZSByZWFkIDAnKTtcbiAgICBzdHJlYW0ucmVhZCgwKTtcbiAgICBpZiAobGVuID09PSBzdGF0ZS5sZW5ndGgpXG4gICAgICAvLyBkaWRuJ3QgZ2V0IGFueSBkYXRhLCBzdG9wIHNwaW5uaW5nLlxuICAgICAgYnJlYWs7XG4gICAgZWxzZVxuICAgICAgbGVuID0gc3RhdGUubGVuZ3RoO1xuICB9XG4gIHN0YXRlLnJlYWRpbmdNb3JlID0gZmFsc2U7XG59XG5cbi8vIGFic3RyYWN0IG1ldGhvZC4gIHRvIGJlIG92ZXJyaWRkZW4gaW4gc3BlY2lmaWMgaW1wbGVtZW50YXRpb24gY2xhc3Nlcy5cbi8vIGNhbGwgY2IoZXIsIGRhdGEpIHdoZXJlIGRhdGEgaXMgPD0gbiBpbiBsZW5ndGguXG4vLyBmb3IgdmlydHVhbCAobm9uLXN0cmluZywgbm9uLWJ1ZmZlcikgc3RyZWFtcywgXCJsZW5ndGhcIiBpcyBzb21ld2hhdFxuLy8gYXJiaXRyYXJ5LCBhbmQgcGVyaGFwcyBub3QgdmVyeSBtZWFuaW5nZnVsLlxuUmVhZGFibGUucHJvdG90eXBlLl9yZWFkID0gZnVuY3Rpb24obikge1xuICB0aGlzLmVtaXQoJ2Vycm9yJywgbmV3IEVycm9yKCdub3QgaW1wbGVtZW50ZWQnKSk7XG59O1xuXG5SZWFkYWJsZS5wcm90b3R5cGUucGlwZSA9IGZ1bmN0aW9uKGRlc3QsIHBpcGVPcHRzKSB7XG4gIHZhciBzcmMgPSB0aGlzO1xuICB2YXIgc3RhdGUgPSB0aGlzLl9yZWFkYWJsZVN0YXRlO1xuXG4gIHN3aXRjaCAoc3RhdGUucGlwZXNDb3VudCkge1xuICAgIGNhc2UgMDpcbiAgICAgIHN0YXRlLnBpcGVzID0gZGVzdDtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgMTpcbiAgICAgIHN0YXRlLnBpcGVzID0gW3N0YXRlLnBpcGVzLCBkZXN0XTtcbiAgICAgIGJyZWFrO1xuICAgIGRlZmF1bHQ6XG4gICAgICBzdGF0ZS5waXBlcy5wdXNoKGRlc3QpO1xuICAgICAgYnJlYWs7XG4gIH1cbiAgc3RhdGUucGlwZXNDb3VudCArPSAxO1xuICBkZWJ1ZygncGlwZSBjb3VudD0lZCBvcHRzPSVqJywgc3RhdGUucGlwZXNDb3VudCwgcGlwZU9wdHMpO1xuXG4gIHZhciBkb0VuZCA9ICghcGlwZU9wdHMgfHwgcGlwZU9wdHMuZW5kICE9PSBmYWxzZSkgJiZcbiAgICAgICAgICAgICAgZGVzdCAhPT0gcHJvY2Vzcy5zdGRvdXQgJiZcbiAgICAgICAgICAgICAgZGVzdCAhPT0gcHJvY2Vzcy5zdGRlcnI7XG5cbiAgdmFyIGVuZEZuID0gZG9FbmQgPyBvbmVuZCA6IGNsZWFudXA7XG4gIGlmIChzdGF0ZS5lbmRFbWl0dGVkKVxuICAgIHByb2Nlc3NOZXh0VGljayhlbmRGbik7XG4gIGVsc2VcbiAgICBzcmMub25jZSgnZW5kJywgZW5kRm4pO1xuXG4gIGRlc3Qub24oJ3VucGlwZScsIG9udW5waXBlKTtcbiAgZnVuY3Rpb24gb251bnBpcGUocmVhZGFibGUpIHtcbiAgICBkZWJ1Zygnb251bnBpcGUnKTtcbiAgICBpZiAocmVhZGFibGUgPT09IHNyYykge1xuICAgICAgY2xlYW51cCgpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIG9uZW5kKCkge1xuICAgIGRlYnVnKCdvbmVuZCcpO1xuICAgIGRlc3QuZW5kKCk7XG4gIH1cblxuICAvLyB3aGVuIHRoZSBkZXN0IGRyYWlucywgaXQgcmVkdWNlcyB0aGUgYXdhaXREcmFpbiBjb3VudGVyXG4gIC8vIG9uIHRoZSBzb3VyY2UuICBUaGlzIHdvdWxkIGJlIG1vcmUgZWxlZ2FudCB3aXRoIGEgLm9uY2UoKVxuICAvLyBoYW5kbGVyIGluIGZsb3coKSwgYnV0IGFkZGluZyBhbmQgcmVtb3ZpbmcgcmVwZWF0ZWRseSBpc1xuICAvLyB0b28gc2xvdy5cbiAgdmFyIG9uZHJhaW4gPSBwaXBlT25EcmFpbihzcmMpO1xuICBkZXN0Lm9uKCdkcmFpbicsIG9uZHJhaW4pO1xuXG4gIGZ1bmN0aW9uIGNsZWFudXAoKSB7XG4gICAgZGVidWcoJ2NsZWFudXAnKTtcbiAgICAvLyBjbGVhbnVwIGV2ZW50IGhhbmRsZXJzIG9uY2UgdGhlIHBpcGUgaXMgYnJva2VuXG4gICAgZGVzdC5yZW1vdmVMaXN0ZW5lcignY2xvc2UnLCBvbmNsb3NlKTtcbiAgICBkZXN0LnJlbW92ZUxpc3RlbmVyKCdmaW5pc2gnLCBvbmZpbmlzaCk7XG4gICAgZGVzdC5yZW1vdmVMaXN0ZW5lcignZHJhaW4nLCBvbmRyYWluKTtcbiAgICBkZXN0LnJlbW92ZUxpc3RlbmVyKCdlcnJvcicsIG9uZXJyb3IpO1xuICAgIGRlc3QucmVtb3ZlTGlzdGVuZXIoJ3VucGlwZScsIG9udW5waXBlKTtcbiAgICBzcmMucmVtb3ZlTGlzdGVuZXIoJ2VuZCcsIG9uZW5kKTtcbiAgICBzcmMucmVtb3ZlTGlzdGVuZXIoJ2VuZCcsIGNsZWFudXApO1xuICAgIHNyYy5yZW1vdmVMaXN0ZW5lcignZGF0YScsIG9uZGF0YSk7XG5cbiAgICAvLyBpZiB0aGUgcmVhZGVyIGlzIHdhaXRpbmcgZm9yIGEgZHJhaW4gZXZlbnQgZnJvbSB0aGlzXG4gICAgLy8gc3BlY2lmaWMgd3JpdGVyLCB0aGVuIGl0IHdvdWxkIGNhdXNlIGl0IHRvIG5ldmVyIHN0YXJ0XG4gICAgLy8gZmxvd2luZyBhZ2Fpbi5cbiAgICAvLyBTbywgaWYgdGhpcyBpcyBhd2FpdGluZyBhIGRyYWluLCB0aGVuIHdlIGp1c3QgY2FsbCBpdCBub3cuXG4gICAgLy8gSWYgd2UgZG9uJ3Qga25vdywgdGhlbiBhc3N1bWUgdGhhdCB3ZSBhcmUgd2FpdGluZyBmb3Igb25lLlxuICAgIGlmIChzdGF0ZS5hd2FpdERyYWluICYmXG4gICAgICAgICghZGVzdC5fd3JpdGFibGVTdGF0ZSB8fCBkZXN0Ll93cml0YWJsZVN0YXRlLm5lZWREcmFpbikpXG4gICAgICBvbmRyYWluKCk7XG4gIH1cblxuICBzcmMub24oJ2RhdGEnLCBvbmRhdGEpO1xuICBmdW5jdGlvbiBvbmRhdGEoY2h1bmspIHtcbiAgICBkZWJ1Zygnb25kYXRhJyk7XG4gICAgdmFyIHJldCA9IGRlc3Qud3JpdGUoY2h1bmspO1xuICAgIGlmIChmYWxzZSA9PT0gcmV0KSB7XG4gICAgICBkZWJ1ZygnZmFsc2Ugd3JpdGUgcmVzcG9uc2UsIHBhdXNlJyxcbiAgICAgICAgICAgIHNyYy5fcmVhZGFibGVTdGF0ZS5hd2FpdERyYWluKTtcbiAgICAgIHNyYy5fcmVhZGFibGVTdGF0ZS5hd2FpdERyYWluKys7XG4gICAgICBzcmMucGF1c2UoKTtcbiAgICB9XG4gIH1cblxuICAvLyBpZiB0aGUgZGVzdCBoYXMgYW4gZXJyb3IsIHRoZW4gc3RvcCBwaXBpbmcgaW50byBpdC5cbiAgLy8gaG93ZXZlciwgZG9uJ3Qgc3VwcHJlc3MgdGhlIHRocm93aW5nIGJlaGF2aW9yIGZvciB0aGlzLlxuICBmdW5jdGlvbiBvbmVycm9yKGVyKSB7XG4gICAgZGVidWcoJ29uZXJyb3InLCBlcik7XG4gICAgdW5waXBlKCk7XG4gICAgZGVzdC5yZW1vdmVMaXN0ZW5lcignZXJyb3InLCBvbmVycm9yKTtcbiAgICBpZiAoRUUubGlzdGVuZXJDb3VudChkZXN0LCAnZXJyb3InKSA9PT0gMClcbiAgICAgIGRlc3QuZW1pdCgnZXJyb3InLCBlcik7XG4gIH1cbiAgLy8gVGhpcyBpcyBhIGJydXRhbGx5IHVnbHkgaGFjayB0byBtYWtlIHN1cmUgdGhhdCBvdXIgZXJyb3IgaGFuZGxlclxuICAvLyBpcyBhdHRhY2hlZCBiZWZvcmUgYW55IHVzZXJsYW5kIG9uZXMuICBORVZFUiBETyBUSElTLlxuICBpZiAoIWRlc3QuX2V2ZW50cyB8fCAhZGVzdC5fZXZlbnRzLmVycm9yKVxuICAgIGRlc3Qub24oJ2Vycm9yJywgb25lcnJvcik7XG4gIGVsc2UgaWYgKGlzQXJyYXkoZGVzdC5fZXZlbnRzLmVycm9yKSlcbiAgICBkZXN0Ll9ldmVudHMuZXJyb3IudW5zaGlmdChvbmVycm9yKTtcbiAgZWxzZVxuICAgIGRlc3QuX2V2ZW50cy5lcnJvciA9IFtvbmVycm9yLCBkZXN0Ll9ldmVudHMuZXJyb3JdO1xuXG5cblxuICAvLyBCb3RoIGNsb3NlIGFuZCBmaW5pc2ggc2hvdWxkIHRyaWdnZXIgdW5waXBlLCBidXQgb25seSBvbmNlLlxuICBmdW5jdGlvbiBvbmNsb3NlKCkge1xuICAgIGRlc3QucmVtb3ZlTGlzdGVuZXIoJ2ZpbmlzaCcsIG9uZmluaXNoKTtcbiAgICB1bnBpcGUoKTtcbiAgfVxuICBkZXN0Lm9uY2UoJ2Nsb3NlJywgb25jbG9zZSk7XG4gIGZ1bmN0aW9uIG9uZmluaXNoKCkge1xuICAgIGRlYnVnKCdvbmZpbmlzaCcpO1xuICAgIGRlc3QucmVtb3ZlTGlzdGVuZXIoJ2Nsb3NlJywgb25jbG9zZSk7XG4gICAgdW5waXBlKCk7XG4gIH1cbiAgZGVzdC5vbmNlKCdmaW5pc2gnLCBvbmZpbmlzaCk7XG5cbiAgZnVuY3Rpb24gdW5waXBlKCkge1xuICAgIGRlYnVnKCd1bnBpcGUnKTtcbiAgICBzcmMudW5waXBlKGRlc3QpO1xuICB9XG5cbiAgLy8gdGVsbCB0aGUgZGVzdCB0aGF0IGl0J3MgYmVpbmcgcGlwZWQgdG9cbiAgZGVzdC5lbWl0KCdwaXBlJywgc3JjKTtcblxuICAvLyBzdGFydCB0aGUgZmxvdyBpZiBpdCBoYXNuJ3QgYmVlbiBzdGFydGVkIGFscmVhZHkuXG4gIGlmICghc3RhdGUuZmxvd2luZykge1xuICAgIGRlYnVnKCdwaXBlIHJlc3VtZScpO1xuICAgIHNyYy5yZXN1bWUoKTtcbiAgfVxuXG4gIHJldHVybiBkZXN0O1xufTtcblxuZnVuY3Rpb24gcGlwZU9uRHJhaW4oc3JjKSB7XG4gIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICB2YXIgc3RhdGUgPSBzcmMuX3JlYWRhYmxlU3RhdGU7XG4gICAgZGVidWcoJ3BpcGVPbkRyYWluJywgc3RhdGUuYXdhaXREcmFpbik7XG4gICAgaWYgKHN0YXRlLmF3YWl0RHJhaW4pXG4gICAgICBzdGF0ZS5hd2FpdERyYWluLS07XG4gICAgaWYgKHN0YXRlLmF3YWl0RHJhaW4gPT09IDAgJiYgRUUubGlzdGVuZXJDb3VudChzcmMsICdkYXRhJykpIHtcbiAgICAgIHN0YXRlLmZsb3dpbmcgPSB0cnVlO1xuICAgICAgZmxvdyhzcmMpO1xuICAgIH1cbiAgfTtcbn1cblxuXG5SZWFkYWJsZS5wcm90b3R5cGUudW5waXBlID0gZnVuY3Rpb24oZGVzdCkge1xuICB2YXIgc3RhdGUgPSB0aGlzLl9yZWFkYWJsZVN0YXRlO1xuXG4gIC8vIGlmIHdlJ3JlIG5vdCBwaXBpbmcgYW55d2hlcmUsIHRoZW4gZG8gbm90aGluZy5cbiAgaWYgKHN0YXRlLnBpcGVzQ291bnQgPT09IDApXG4gICAgcmV0dXJuIHRoaXM7XG5cbiAgLy8ganVzdCBvbmUgZGVzdGluYXRpb24uICBtb3N0IGNvbW1vbiBjYXNlLlxuICBpZiAoc3RhdGUucGlwZXNDb3VudCA9PT0gMSkge1xuICAgIC8vIHBhc3NlZCBpbiBvbmUsIGJ1dCBpdCdzIG5vdCB0aGUgcmlnaHQgb25lLlxuICAgIGlmIChkZXN0ICYmIGRlc3QgIT09IHN0YXRlLnBpcGVzKVxuICAgICAgcmV0dXJuIHRoaXM7XG5cbiAgICBpZiAoIWRlc3QpXG4gICAgICBkZXN0ID0gc3RhdGUucGlwZXM7XG5cbiAgICAvLyBnb3QgYSBtYXRjaC5cbiAgICBzdGF0ZS5waXBlcyA9IG51bGw7XG4gICAgc3RhdGUucGlwZXNDb3VudCA9IDA7XG4gICAgc3RhdGUuZmxvd2luZyA9IGZhbHNlO1xuICAgIGlmIChkZXN0KVxuICAgICAgZGVzdC5lbWl0KCd1bnBpcGUnLCB0aGlzKTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8vIHNsb3cgY2FzZS4gbXVsdGlwbGUgcGlwZSBkZXN0aW5hdGlvbnMuXG5cbiAgaWYgKCFkZXN0KSB7XG4gICAgLy8gcmVtb3ZlIGFsbC5cbiAgICB2YXIgZGVzdHMgPSBzdGF0ZS5waXBlcztcbiAgICB2YXIgbGVuID0gc3RhdGUucGlwZXNDb3VudDtcbiAgICBzdGF0ZS5waXBlcyA9IG51bGw7XG4gICAgc3RhdGUucGlwZXNDb3VudCA9IDA7XG4gICAgc3RhdGUuZmxvd2luZyA9IGZhbHNlO1xuXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW47IGkrKylcbiAgICAgIGRlc3RzW2ldLmVtaXQoJ3VucGlwZScsIHRoaXMpO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLy8gdHJ5IHRvIGZpbmQgdGhlIHJpZ2h0IG9uZS5cbiAgdmFyIGkgPSBpbmRleE9mKHN0YXRlLnBpcGVzLCBkZXN0KTtcbiAgaWYgKGkgPT09IC0xKVxuICAgIHJldHVybiB0aGlzO1xuXG4gIHN0YXRlLnBpcGVzLnNwbGljZShpLCAxKTtcbiAgc3RhdGUucGlwZXNDb3VudCAtPSAxO1xuICBpZiAoc3RhdGUucGlwZXNDb3VudCA9PT0gMSlcbiAgICBzdGF0ZS5waXBlcyA9IHN0YXRlLnBpcGVzWzBdO1xuXG4gIGRlc3QuZW1pdCgndW5waXBlJywgdGhpcyk7XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG4vLyBzZXQgdXAgZGF0YSBldmVudHMgaWYgdGhleSBhcmUgYXNrZWQgZm9yXG4vLyBFbnN1cmUgcmVhZGFibGUgbGlzdGVuZXJzIGV2ZW50dWFsbHkgZ2V0IHNvbWV0aGluZ1xuUmVhZGFibGUucHJvdG90eXBlLm9uID0gZnVuY3Rpb24oZXYsIGZuKSB7XG4gIHZhciByZXMgPSBTdHJlYW0ucHJvdG90eXBlLm9uLmNhbGwodGhpcywgZXYsIGZuKTtcblxuICAvLyBJZiBsaXN0ZW5pbmcgdG8gZGF0YSwgYW5kIGl0IGhhcyBub3QgZXhwbGljaXRseSBiZWVuIHBhdXNlZCxcbiAgLy8gdGhlbiBjYWxsIHJlc3VtZSB0byBzdGFydCB0aGUgZmxvdyBvZiBkYXRhIG9uIHRoZSBuZXh0IHRpY2suXG4gIGlmIChldiA9PT0gJ2RhdGEnICYmIGZhbHNlICE9PSB0aGlzLl9yZWFkYWJsZVN0YXRlLmZsb3dpbmcpIHtcbiAgICB0aGlzLnJlc3VtZSgpO1xuICB9XG5cbiAgaWYgKGV2ID09PSAncmVhZGFibGUnICYmIHRoaXMucmVhZGFibGUpIHtcbiAgICB2YXIgc3RhdGUgPSB0aGlzLl9yZWFkYWJsZVN0YXRlO1xuICAgIGlmICghc3RhdGUucmVhZGFibGVMaXN0ZW5pbmcpIHtcbiAgICAgIHN0YXRlLnJlYWRhYmxlTGlzdGVuaW5nID0gdHJ1ZTtcbiAgICAgIHN0YXRlLmVtaXR0ZWRSZWFkYWJsZSA9IGZhbHNlO1xuICAgICAgc3RhdGUubmVlZFJlYWRhYmxlID0gdHJ1ZTtcbiAgICAgIGlmICghc3RhdGUucmVhZGluZykge1xuICAgICAgICBwcm9jZXNzTmV4dFRpY2soblJlYWRpbmdOZXh0VGljaywgdGhpcyk7XG4gICAgICB9IGVsc2UgaWYgKHN0YXRlLmxlbmd0aCkge1xuICAgICAgICBlbWl0UmVhZGFibGUodGhpcywgc3RhdGUpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZXM7XG59O1xuUmVhZGFibGUucHJvdG90eXBlLmFkZExpc3RlbmVyID0gUmVhZGFibGUucHJvdG90eXBlLm9uO1xuXG5mdW5jdGlvbiBuUmVhZGluZ05leHRUaWNrKHNlbGYpIHtcbiAgZGVidWcoJ3JlYWRhYmxlIG5leHR0aWNrIHJlYWQgMCcpO1xuICBzZWxmLnJlYWQoMCk7XG59XG5cbi8vIHBhdXNlKCkgYW5kIHJlc3VtZSgpIGFyZSByZW1uYW50cyBvZiB0aGUgbGVnYWN5IHJlYWRhYmxlIHN0cmVhbSBBUElcbi8vIElmIHRoZSB1c2VyIHVzZXMgdGhlbSwgdGhlbiBzd2l0Y2ggaW50byBvbGQgbW9kZS5cblJlYWRhYmxlLnByb3RvdHlwZS5yZXN1bWUgPSBmdW5jdGlvbigpIHtcbiAgdmFyIHN0YXRlID0gdGhpcy5fcmVhZGFibGVTdGF0ZTtcbiAgaWYgKCFzdGF0ZS5mbG93aW5nKSB7XG4gICAgZGVidWcoJ3Jlc3VtZScpO1xuICAgIHN0YXRlLmZsb3dpbmcgPSB0cnVlO1xuICAgIHJlc3VtZSh0aGlzLCBzdGF0ZSk7XG4gIH1cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5mdW5jdGlvbiByZXN1bWUoc3RyZWFtLCBzdGF0ZSkge1xuICBpZiAoIXN0YXRlLnJlc3VtZVNjaGVkdWxlZCkge1xuICAgIHN0YXRlLnJlc3VtZVNjaGVkdWxlZCA9IHRydWU7XG4gICAgcHJvY2Vzc05leHRUaWNrKHJlc3VtZV8sIHN0cmVhbSwgc3RhdGUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc3VtZV8oc3RyZWFtLCBzdGF0ZSkge1xuICBpZiAoIXN0YXRlLnJlYWRpbmcpIHtcbiAgICBkZWJ1ZygncmVzdW1lIHJlYWQgMCcpO1xuICAgIHN0cmVhbS5yZWFkKDApO1xuICB9XG5cbiAgc3RhdGUucmVzdW1lU2NoZWR1bGVkID0gZmFsc2U7XG4gIHN0cmVhbS5lbWl0KCdyZXN1bWUnKTtcbiAgZmxvdyhzdHJlYW0pO1xuICBpZiAoc3RhdGUuZmxvd2luZyAmJiAhc3RhdGUucmVhZGluZylcbiAgICBzdHJlYW0ucmVhZCgwKTtcbn1cblxuUmVhZGFibGUucHJvdG90eXBlLnBhdXNlID0gZnVuY3Rpb24oKSB7XG4gIGRlYnVnKCdjYWxsIHBhdXNlIGZsb3dpbmc9JWonLCB0aGlzLl9yZWFkYWJsZVN0YXRlLmZsb3dpbmcpO1xuICBpZiAoZmFsc2UgIT09IHRoaXMuX3JlYWRhYmxlU3RhdGUuZmxvd2luZykge1xuICAgIGRlYnVnKCdwYXVzZScpO1xuICAgIHRoaXMuX3JlYWRhYmxlU3RhdGUuZmxvd2luZyA9IGZhbHNlO1xuICAgIHRoaXMuZW1pdCgncGF1c2UnKTtcbiAgfVxuICByZXR1cm4gdGhpcztcbn07XG5cbmZ1bmN0aW9uIGZsb3coc3RyZWFtKSB7XG4gIHZhciBzdGF0ZSA9IHN0cmVhbS5fcmVhZGFibGVTdGF0ZTtcbiAgZGVidWcoJ2Zsb3cnLCBzdGF0ZS5mbG93aW5nKTtcbiAgaWYgKHN0YXRlLmZsb3dpbmcpIHtcbiAgICBkbyB7XG4gICAgICB2YXIgY2h1bmsgPSBzdHJlYW0ucmVhZCgpO1xuICAgIH0gd2hpbGUgKG51bGwgIT09IGNodW5rICYmIHN0YXRlLmZsb3dpbmcpO1xuICB9XG59XG5cbi8vIHdyYXAgYW4gb2xkLXN0eWxlIHN0cmVhbSBhcyB0aGUgYXN5bmMgZGF0YSBzb3VyY2UuXG4vLyBUaGlzIGlzICpub3QqIHBhcnQgb2YgdGhlIHJlYWRhYmxlIHN0cmVhbSBpbnRlcmZhY2UuXG4vLyBJdCBpcyBhbiB1Z2x5IHVuZm9ydHVuYXRlIG1lc3Mgb2YgaGlzdG9yeS5cblJlYWRhYmxlLnByb3RvdHlwZS53cmFwID0gZnVuY3Rpb24oc3RyZWFtKSB7XG4gIHZhciBzdGF0ZSA9IHRoaXMuX3JlYWRhYmxlU3RhdGU7XG4gIHZhciBwYXVzZWQgPSBmYWxzZTtcblxuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHN0cmVhbS5vbignZW5kJywgZnVuY3Rpb24oKSB7XG4gICAgZGVidWcoJ3dyYXBwZWQgZW5kJyk7XG4gICAgaWYgKHN0YXRlLmRlY29kZXIgJiYgIXN0YXRlLmVuZGVkKSB7XG4gICAgICB2YXIgY2h1bmsgPSBzdGF0ZS5kZWNvZGVyLmVuZCgpO1xuICAgICAgaWYgKGNodW5rICYmIGNodW5rLmxlbmd0aClcbiAgICAgICAgc2VsZi5wdXNoKGNodW5rKTtcbiAgICB9XG5cbiAgICBzZWxmLnB1c2gobnVsbCk7XG4gIH0pO1xuXG4gIHN0cmVhbS5vbignZGF0YScsIGZ1bmN0aW9uKGNodW5rKSB7XG4gICAgZGVidWcoJ3dyYXBwZWQgZGF0YScpO1xuICAgIGlmIChzdGF0ZS5kZWNvZGVyKVxuICAgICAgY2h1bmsgPSBzdGF0ZS5kZWNvZGVyLndyaXRlKGNodW5rKTtcblxuICAgIC8vIGRvbid0IHNraXAgb3ZlciBmYWxzeSB2YWx1ZXMgaW4gb2JqZWN0TW9kZVxuICAgIGlmIChzdGF0ZS5vYmplY3RNb2RlICYmIChjaHVuayA9PT0gbnVsbCB8fCBjaHVuayA9PT0gdW5kZWZpbmVkKSlcbiAgICAgIHJldHVybjtcbiAgICBlbHNlIGlmICghc3RhdGUub2JqZWN0TW9kZSAmJiAoIWNodW5rIHx8ICFjaHVuay5sZW5ndGgpKVxuICAgICAgcmV0dXJuO1xuXG4gICAgdmFyIHJldCA9IHNlbGYucHVzaChjaHVuayk7XG4gICAgaWYgKCFyZXQpIHtcbiAgICAgIHBhdXNlZCA9IHRydWU7XG4gICAgICBzdHJlYW0ucGF1c2UoKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIHByb3h5IGFsbCB0aGUgb3RoZXIgbWV0aG9kcy5cbiAgLy8gaW1wb3J0YW50IHdoZW4gd3JhcHBpbmcgZmlsdGVycyBhbmQgZHVwbGV4ZXMuXG4gIGZvciAodmFyIGkgaW4gc3RyZWFtKSB7XG4gICAgaWYgKHRoaXNbaV0gPT09IHVuZGVmaW5lZCAmJiB0eXBlb2Ygc3RyZWFtW2ldID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICB0aGlzW2ldID0gZnVuY3Rpb24obWV0aG9kKSB7IHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIHN0cmVhbVttZXRob2RdLmFwcGx5KHN0cmVhbSwgYXJndW1lbnRzKTtcbiAgICAgIH07IH0oaSk7XG4gICAgfVxuICB9XG5cbiAgLy8gcHJveHkgY2VydGFpbiBpbXBvcnRhbnQgZXZlbnRzLlxuICB2YXIgZXZlbnRzID0gWydlcnJvcicsICdjbG9zZScsICdkZXN0cm95JywgJ3BhdXNlJywgJ3Jlc3VtZSddO1xuICBmb3JFYWNoKGV2ZW50cywgZnVuY3Rpb24oZXYpIHtcbiAgICBzdHJlYW0ub24oZXYsIHNlbGYuZW1pdC5iaW5kKHNlbGYsIGV2KSk7XG4gIH0pO1xuXG4gIC8vIHdoZW4gd2UgdHJ5IHRvIGNvbnN1bWUgc29tZSBtb3JlIGJ5dGVzLCBzaW1wbHkgdW5wYXVzZSB0aGVcbiAgLy8gdW5kZXJseWluZyBzdHJlYW0uXG4gIHNlbGYuX3JlYWQgPSBmdW5jdGlvbihuKSB7XG4gICAgZGVidWcoJ3dyYXBwZWQgX3JlYWQnLCBuKTtcbiAgICBpZiAocGF1c2VkKSB7XG4gICAgICBwYXVzZWQgPSBmYWxzZTtcbiAgICAgIHN0cmVhbS5yZXN1bWUoKTtcbiAgICB9XG4gIH07XG5cbiAgcmV0dXJuIHNlbGY7XG59O1xuXG5cblxuLy8gZXhwb3NlZCBmb3IgdGVzdGluZyBwdXJwb3NlcyBvbmx5LlxuUmVhZGFibGUuX2Zyb21MaXN0ID0gZnJvbUxpc3Q7XG5cbi8vIFBsdWNrIG9mZiBuIGJ5dGVzIGZyb20gYW4gYXJyYXkgb2YgYnVmZmVycy5cbi8vIExlbmd0aCBpcyB0aGUgY29tYmluZWQgbGVuZ3RocyBvZiBhbGwgdGhlIGJ1ZmZlcnMgaW4gdGhlIGxpc3QuXG5mdW5jdGlvbiBmcm9tTGlzdChuLCBzdGF0ZSkge1xuICB2YXIgbGlzdCA9IHN0YXRlLmJ1ZmZlcjtcbiAgdmFyIGxlbmd0aCA9IHN0YXRlLmxlbmd0aDtcbiAgdmFyIHN0cmluZ01vZGUgPSAhIXN0YXRlLmRlY29kZXI7XG4gIHZhciBvYmplY3RNb2RlID0gISFzdGF0ZS5vYmplY3RNb2RlO1xuICB2YXIgcmV0O1xuXG4gIC8vIG5vdGhpbmcgaW4gdGhlIGxpc3QsIGRlZmluaXRlbHkgZW1wdHkuXG4gIGlmIChsaXN0Lmxlbmd0aCA9PT0gMClcbiAgICByZXR1cm4gbnVsbDtcblxuICBpZiAobGVuZ3RoID09PSAwKVxuICAgIHJldCA9IG51bGw7XG4gIGVsc2UgaWYgKG9iamVjdE1vZGUpXG4gICAgcmV0ID0gbGlzdC5zaGlmdCgpO1xuICBlbHNlIGlmICghbiB8fCBuID49IGxlbmd0aCkge1xuICAgIC8vIHJlYWQgaXQgYWxsLCB0cnVuY2F0ZSB0aGUgYXJyYXkuXG4gICAgaWYgKHN0cmluZ01vZGUpXG4gICAgICByZXQgPSBsaXN0LmpvaW4oJycpO1xuICAgIGVsc2VcbiAgICAgIHJldCA9IEJ1ZmZlci5jb25jYXQobGlzdCwgbGVuZ3RoKTtcbiAgICBsaXN0Lmxlbmd0aCA9IDA7XG4gIH0gZWxzZSB7XG4gICAgLy8gcmVhZCBqdXN0IHNvbWUgb2YgaXQuXG4gICAgaWYgKG4gPCBsaXN0WzBdLmxlbmd0aCkge1xuICAgICAgLy8ganVzdCB0YWtlIGEgcGFydCBvZiB0aGUgZmlyc3QgbGlzdCBpdGVtLlxuICAgICAgLy8gc2xpY2UgaXMgdGhlIHNhbWUgZm9yIGJ1ZmZlcnMgYW5kIHN0cmluZ3MuXG4gICAgICB2YXIgYnVmID0gbGlzdFswXTtcbiAgICAgIHJldCA9IGJ1Zi5zbGljZSgwLCBuKTtcbiAgICAgIGxpc3RbMF0gPSBidWYuc2xpY2Uobik7XG4gICAgfSBlbHNlIGlmIChuID09PSBsaXN0WzBdLmxlbmd0aCkge1xuICAgICAgLy8gZmlyc3QgbGlzdCBpcyBhIHBlcmZlY3QgbWF0Y2hcbiAgICAgIHJldCA9IGxpc3Quc2hpZnQoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gY29tcGxleCBjYXNlLlxuICAgICAgLy8gd2UgaGF2ZSBlbm91Z2ggdG8gY292ZXIgaXQsIGJ1dCBpdCBzcGFucyBwYXN0IHRoZSBmaXJzdCBidWZmZXIuXG4gICAgICBpZiAoc3RyaW5nTW9kZSlcbiAgICAgICAgcmV0ID0gJyc7XG4gICAgICBlbHNlXG4gICAgICAgIHJldCA9IG5ldyBCdWZmZXIobik7XG5cbiAgICAgIHZhciBjID0gMDtcbiAgICAgIGZvciAodmFyIGkgPSAwLCBsID0gbGlzdC5sZW5ndGg7IGkgPCBsICYmIGMgPCBuOyBpKyspIHtcbiAgICAgICAgdmFyIGJ1ZiA9IGxpc3RbMF07XG4gICAgICAgIHZhciBjcHkgPSBNYXRoLm1pbihuIC0gYywgYnVmLmxlbmd0aCk7XG5cbiAgICAgICAgaWYgKHN0cmluZ01vZGUpXG4gICAgICAgICAgcmV0ICs9IGJ1Zi5zbGljZSgwLCBjcHkpO1xuICAgICAgICBlbHNlXG4gICAgICAgICAgYnVmLmNvcHkocmV0LCBjLCAwLCBjcHkpO1xuXG4gICAgICAgIGlmIChjcHkgPCBidWYubGVuZ3RoKVxuICAgICAgICAgIGxpc3RbMF0gPSBidWYuc2xpY2UoY3B5KTtcbiAgICAgICAgZWxzZVxuICAgICAgICAgIGxpc3Quc2hpZnQoKTtcblxuICAgICAgICBjICs9IGNweTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmV0O1xufVxuXG5mdW5jdGlvbiBlbmRSZWFkYWJsZShzdHJlYW0pIHtcbiAgdmFyIHN0YXRlID0gc3RyZWFtLl9yZWFkYWJsZVN0YXRlO1xuXG4gIC8vIElmIHdlIGdldCBoZXJlIGJlZm9yZSBjb25zdW1pbmcgYWxsIHRoZSBieXRlcywgdGhlbiB0aGF0IGlzIGFcbiAgLy8gYnVnIGluIG5vZGUuICBTaG91bGQgbmV2ZXIgaGFwcGVuLlxuICBpZiAoc3RhdGUubGVuZ3RoID4gMClcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ2VuZFJlYWRhYmxlIGNhbGxlZCBvbiBub24tZW1wdHkgc3RyZWFtJyk7XG5cbiAgaWYgKCFzdGF0ZS5lbmRFbWl0dGVkKSB7XG4gICAgc3RhdGUuZW5kZWQgPSB0cnVlO1xuICAgIHByb2Nlc3NOZXh0VGljayhlbmRSZWFkYWJsZU5ULCBzdGF0ZSwgc3RyZWFtKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBlbmRSZWFkYWJsZU5UKHN0YXRlLCBzdHJlYW0pIHtcbiAgLy8gQ2hlY2sgdGhhdCB3ZSBkaWRuJ3QgZ2V0IG9uZSBsYXN0IHVuc2hpZnQuXG4gIGlmICghc3RhdGUuZW5kRW1pdHRlZCAmJiBzdGF0ZS5sZW5ndGggPT09IDApIHtcbiAgICBzdGF0ZS5lbmRFbWl0dGVkID0gdHJ1ZTtcbiAgICBzdHJlYW0ucmVhZGFibGUgPSBmYWxzZTtcbiAgICBzdHJlYW0uZW1pdCgnZW5kJyk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZm9yRWFjaCAoeHMsIGYpIHtcbiAgZm9yICh2YXIgaSA9IDAsIGwgPSB4cy5sZW5ndGg7IGkgPCBsOyBpKyspIHtcbiAgICBmKHhzW2ldLCBpKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBpbmRleE9mICh4cywgeCkge1xuICBmb3IgKHZhciBpID0gMCwgbCA9IHhzLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgIGlmICh4c1tpXSA9PT0geCkgcmV0dXJuIGk7XG4gIH1cbiAgcmV0dXJuIC0xO1xufVxuIiwiLy8gYSB0cmFuc2Zvcm0gc3RyZWFtIGlzIGEgcmVhZGFibGUvd3JpdGFibGUgc3RyZWFtIHdoZXJlIHlvdSBkb1xuLy8gc29tZXRoaW5nIHdpdGggdGhlIGRhdGEuICBTb21ldGltZXMgaXQncyBjYWxsZWQgYSBcImZpbHRlclwiLFxuLy8gYnV0IHRoYXQncyBub3QgYSBncmVhdCBuYW1lIGZvciBpdCwgc2luY2UgdGhhdCBpbXBsaWVzIGEgdGhpbmcgd2hlcmVcbi8vIHNvbWUgYml0cyBwYXNzIHRocm91Z2gsIGFuZCBvdGhlcnMgYXJlIHNpbXBseSBpZ25vcmVkLiAgKFRoYXQgd291bGRcbi8vIGJlIGEgdmFsaWQgZXhhbXBsZSBvZiBhIHRyYW5zZm9ybSwgb2YgY291cnNlLilcbi8vXG4vLyBXaGlsZSB0aGUgb3V0cHV0IGlzIGNhdXNhbGx5IHJlbGF0ZWQgdG8gdGhlIGlucHV0LCBpdCdzIG5vdCBhXG4vLyBuZWNlc3NhcmlseSBzeW1tZXRyaWMgb3Igc3luY2hyb25vdXMgdHJhbnNmb3JtYXRpb24uICBGb3IgZXhhbXBsZSxcbi8vIGEgemxpYiBzdHJlYW0gbWlnaHQgdGFrZSBtdWx0aXBsZSBwbGFpbi10ZXh0IHdyaXRlcygpLCBhbmQgdGhlblxuLy8gZW1pdCBhIHNpbmdsZSBjb21wcmVzc2VkIGNodW5rIHNvbWUgdGltZSBpbiB0aGUgZnV0dXJlLlxuLy9cbi8vIEhlcmUncyBob3cgdGhpcyB3b3Jrczpcbi8vXG4vLyBUaGUgVHJhbnNmb3JtIHN0cmVhbSBoYXMgYWxsIHRoZSBhc3BlY3RzIG9mIHRoZSByZWFkYWJsZSBhbmQgd3JpdGFibGVcbi8vIHN0cmVhbSBjbGFzc2VzLiAgV2hlbiB5b3Ugd3JpdGUoY2h1bmspLCB0aGF0IGNhbGxzIF93cml0ZShjaHVuayxjYilcbi8vIGludGVybmFsbHksIGFuZCByZXR1cm5zIGZhbHNlIGlmIHRoZXJlJ3MgYSBsb3Qgb2YgcGVuZGluZyB3cml0ZXNcbi8vIGJ1ZmZlcmVkIHVwLiAgV2hlbiB5b3UgY2FsbCByZWFkKCksIHRoYXQgY2FsbHMgX3JlYWQobikgdW50aWxcbi8vIHRoZXJlJ3MgZW5vdWdoIHBlbmRpbmcgcmVhZGFibGUgZGF0YSBidWZmZXJlZCB1cC5cbi8vXG4vLyBJbiBhIHRyYW5zZm9ybSBzdHJlYW0sIHRoZSB3cml0dGVuIGRhdGEgaXMgcGxhY2VkIGluIGEgYnVmZmVyLiAgV2hlblxuLy8gX3JlYWQobikgaXMgY2FsbGVkLCBpdCB0cmFuc2Zvcm1zIHRoZSBxdWV1ZWQgdXAgZGF0YSwgY2FsbGluZyB0aGVcbi8vIGJ1ZmZlcmVkIF93cml0ZSBjYidzIGFzIGl0IGNvbnN1bWVzIGNodW5rcy4gIElmIGNvbnN1bWluZyBhIHNpbmdsZVxuLy8gd3JpdHRlbiBjaHVuayB3b3VsZCByZXN1bHQgaW4gbXVsdGlwbGUgb3V0cHV0IGNodW5rcywgdGhlbiB0aGUgZmlyc3Rcbi8vIG91dHB1dHRlZCBiaXQgY2FsbHMgdGhlIHJlYWRjYiwgYW5kIHN1YnNlcXVlbnQgY2h1bmtzIGp1c3QgZ28gaW50b1xuLy8gdGhlIHJlYWQgYnVmZmVyLCBhbmQgd2lsbCBjYXVzZSBpdCB0byBlbWl0ICdyZWFkYWJsZScgaWYgbmVjZXNzYXJ5LlxuLy9cbi8vIFRoaXMgd2F5LCBiYWNrLXByZXNzdXJlIGlzIGFjdHVhbGx5IGRldGVybWluZWQgYnkgdGhlIHJlYWRpbmcgc2lkZSxcbi8vIHNpbmNlIF9yZWFkIGhhcyB0byBiZSBjYWxsZWQgdG8gc3RhcnQgcHJvY2Vzc2luZyBhIG5ldyBjaHVuay4gIEhvd2V2ZXIsXG4vLyBhIHBhdGhvbG9naWNhbCBpbmZsYXRlIHR5cGUgb2YgdHJhbnNmb3JtIGNhbiBjYXVzZSBleGNlc3NpdmUgYnVmZmVyaW5nXG4vLyBoZXJlLiAgRm9yIGV4YW1wbGUsIGltYWdpbmUgYSBzdHJlYW0gd2hlcmUgZXZlcnkgYnl0ZSBvZiBpbnB1dCBpc1xuLy8gaW50ZXJwcmV0ZWQgYXMgYW4gaW50ZWdlciBmcm9tIDAtMjU1LCBhbmQgdGhlbiByZXN1bHRzIGluIHRoYXQgbWFueVxuLy8gYnl0ZXMgb2Ygb3V0cHV0LiAgV3JpdGluZyB0aGUgNCBieXRlcyB7ZmYsZmYsZmYsZmZ9IHdvdWxkIHJlc3VsdCBpblxuLy8gMWtiIG9mIGRhdGEgYmVpbmcgb3V0cHV0LiAgSW4gdGhpcyBjYXNlLCB5b3UgY291bGQgd3JpdGUgYSB2ZXJ5IHNtYWxsXG4vLyBhbW91bnQgb2YgaW5wdXQsIGFuZCBlbmQgdXAgd2l0aCBhIHZlcnkgbGFyZ2UgYW1vdW50IG9mIG91dHB1dC4gIEluXG4vLyBzdWNoIGEgcGF0aG9sb2dpY2FsIGluZmxhdGluZyBtZWNoYW5pc20sIHRoZXJlJ2QgYmUgbm8gd2F5IHRvIHRlbGxcbi8vIHRoZSBzeXN0ZW0gdG8gc3RvcCBkb2luZyB0aGUgdHJhbnNmb3JtLiAgQSBzaW5nbGUgNE1CIHdyaXRlIGNvdWxkXG4vLyBjYXVzZSB0aGUgc3lzdGVtIHRvIHJ1biBvdXQgb2YgbWVtb3J5LlxuLy9cbi8vIEhvd2V2ZXIsIGV2ZW4gaW4gc3VjaCBhIHBhdGhvbG9naWNhbCBjYXNlLCBvbmx5IGEgc2luZ2xlIHdyaXR0ZW4gY2h1bmtcbi8vIHdvdWxkIGJlIGNvbnN1bWVkLCBhbmQgdGhlbiB0aGUgcmVzdCB3b3VsZCB3YWl0ICh1bi10cmFuc2Zvcm1lZCkgdW50aWxcbi8vIHRoZSByZXN1bHRzIG9mIHRoZSBwcmV2aW91cyB0cmFuc2Zvcm1lZCBjaHVuayB3ZXJlIGNvbnN1bWVkLlxuXG4ndXNlIHN0cmljdCc7XG5cbm1vZHVsZS5leHBvcnRzID0gVHJhbnNmb3JtO1xuXG52YXIgRHVwbGV4ID0gcmVxdWlyZSgnLi9fc3RyZWFtX2R1cGxleCcpO1xuXG4vKjxyZXBsYWNlbWVudD4qL1xudmFyIHV0aWwgPSByZXF1aXJlKCdjb3JlLXV0aWwtaXMnKTtcbnV0aWwuaW5oZXJpdHMgPSByZXF1aXJlKCdpbmhlcml0cycpO1xuLyo8L3JlcGxhY2VtZW50PiovXG5cbnV0aWwuaW5oZXJpdHMoVHJhbnNmb3JtLCBEdXBsZXgpO1xuXG5cbmZ1bmN0aW9uIFRyYW5zZm9ybVN0YXRlKHN0cmVhbSkge1xuICB0aGlzLmFmdGVyVHJhbnNmb3JtID0gZnVuY3Rpb24oZXIsIGRhdGEpIHtcbiAgICByZXR1cm4gYWZ0ZXJUcmFuc2Zvcm0oc3RyZWFtLCBlciwgZGF0YSk7XG4gIH07XG5cbiAgdGhpcy5uZWVkVHJhbnNmb3JtID0gZmFsc2U7XG4gIHRoaXMudHJhbnNmb3JtaW5nID0gZmFsc2U7XG4gIHRoaXMud3JpdGVjYiA9IG51bGw7XG4gIHRoaXMud3JpdGVjaHVuayA9IG51bGw7XG59XG5cbmZ1bmN0aW9uIGFmdGVyVHJhbnNmb3JtKHN0cmVhbSwgZXIsIGRhdGEpIHtcbiAgdmFyIHRzID0gc3RyZWFtLl90cmFuc2Zvcm1TdGF0ZTtcbiAgdHMudHJhbnNmb3JtaW5nID0gZmFsc2U7XG5cbiAgdmFyIGNiID0gdHMud3JpdGVjYjtcblxuICBpZiAoIWNiKVxuICAgIHJldHVybiBzdHJlYW0uZW1pdCgnZXJyb3InLCBuZXcgRXJyb3IoJ25vIHdyaXRlY2IgaW4gVHJhbnNmb3JtIGNsYXNzJykpO1xuXG4gIHRzLndyaXRlY2h1bmsgPSBudWxsO1xuICB0cy53cml0ZWNiID0gbnVsbDtcblxuICBpZiAoZGF0YSAhPT0gbnVsbCAmJiBkYXRhICE9PSB1bmRlZmluZWQpXG4gICAgc3RyZWFtLnB1c2goZGF0YSk7XG5cbiAgaWYgKGNiKVxuICAgIGNiKGVyKTtcblxuICB2YXIgcnMgPSBzdHJlYW0uX3JlYWRhYmxlU3RhdGU7XG4gIHJzLnJlYWRpbmcgPSBmYWxzZTtcbiAgaWYgKHJzLm5lZWRSZWFkYWJsZSB8fCBycy5sZW5ndGggPCBycy5oaWdoV2F0ZXJNYXJrKSB7XG4gICAgc3RyZWFtLl9yZWFkKHJzLmhpZ2hXYXRlck1hcmspO1xuICB9XG59XG5cblxuZnVuY3Rpb24gVHJhbnNmb3JtKG9wdGlvbnMpIHtcbiAgaWYgKCEodGhpcyBpbnN0YW5jZW9mIFRyYW5zZm9ybSkpXG4gICAgcmV0dXJuIG5ldyBUcmFuc2Zvcm0ob3B0aW9ucyk7XG5cbiAgRHVwbGV4LmNhbGwodGhpcywgb3B0aW9ucyk7XG5cbiAgdGhpcy5fdHJhbnNmb3JtU3RhdGUgPSBuZXcgVHJhbnNmb3JtU3RhdGUodGhpcyk7XG5cbiAgLy8gd2hlbiB0aGUgd3JpdGFibGUgc2lkZSBmaW5pc2hlcywgdGhlbiBmbHVzaCBvdXQgYW55dGhpbmcgcmVtYWluaW5nLlxuICB2YXIgc3RyZWFtID0gdGhpcztcblxuICAvLyBzdGFydCBvdXQgYXNraW5nIGZvciBhIHJlYWRhYmxlIGV2ZW50IG9uY2UgZGF0YSBpcyB0cmFuc2Zvcm1lZC5cbiAgdGhpcy5fcmVhZGFibGVTdGF0ZS5uZWVkUmVhZGFibGUgPSB0cnVlO1xuXG4gIC8vIHdlIGhhdmUgaW1wbGVtZW50ZWQgdGhlIF9yZWFkIG1ldGhvZCwgYW5kIGRvbmUgdGhlIG90aGVyIHRoaW5nc1xuICAvLyB0aGF0IFJlYWRhYmxlIHdhbnRzIGJlZm9yZSB0aGUgZmlyc3QgX3JlYWQgY2FsbCwgc28gdW5zZXQgdGhlXG4gIC8vIHN5bmMgZ3VhcmQgZmxhZy5cbiAgdGhpcy5fcmVhZGFibGVTdGF0ZS5zeW5jID0gZmFsc2U7XG5cbiAgaWYgKG9wdGlvbnMpIHtcbiAgICBpZiAodHlwZW9mIG9wdGlvbnMudHJhbnNmb3JtID09PSAnZnVuY3Rpb24nKVxuICAgICAgdGhpcy5fdHJhbnNmb3JtID0gb3B0aW9ucy50cmFuc2Zvcm07XG5cbiAgICBpZiAodHlwZW9mIG9wdGlvbnMuZmx1c2ggPT09ICdmdW5jdGlvbicpXG4gICAgICB0aGlzLl9mbHVzaCA9IG9wdGlvbnMuZmx1c2g7XG4gIH1cblxuICB0aGlzLm9uY2UoJ3ByZWZpbmlzaCcsIGZ1bmN0aW9uKCkge1xuICAgIGlmICh0eXBlb2YgdGhpcy5fZmx1c2ggPT09ICdmdW5jdGlvbicpXG4gICAgICB0aGlzLl9mbHVzaChmdW5jdGlvbihlcikge1xuICAgICAgICBkb25lKHN0cmVhbSwgZXIpO1xuICAgICAgfSk7XG4gICAgZWxzZVxuICAgICAgZG9uZShzdHJlYW0pO1xuICB9KTtcbn1cblxuVHJhbnNmb3JtLnByb3RvdHlwZS5wdXNoID0gZnVuY3Rpb24oY2h1bmssIGVuY29kaW5nKSB7XG4gIHRoaXMuX3RyYW5zZm9ybVN0YXRlLm5lZWRUcmFuc2Zvcm0gPSBmYWxzZTtcbiAgcmV0dXJuIER1cGxleC5wcm90b3R5cGUucHVzaC5jYWxsKHRoaXMsIGNodW5rLCBlbmNvZGluZyk7XG59O1xuXG4vLyBUaGlzIGlzIHRoZSBwYXJ0IHdoZXJlIHlvdSBkbyBzdHVmZiFcbi8vIG92ZXJyaWRlIHRoaXMgZnVuY3Rpb24gaW4gaW1wbGVtZW50YXRpb24gY2xhc3Nlcy5cbi8vICdjaHVuaycgaXMgYW4gaW5wdXQgY2h1bmsuXG4vL1xuLy8gQ2FsbCBgcHVzaChuZXdDaHVuaylgIHRvIHBhc3MgYWxvbmcgdHJhbnNmb3JtZWQgb3V0cHV0XG4vLyB0byB0aGUgcmVhZGFibGUgc2lkZS4gIFlvdSBtYXkgY2FsbCAncHVzaCcgemVybyBvciBtb3JlIHRpbWVzLlxuLy9cbi8vIENhbGwgYGNiKGVycilgIHdoZW4geW91IGFyZSBkb25lIHdpdGggdGhpcyBjaHVuay4gIElmIHlvdSBwYXNzXG4vLyBhbiBlcnJvciwgdGhlbiB0aGF0J2xsIHB1dCB0aGUgaHVydCBvbiB0aGUgd2hvbGUgb3BlcmF0aW9uLiAgSWYgeW91XG4vLyBuZXZlciBjYWxsIGNiKCksIHRoZW4geW91J2xsIG5ldmVyIGdldCBhbm90aGVyIGNodW5rLlxuVHJhbnNmb3JtLnByb3RvdHlwZS5fdHJhbnNmb3JtID0gZnVuY3Rpb24oY2h1bmssIGVuY29kaW5nLCBjYikge1xuICB0aHJvdyBuZXcgRXJyb3IoJ25vdCBpbXBsZW1lbnRlZCcpO1xufTtcblxuVHJhbnNmb3JtLnByb3RvdHlwZS5fd3JpdGUgPSBmdW5jdGlvbihjaHVuaywgZW5jb2RpbmcsIGNiKSB7XG4gIHZhciB0cyA9IHRoaXMuX3RyYW5zZm9ybVN0YXRlO1xuICB0cy53cml0ZWNiID0gY2I7XG4gIHRzLndyaXRlY2h1bmsgPSBjaHVuaztcbiAgdHMud3JpdGVlbmNvZGluZyA9IGVuY29kaW5nO1xuICBpZiAoIXRzLnRyYW5zZm9ybWluZykge1xuICAgIHZhciBycyA9IHRoaXMuX3JlYWRhYmxlU3RhdGU7XG4gICAgaWYgKHRzLm5lZWRUcmFuc2Zvcm0gfHxcbiAgICAgICAgcnMubmVlZFJlYWRhYmxlIHx8XG4gICAgICAgIHJzLmxlbmd0aCA8IHJzLmhpZ2hXYXRlck1hcmspXG4gICAgICB0aGlzLl9yZWFkKHJzLmhpZ2hXYXRlck1hcmspO1xuICB9XG59O1xuXG4vLyBEb2Vzbid0IG1hdHRlciB3aGF0IHRoZSBhcmdzIGFyZSBoZXJlLlxuLy8gX3RyYW5zZm9ybSBkb2VzIGFsbCB0aGUgd29yay5cbi8vIFRoYXQgd2UgZ290IGhlcmUgbWVhbnMgdGhhdCB0aGUgcmVhZGFibGUgc2lkZSB3YW50cyBtb3JlIGRhdGEuXG5UcmFuc2Zvcm0ucHJvdG90eXBlLl9yZWFkID0gZnVuY3Rpb24obikge1xuICB2YXIgdHMgPSB0aGlzLl90cmFuc2Zvcm1TdGF0ZTtcblxuICBpZiAodHMud3JpdGVjaHVuayAhPT0gbnVsbCAmJiB0cy53cml0ZWNiICYmICF0cy50cmFuc2Zvcm1pbmcpIHtcbiAgICB0cy50cmFuc2Zvcm1pbmcgPSB0cnVlO1xuICAgIHRoaXMuX3RyYW5zZm9ybSh0cy53cml0ZWNodW5rLCB0cy53cml0ZWVuY29kaW5nLCB0cy5hZnRlclRyYW5zZm9ybSk7XG4gIH0gZWxzZSB7XG4gICAgLy8gbWFyayB0aGF0IHdlIG5lZWQgYSB0cmFuc2Zvcm0sIHNvIHRoYXQgYW55IGRhdGEgdGhhdCBjb21lcyBpblxuICAgIC8vIHdpbGwgZ2V0IHByb2Nlc3NlZCwgbm93IHRoYXQgd2UndmUgYXNrZWQgZm9yIGl0LlxuICAgIHRzLm5lZWRUcmFuc2Zvcm0gPSB0cnVlO1xuICB9XG59O1xuXG5cbmZ1bmN0aW9uIGRvbmUoc3RyZWFtLCBlcikge1xuICBpZiAoZXIpXG4gICAgcmV0dXJuIHN0cmVhbS5lbWl0KCdlcnJvcicsIGVyKTtcblxuICAvLyBpZiB0aGVyZSdzIG5vdGhpbmcgaW4gdGhlIHdyaXRlIGJ1ZmZlciwgdGhlbiB0aGF0IG1lYW5zXG4gIC8vIHRoYXQgbm90aGluZyBtb3JlIHdpbGwgZXZlciBiZSBwcm92aWRlZFxuICB2YXIgd3MgPSBzdHJlYW0uX3dyaXRhYmxlU3RhdGU7XG4gIHZhciB0cyA9IHN0cmVhbS5fdHJhbnNmb3JtU3RhdGU7XG5cbiAgaWYgKHdzLmxlbmd0aClcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ2NhbGxpbmcgdHJhbnNmb3JtIGRvbmUgd2hlbiB3cy5sZW5ndGggIT0gMCcpO1xuXG4gIGlmICh0cy50cmFuc2Zvcm1pbmcpXG4gICAgdGhyb3cgbmV3IEVycm9yKCdjYWxsaW5nIHRyYW5zZm9ybSBkb25lIHdoZW4gc3RpbGwgdHJhbnNmb3JtaW5nJyk7XG5cbiAgcmV0dXJuIHN0cmVhbS5wdXNoKG51bGwpO1xufVxuIiwiLy8gQSBiaXQgc2ltcGxlciB0aGFuIHJlYWRhYmxlIHN0cmVhbXMuXG4vLyBJbXBsZW1lbnQgYW4gYXN5bmMgLl93cml0ZShjaHVuaywgY2IpLCBhbmQgaXQnbGwgaGFuZGxlIGFsbFxuLy8gdGhlIGRyYWluIGV2ZW50IGVtaXNzaW9uIGFuZCBidWZmZXJpbmcuXG5cbid1c2Ugc3RyaWN0JztcblxubW9kdWxlLmV4cG9ydHMgPSBXcml0YWJsZTtcblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciBwcm9jZXNzTmV4dFRpY2sgPSByZXF1aXJlKCdwcm9jZXNzLW5leHRpY2stYXJncycpO1xuLyo8L3JlcGxhY2VtZW50PiovXG5cblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciBCdWZmZXIgPSByZXF1aXJlKCdidWZmZXInKS5CdWZmZXI7XG4vKjwvcmVwbGFjZW1lbnQ+Ki9cblxuV3JpdGFibGUuV3JpdGFibGVTdGF0ZSA9IFdyaXRhYmxlU3RhdGU7XG5cblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciB1dGlsID0gcmVxdWlyZSgnY29yZS11dGlsLWlzJyk7XG51dGlsLmluaGVyaXRzID0gcmVxdWlyZSgnaW5oZXJpdHMnKTtcbi8qPC9yZXBsYWNlbWVudD4qL1xuXG5cblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciBTdHJlYW07XG4oZnVuY3Rpb24gKCl7dHJ5e1xuICBTdHJlYW0gPSByZXF1aXJlKCdzdCcgKyAncmVhbScpO1xufWNhdGNoKF8pe31maW5hbGx5e1xuICBpZiAoIVN0cmVhbSlcbiAgICBTdHJlYW0gPSByZXF1aXJlKCdldmVudHMnKS5FdmVudEVtaXR0ZXI7XG59fSgpKVxuLyo8L3JlcGxhY2VtZW50PiovXG5cbnZhciBCdWZmZXIgPSByZXF1aXJlKCdidWZmZXInKS5CdWZmZXI7XG5cbnV0aWwuaW5oZXJpdHMoV3JpdGFibGUsIFN0cmVhbSk7XG5cbmZ1bmN0aW9uIG5vcCgpIHt9XG5cbmZ1bmN0aW9uIFdyaXRlUmVxKGNodW5rLCBlbmNvZGluZywgY2IpIHtcbiAgdGhpcy5jaHVuayA9IGNodW5rO1xuICB0aGlzLmVuY29kaW5nID0gZW5jb2Rpbmc7XG4gIHRoaXMuY2FsbGJhY2sgPSBjYjtcbiAgdGhpcy5uZXh0ID0gbnVsbDtcbn1cblxuZnVuY3Rpb24gV3JpdGFibGVTdGF0ZShvcHRpb25zLCBzdHJlYW0pIHtcbiAgdmFyIER1cGxleCA9IHJlcXVpcmUoJy4vX3N0cmVhbV9kdXBsZXgnKTtcblxuICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcblxuICAvLyBvYmplY3Qgc3RyZWFtIGZsYWcgdG8gaW5kaWNhdGUgd2hldGhlciBvciBub3QgdGhpcyBzdHJlYW1cbiAgLy8gY29udGFpbnMgYnVmZmVycyBvciBvYmplY3RzLlxuICB0aGlzLm9iamVjdE1vZGUgPSAhIW9wdGlvbnMub2JqZWN0TW9kZTtcblxuICBpZiAoc3RyZWFtIGluc3RhbmNlb2YgRHVwbGV4KVxuICAgIHRoaXMub2JqZWN0TW9kZSA9IHRoaXMub2JqZWN0TW9kZSB8fCAhIW9wdGlvbnMud3JpdGFibGVPYmplY3RNb2RlO1xuXG4gIC8vIHRoZSBwb2ludCBhdCB3aGljaCB3cml0ZSgpIHN0YXJ0cyByZXR1cm5pbmcgZmFsc2VcbiAgLy8gTm90ZTogMCBpcyBhIHZhbGlkIHZhbHVlLCBtZWFucyB0aGF0IHdlIGFsd2F5cyByZXR1cm4gZmFsc2UgaWZcbiAgLy8gdGhlIGVudGlyZSBidWZmZXIgaXMgbm90IGZsdXNoZWQgaW1tZWRpYXRlbHkgb24gd3JpdGUoKVxuICB2YXIgaHdtID0gb3B0aW9ucy5oaWdoV2F0ZXJNYXJrO1xuICB2YXIgZGVmYXVsdEh3bSA9IHRoaXMub2JqZWN0TW9kZSA/IDE2IDogMTYgKiAxMDI0O1xuICB0aGlzLmhpZ2hXYXRlck1hcmsgPSAoaHdtIHx8IGh3bSA9PT0gMCkgPyBod20gOiBkZWZhdWx0SHdtO1xuXG4gIC8vIGNhc3QgdG8gaW50cy5cbiAgdGhpcy5oaWdoV2F0ZXJNYXJrID0gfn50aGlzLmhpZ2hXYXRlck1hcms7XG5cbiAgdGhpcy5uZWVkRHJhaW4gPSBmYWxzZTtcbiAgLy8gYXQgdGhlIHN0YXJ0IG9mIGNhbGxpbmcgZW5kKClcbiAgdGhpcy5lbmRpbmcgPSBmYWxzZTtcbiAgLy8gd2hlbiBlbmQoKSBoYXMgYmVlbiBjYWxsZWQsIGFuZCByZXR1cm5lZFxuICB0aGlzLmVuZGVkID0gZmFsc2U7XG4gIC8vIHdoZW4gJ2ZpbmlzaCcgaXMgZW1pdHRlZFxuICB0aGlzLmZpbmlzaGVkID0gZmFsc2U7XG5cbiAgLy8gc2hvdWxkIHdlIGRlY29kZSBzdHJpbmdzIGludG8gYnVmZmVycyBiZWZvcmUgcGFzc2luZyB0byBfd3JpdGU/XG4gIC8vIHRoaXMgaXMgaGVyZSBzbyB0aGF0IHNvbWUgbm9kZS1jb3JlIHN0cmVhbXMgY2FuIG9wdGltaXplIHN0cmluZ1xuICAvLyBoYW5kbGluZyBhdCBhIGxvd2VyIGxldmVsLlxuICB2YXIgbm9EZWNvZGUgPSBvcHRpb25zLmRlY29kZVN0cmluZ3MgPT09IGZhbHNlO1xuICB0aGlzLmRlY29kZVN0cmluZ3MgPSAhbm9EZWNvZGU7XG5cbiAgLy8gQ3J5cHRvIGlzIGtpbmQgb2Ygb2xkIGFuZCBjcnVzdHkuICBIaXN0b3JpY2FsbHksIGl0cyBkZWZhdWx0IHN0cmluZ1xuICAvLyBlbmNvZGluZyBpcyAnYmluYXJ5JyBzbyB3ZSBoYXZlIHRvIG1ha2UgdGhpcyBjb25maWd1cmFibGUuXG4gIC8vIEV2ZXJ5dGhpbmcgZWxzZSBpbiB0aGUgdW5pdmVyc2UgdXNlcyAndXRmOCcsIHRob3VnaC5cbiAgdGhpcy5kZWZhdWx0RW5jb2RpbmcgPSBvcHRpb25zLmRlZmF1bHRFbmNvZGluZyB8fCAndXRmOCc7XG5cbiAgLy8gbm90IGFuIGFjdHVhbCBidWZmZXIgd2Uga2VlcCB0cmFjayBvZiwgYnV0IGEgbWVhc3VyZW1lbnRcbiAgLy8gb2YgaG93IG11Y2ggd2UncmUgd2FpdGluZyB0byBnZXQgcHVzaGVkIHRvIHNvbWUgdW5kZXJseWluZ1xuICAvLyBzb2NrZXQgb3IgZmlsZS5cbiAgdGhpcy5sZW5ndGggPSAwO1xuXG4gIC8vIGEgZmxhZyB0byBzZWUgd2hlbiB3ZSdyZSBpbiB0aGUgbWlkZGxlIG9mIGEgd3JpdGUuXG4gIHRoaXMud3JpdGluZyA9IGZhbHNlO1xuXG4gIC8vIHdoZW4gdHJ1ZSBhbGwgd3JpdGVzIHdpbGwgYmUgYnVmZmVyZWQgdW50aWwgLnVuY29yaygpIGNhbGxcbiAgdGhpcy5jb3JrZWQgPSAwO1xuXG4gIC8vIGEgZmxhZyB0byBiZSBhYmxlIHRvIHRlbGwgaWYgdGhlIG9ud3JpdGUgY2IgaXMgY2FsbGVkIGltbWVkaWF0ZWx5LFxuICAvLyBvciBvbiBhIGxhdGVyIHRpY2suICBXZSBzZXQgdGhpcyB0byB0cnVlIGF0IGZpcnN0LCBiZWNhdXNlIGFueVxuICAvLyBhY3Rpb25zIHRoYXQgc2hvdWxkbid0IGhhcHBlbiB1bnRpbCBcImxhdGVyXCIgc2hvdWxkIGdlbmVyYWxseSBhbHNvXG4gIC8vIG5vdCBoYXBwZW4gYmVmb3JlIHRoZSBmaXJzdCB3cml0ZSBjYWxsLlxuICB0aGlzLnN5bmMgPSB0cnVlO1xuXG4gIC8vIGEgZmxhZyB0byBrbm93IGlmIHdlJ3JlIHByb2Nlc3NpbmcgcHJldmlvdXNseSBidWZmZXJlZCBpdGVtcywgd2hpY2hcbiAgLy8gbWF5IGNhbGwgdGhlIF93cml0ZSgpIGNhbGxiYWNrIGluIHRoZSBzYW1lIHRpY2ssIHNvIHRoYXQgd2UgZG9uJ3RcbiAgLy8gZW5kIHVwIGluIGFuIG92ZXJsYXBwZWQgb253cml0ZSBzaXR1YXRpb24uXG4gIHRoaXMuYnVmZmVyUHJvY2Vzc2luZyA9IGZhbHNlO1xuXG4gIC8vIHRoZSBjYWxsYmFjayB0aGF0J3MgcGFzc2VkIHRvIF93cml0ZShjaHVuayxjYilcbiAgdGhpcy5vbndyaXRlID0gZnVuY3Rpb24oZXIpIHtcbiAgICBvbndyaXRlKHN0cmVhbSwgZXIpO1xuICB9O1xuXG4gIC8vIHRoZSBjYWxsYmFjayB0aGF0IHRoZSB1c2VyIHN1cHBsaWVzIHRvIHdyaXRlKGNodW5rLGVuY29kaW5nLGNiKVxuICB0aGlzLndyaXRlY2IgPSBudWxsO1xuXG4gIC8vIHRoZSBhbW91bnQgdGhhdCBpcyBiZWluZyB3cml0dGVuIHdoZW4gX3dyaXRlIGlzIGNhbGxlZC5cbiAgdGhpcy53cml0ZWxlbiA9IDA7XG5cbiAgdGhpcy5idWZmZXJlZFJlcXVlc3QgPSBudWxsO1xuICB0aGlzLmxhc3RCdWZmZXJlZFJlcXVlc3QgPSBudWxsO1xuXG4gIC8vIG51bWJlciBvZiBwZW5kaW5nIHVzZXItc3VwcGxpZWQgd3JpdGUgY2FsbGJhY2tzXG4gIC8vIHRoaXMgbXVzdCBiZSAwIGJlZm9yZSAnZmluaXNoJyBjYW4gYmUgZW1pdHRlZFxuICB0aGlzLnBlbmRpbmdjYiA9IDA7XG5cbiAgLy8gZW1pdCBwcmVmaW5pc2ggaWYgdGhlIG9ubHkgdGhpbmcgd2UncmUgd2FpdGluZyBmb3IgaXMgX3dyaXRlIGNic1xuICAvLyBUaGlzIGlzIHJlbGV2YW50IGZvciBzeW5jaHJvbm91cyBUcmFuc2Zvcm0gc3RyZWFtc1xuICB0aGlzLnByZWZpbmlzaGVkID0gZmFsc2U7XG5cbiAgLy8gVHJ1ZSBpZiB0aGUgZXJyb3Igd2FzIGFscmVhZHkgZW1pdHRlZCBhbmQgc2hvdWxkIG5vdCBiZSB0aHJvd24gYWdhaW5cbiAgdGhpcy5lcnJvckVtaXR0ZWQgPSBmYWxzZTtcbn1cblxuV3JpdGFibGVTdGF0ZS5wcm90b3R5cGUuZ2V0QnVmZmVyID0gZnVuY3Rpb24gd3JpdGFibGVTdGF0ZUdldEJ1ZmZlcigpIHtcbiAgdmFyIGN1cnJlbnQgPSB0aGlzLmJ1ZmZlcmVkUmVxdWVzdDtcbiAgdmFyIG91dCA9IFtdO1xuICB3aGlsZSAoY3VycmVudCkge1xuICAgIG91dC5wdXNoKGN1cnJlbnQpO1xuICAgIGN1cnJlbnQgPSBjdXJyZW50Lm5leHQ7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn07XG5cbihmdW5jdGlvbiAoKXt0cnkge1xuT2JqZWN0LmRlZmluZVByb3BlcnR5KFdyaXRhYmxlU3RhdGUucHJvdG90eXBlLCAnYnVmZmVyJywge1xuICBnZXQ6IHJlcXVpcmUoJ3V0aWwtZGVwcmVjYXRlJykoZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHRoaXMuZ2V0QnVmZmVyKCk7XG4gIH0sICdfd3JpdGFibGVTdGF0ZS5idWZmZXIgaXMgZGVwcmVjYXRlZC4gVXNlICcgK1xuICAgICAgJ193cml0YWJsZVN0YXRlLmdldEJ1ZmZlcigpIGluc3RlYWQuJylcbn0pO1xufWNhdGNoKF8pe319KCkpO1xuXG5cbmZ1bmN0aW9uIFdyaXRhYmxlKG9wdGlvbnMpIHtcbiAgdmFyIER1cGxleCA9IHJlcXVpcmUoJy4vX3N0cmVhbV9kdXBsZXgnKTtcblxuICAvLyBXcml0YWJsZSBjdG9yIGlzIGFwcGxpZWQgdG8gRHVwbGV4ZXMsIHRob3VnaCB0aGV5J3JlIG5vdFxuICAvLyBpbnN0YW5jZW9mIFdyaXRhYmxlLCB0aGV5J3JlIGluc3RhbmNlb2YgUmVhZGFibGUuXG4gIGlmICghKHRoaXMgaW5zdGFuY2VvZiBXcml0YWJsZSkgJiYgISh0aGlzIGluc3RhbmNlb2YgRHVwbGV4KSlcbiAgICByZXR1cm4gbmV3IFdyaXRhYmxlKG9wdGlvbnMpO1xuXG4gIHRoaXMuX3dyaXRhYmxlU3RhdGUgPSBuZXcgV3JpdGFibGVTdGF0ZShvcHRpb25zLCB0aGlzKTtcblxuICAvLyBsZWdhY3kuXG4gIHRoaXMud3JpdGFibGUgPSB0cnVlO1xuXG4gIGlmIChvcHRpb25zKSB7XG4gICAgaWYgKHR5cGVvZiBvcHRpb25zLndyaXRlID09PSAnZnVuY3Rpb24nKVxuICAgICAgdGhpcy5fd3JpdGUgPSBvcHRpb25zLndyaXRlO1xuXG4gICAgaWYgKHR5cGVvZiBvcHRpb25zLndyaXRldiA9PT0gJ2Z1bmN0aW9uJylcbiAgICAgIHRoaXMuX3dyaXRldiA9IG9wdGlvbnMud3JpdGV2O1xuICB9XG5cbiAgU3RyZWFtLmNhbGwodGhpcyk7XG59XG5cbi8vIE90aGVyd2lzZSBwZW9wbGUgY2FuIHBpcGUgV3JpdGFibGUgc3RyZWFtcywgd2hpY2ggaXMganVzdCB3cm9uZy5cbldyaXRhYmxlLnByb3RvdHlwZS5waXBlID0gZnVuY3Rpb24oKSB7XG4gIHRoaXMuZW1pdCgnZXJyb3InLCBuZXcgRXJyb3IoJ0Nhbm5vdCBwaXBlLiBOb3QgcmVhZGFibGUuJykpO1xufTtcblxuXG5mdW5jdGlvbiB3cml0ZUFmdGVyRW5kKHN0cmVhbSwgY2IpIHtcbiAgdmFyIGVyID0gbmV3IEVycm9yKCd3cml0ZSBhZnRlciBlbmQnKTtcbiAgLy8gVE9ETzogZGVmZXIgZXJyb3IgZXZlbnRzIGNvbnNpc3RlbnRseSBldmVyeXdoZXJlLCBub3QganVzdCB0aGUgY2JcbiAgc3RyZWFtLmVtaXQoJ2Vycm9yJywgZXIpO1xuICBwcm9jZXNzTmV4dFRpY2soY2IsIGVyKTtcbn1cblxuLy8gSWYgd2UgZ2V0IHNvbWV0aGluZyB0aGF0IGlzIG5vdCBhIGJ1ZmZlciwgc3RyaW5nLCBudWxsLCBvciB1bmRlZmluZWQsXG4vLyBhbmQgd2UncmUgbm90IGluIG9iamVjdE1vZGUsIHRoZW4gdGhhdCdzIGFuIGVycm9yLlxuLy8gT3RoZXJ3aXNlIHN0cmVhbSBjaHVua3MgYXJlIGFsbCBjb25zaWRlcmVkIHRvIGJlIG9mIGxlbmd0aD0xLCBhbmQgdGhlXG4vLyB3YXRlcm1hcmtzIGRldGVybWluZSBob3cgbWFueSBvYmplY3RzIHRvIGtlZXAgaW4gdGhlIGJ1ZmZlciwgcmF0aGVyIHRoYW5cbi8vIGhvdyBtYW55IGJ5dGVzIG9yIGNoYXJhY3RlcnMuXG5mdW5jdGlvbiB2YWxpZENodW5rKHN0cmVhbSwgc3RhdGUsIGNodW5rLCBjYikge1xuICB2YXIgdmFsaWQgPSB0cnVlO1xuXG4gIGlmICghKEJ1ZmZlci5pc0J1ZmZlcihjaHVuaykpICYmXG4gICAgICB0eXBlb2YgY2h1bmsgIT09ICdzdHJpbmcnICYmXG4gICAgICBjaHVuayAhPT0gbnVsbCAmJlxuICAgICAgY2h1bmsgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgIXN0YXRlLm9iamVjdE1vZGUpIHtcbiAgICB2YXIgZXIgPSBuZXcgVHlwZUVycm9yKCdJbnZhbGlkIG5vbi1zdHJpbmcvYnVmZmVyIGNodW5rJyk7XG4gICAgc3RyZWFtLmVtaXQoJ2Vycm9yJywgZXIpO1xuICAgIHByb2Nlc3NOZXh0VGljayhjYiwgZXIpO1xuICAgIHZhbGlkID0gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHZhbGlkO1xufVxuXG5Xcml0YWJsZS5wcm90b3R5cGUud3JpdGUgPSBmdW5jdGlvbihjaHVuaywgZW5jb2RpbmcsIGNiKSB7XG4gIHZhciBzdGF0ZSA9IHRoaXMuX3dyaXRhYmxlU3RhdGU7XG4gIHZhciByZXQgPSBmYWxzZTtcblxuICBpZiAodHlwZW9mIGVuY29kaW5nID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2IgPSBlbmNvZGluZztcbiAgICBlbmNvZGluZyA9IG51bGw7XG4gIH1cblxuICBpZiAoQnVmZmVyLmlzQnVmZmVyKGNodW5rKSlcbiAgICBlbmNvZGluZyA9ICdidWZmZXInO1xuICBlbHNlIGlmICghZW5jb2RpbmcpXG4gICAgZW5jb2RpbmcgPSBzdGF0ZS5kZWZhdWx0RW5jb2Rpbmc7XG5cbiAgaWYgKHR5cGVvZiBjYiAhPT0gJ2Z1bmN0aW9uJylcbiAgICBjYiA9IG5vcDtcblxuICBpZiAoc3RhdGUuZW5kZWQpXG4gICAgd3JpdGVBZnRlckVuZCh0aGlzLCBjYik7XG4gIGVsc2UgaWYgKHZhbGlkQ2h1bmsodGhpcywgc3RhdGUsIGNodW5rLCBjYikpIHtcbiAgICBzdGF0ZS5wZW5kaW5nY2IrKztcbiAgICByZXQgPSB3cml0ZU9yQnVmZmVyKHRoaXMsIHN0YXRlLCBjaHVuaywgZW5jb2RpbmcsIGNiKTtcbiAgfVxuXG4gIHJldHVybiByZXQ7XG59O1xuXG5Xcml0YWJsZS5wcm90b3R5cGUuY29yayA9IGZ1bmN0aW9uKCkge1xuICB2YXIgc3RhdGUgPSB0aGlzLl93cml0YWJsZVN0YXRlO1xuXG4gIHN0YXRlLmNvcmtlZCsrO1xufTtcblxuV3JpdGFibGUucHJvdG90eXBlLnVuY29yayA9IGZ1bmN0aW9uKCkge1xuICB2YXIgc3RhdGUgPSB0aGlzLl93cml0YWJsZVN0YXRlO1xuXG4gIGlmIChzdGF0ZS5jb3JrZWQpIHtcbiAgICBzdGF0ZS5jb3JrZWQtLTtcblxuICAgIGlmICghc3RhdGUud3JpdGluZyAmJlxuICAgICAgICAhc3RhdGUuY29ya2VkICYmXG4gICAgICAgICFzdGF0ZS5maW5pc2hlZCAmJlxuICAgICAgICAhc3RhdGUuYnVmZmVyUHJvY2Vzc2luZyAmJlxuICAgICAgICBzdGF0ZS5idWZmZXJlZFJlcXVlc3QpXG4gICAgICBjbGVhckJ1ZmZlcih0aGlzLCBzdGF0ZSk7XG4gIH1cbn07XG5cbldyaXRhYmxlLnByb3RvdHlwZS5zZXREZWZhdWx0RW5jb2RpbmcgPSBmdW5jdGlvbiBzZXREZWZhdWx0RW5jb2RpbmcoZW5jb2RpbmcpIHtcbiAgLy8gbm9kZTo6UGFyc2VFbmNvZGluZygpIHJlcXVpcmVzIGxvd2VyIGNhc2UuXG4gIGlmICh0eXBlb2YgZW5jb2RpbmcgPT09ICdzdHJpbmcnKVxuICAgIGVuY29kaW5nID0gZW5jb2RpbmcudG9Mb3dlckNhc2UoKTtcbiAgaWYgKCEoWydoZXgnLCAndXRmOCcsICd1dGYtOCcsICdhc2NpaScsICdiaW5hcnknLCAnYmFzZTY0Jyxcbid1Y3MyJywgJ3Vjcy0yJywndXRmMTZsZScsICd1dGYtMTZsZScsICdyYXcnXVxuLmluZGV4T2YoKGVuY29kaW5nICsgJycpLnRvTG93ZXJDYXNlKCkpID4gLTEpKVxuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ1Vua25vd24gZW5jb2Rpbmc6ICcgKyBlbmNvZGluZyk7XG4gIHRoaXMuX3dyaXRhYmxlU3RhdGUuZGVmYXVsdEVuY29kaW5nID0gZW5jb2Rpbmc7XG59O1xuXG5mdW5jdGlvbiBkZWNvZGVDaHVuayhzdGF0ZSwgY2h1bmssIGVuY29kaW5nKSB7XG4gIGlmICghc3RhdGUub2JqZWN0TW9kZSAmJlxuICAgICAgc3RhdGUuZGVjb2RlU3RyaW5ncyAhPT0gZmFsc2UgJiZcbiAgICAgIHR5cGVvZiBjaHVuayA9PT0gJ3N0cmluZycpIHtcbiAgICBjaHVuayA9IG5ldyBCdWZmZXIoY2h1bmssIGVuY29kaW5nKTtcbiAgfVxuICByZXR1cm4gY2h1bms7XG59XG5cbi8vIGlmIHdlJ3JlIGFscmVhZHkgd3JpdGluZyBzb21ldGhpbmcsIHRoZW4ganVzdCBwdXQgdGhpc1xuLy8gaW4gdGhlIHF1ZXVlLCBhbmQgd2FpdCBvdXIgdHVybi4gIE90aGVyd2lzZSwgY2FsbCBfd3JpdGVcbi8vIElmIHdlIHJldHVybiBmYWxzZSwgdGhlbiB3ZSBuZWVkIGEgZHJhaW4gZXZlbnQsIHNvIHNldCB0aGF0IGZsYWcuXG5mdW5jdGlvbiB3cml0ZU9yQnVmZmVyKHN0cmVhbSwgc3RhdGUsIGNodW5rLCBlbmNvZGluZywgY2IpIHtcbiAgY2h1bmsgPSBkZWNvZGVDaHVuayhzdGF0ZSwgY2h1bmssIGVuY29kaW5nKTtcblxuICBpZiAoQnVmZmVyLmlzQnVmZmVyKGNodW5rKSlcbiAgICBlbmNvZGluZyA9ICdidWZmZXInO1xuICB2YXIgbGVuID0gc3RhdGUub2JqZWN0TW9kZSA/IDEgOiBjaHVuay5sZW5ndGg7XG5cbiAgc3RhdGUubGVuZ3RoICs9IGxlbjtcblxuICB2YXIgcmV0ID0gc3RhdGUubGVuZ3RoIDwgc3RhdGUuaGlnaFdhdGVyTWFyaztcbiAgLy8gd2UgbXVzdCBlbnN1cmUgdGhhdCBwcmV2aW91cyBuZWVkRHJhaW4gd2lsbCBub3QgYmUgcmVzZXQgdG8gZmFsc2UuXG4gIGlmICghcmV0KVxuICAgIHN0YXRlLm5lZWREcmFpbiA9IHRydWU7XG5cbiAgaWYgKHN0YXRlLndyaXRpbmcgfHwgc3RhdGUuY29ya2VkKSB7XG4gICAgdmFyIGxhc3QgPSBzdGF0ZS5sYXN0QnVmZmVyZWRSZXF1ZXN0O1xuICAgIHN0YXRlLmxhc3RCdWZmZXJlZFJlcXVlc3QgPSBuZXcgV3JpdGVSZXEoY2h1bmssIGVuY29kaW5nLCBjYik7XG4gICAgaWYgKGxhc3QpIHtcbiAgICAgIGxhc3QubmV4dCA9IHN0YXRlLmxhc3RCdWZmZXJlZFJlcXVlc3Q7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0YXRlLmJ1ZmZlcmVkUmVxdWVzdCA9IHN0YXRlLmxhc3RCdWZmZXJlZFJlcXVlc3Q7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGRvV3JpdGUoc3RyZWFtLCBzdGF0ZSwgZmFsc2UsIGxlbiwgY2h1bmssIGVuY29kaW5nLCBjYik7XG4gIH1cblxuICByZXR1cm4gcmV0O1xufVxuXG5mdW5jdGlvbiBkb1dyaXRlKHN0cmVhbSwgc3RhdGUsIHdyaXRldiwgbGVuLCBjaHVuaywgZW5jb2RpbmcsIGNiKSB7XG4gIHN0YXRlLndyaXRlbGVuID0gbGVuO1xuICBzdGF0ZS53cml0ZWNiID0gY2I7XG4gIHN0YXRlLndyaXRpbmcgPSB0cnVlO1xuICBzdGF0ZS5zeW5jID0gdHJ1ZTtcbiAgaWYgKHdyaXRldilcbiAgICBzdHJlYW0uX3dyaXRldihjaHVuaywgc3RhdGUub253cml0ZSk7XG4gIGVsc2VcbiAgICBzdHJlYW0uX3dyaXRlKGNodW5rLCBlbmNvZGluZywgc3RhdGUub253cml0ZSk7XG4gIHN0YXRlLnN5bmMgPSBmYWxzZTtcbn1cblxuZnVuY3Rpb24gb253cml0ZUVycm9yKHN0cmVhbSwgc3RhdGUsIHN5bmMsIGVyLCBjYikge1xuICAtLXN0YXRlLnBlbmRpbmdjYjtcbiAgaWYgKHN5bmMpXG4gICAgcHJvY2Vzc05leHRUaWNrKGNiLCBlcik7XG4gIGVsc2VcbiAgICBjYihlcik7XG5cbiAgc3RyZWFtLl93cml0YWJsZVN0YXRlLmVycm9yRW1pdHRlZCA9IHRydWU7XG4gIHN0cmVhbS5lbWl0KCdlcnJvcicsIGVyKTtcbn1cblxuZnVuY3Rpb24gb253cml0ZVN0YXRlVXBkYXRlKHN0YXRlKSB7XG4gIHN0YXRlLndyaXRpbmcgPSBmYWxzZTtcbiAgc3RhdGUud3JpdGVjYiA9IG51bGw7XG4gIHN0YXRlLmxlbmd0aCAtPSBzdGF0ZS53cml0ZWxlbjtcbiAgc3RhdGUud3JpdGVsZW4gPSAwO1xufVxuXG5mdW5jdGlvbiBvbndyaXRlKHN0cmVhbSwgZXIpIHtcbiAgdmFyIHN0YXRlID0gc3RyZWFtLl93cml0YWJsZVN0YXRlO1xuICB2YXIgc3luYyA9IHN0YXRlLnN5bmM7XG4gIHZhciBjYiA9IHN0YXRlLndyaXRlY2I7XG5cbiAgb253cml0ZVN0YXRlVXBkYXRlKHN0YXRlKTtcblxuICBpZiAoZXIpXG4gICAgb253cml0ZUVycm9yKHN0cmVhbSwgc3RhdGUsIHN5bmMsIGVyLCBjYik7XG4gIGVsc2Uge1xuICAgIC8vIENoZWNrIGlmIHdlJ3JlIGFjdHVhbGx5IHJlYWR5IHRvIGZpbmlzaCwgYnV0IGRvbid0IGVtaXQgeWV0XG4gICAgdmFyIGZpbmlzaGVkID0gbmVlZEZpbmlzaChzdGF0ZSk7XG5cbiAgICBpZiAoIWZpbmlzaGVkICYmXG4gICAgICAgICFzdGF0ZS5jb3JrZWQgJiZcbiAgICAgICAgIXN0YXRlLmJ1ZmZlclByb2Nlc3NpbmcgJiZcbiAgICAgICAgc3RhdGUuYnVmZmVyZWRSZXF1ZXN0KSB7XG4gICAgICBjbGVhckJ1ZmZlcihzdHJlYW0sIHN0YXRlKTtcbiAgICB9XG5cbiAgICBpZiAoc3luYykge1xuICAgICAgcHJvY2Vzc05leHRUaWNrKGFmdGVyV3JpdGUsIHN0cmVhbSwgc3RhdGUsIGZpbmlzaGVkLCBjYik7XG4gICAgfSBlbHNlIHtcbiAgICAgIGFmdGVyV3JpdGUoc3RyZWFtLCBzdGF0ZSwgZmluaXNoZWQsIGNiKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gYWZ0ZXJXcml0ZShzdHJlYW0sIHN0YXRlLCBmaW5pc2hlZCwgY2IpIHtcbiAgaWYgKCFmaW5pc2hlZClcbiAgICBvbndyaXRlRHJhaW4oc3RyZWFtLCBzdGF0ZSk7XG4gIHN0YXRlLnBlbmRpbmdjYi0tO1xuICBjYigpO1xuICBmaW5pc2hNYXliZShzdHJlYW0sIHN0YXRlKTtcbn1cblxuLy8gTXVzdCBmb3JjZSBjYWxsYmFjayB0byBiZSBjYWxsZWQgb24gbmV4dFRpY2ssIHNvIHRoYXQgd2UgZG9uJ3Rcbi8vIGVtaXQgJ2RyYWluJyBiZWZvcmUgdGhlIHdyaXRlKCkgY29uc3VtZXIgZ2V0cyB0aGUgJ2ZhbHNlJyByZXR1cm5cbi8vIHZhbHVlLCBhbmQgaGFzIGEgY2hhbmNlIHRvIGF0dGFjaCBhICdkcmFpbicgbGlzdGVuZXIuXG5mdW5jdGlvbiBvbndyaXRlRHJhaW4oc3RyZWFtLCBzdGF0ZSkge1xuICBpZiAoc3RhdGUubGVuZ3RoID09PSAwICYmIHN0YXRlLm5lZWREcmFpbikge1xuICAgIHN0YXRlLm5lZWREcmFpbiA9IGZhbHNlO1xuICAgIHN0cmVhbS5lbWl0KCdkcmFpbicpO1xuICB9XG59XG5cblxuLy8gaWYgdGhlcmUncyBzb21ldGhpbmcgaW4gdGhlIGJ1ZmZlciB3YWl0aW5nLCB0aGVuIHByb2Nlc3MgaXRcbmZ1bmN0aW9uIGNsZWFyQnVmZmVyKHN0cmVhbSwgc3RhdGUpIHtcbiAgc3RhdGUuYnVmZmVyUHJvY2Vzc2luZyA9IHRydWU7XG4gIHZhciBlbnRyeSA9IHN0YXRlLmJ1ZmZlcmVkUmVxdWVzdDtcblxuICBpZiAoc3RyZWFtLl93cml0ZXYgJiYgZW50cnkgJiYgZW50cnkubmV4dCkge1xuICAgIC8vIEZhc3QgY2FzZSwgd3JpdGUgZXZlcnl0aGluZyB1c2luZyBfd3JpdGV2KClcbiAgICB2YXIgYnVmZmVyID0gW107XG4gICAgdmFyIGNicyA9IFtdO1xuICAgIHdoaWxlIChlbnRyeSkge1xuICAgICAgY2JzLnB1c2goZW50cnkuY2FsbGJhY2spO1xuICAgICAgYnVmZmVyLnB1c2goZW50cnkpO1xuICAgICAgZW50cnkgPSBlbnRyeS5uZXh0O1xuICAgIH1cblxuICAgIC8vIGNvdW50IHRoZSBvbmUgd2UgYXJlIGFkZGluZywgYXMgd2VsbC5cbiAgICAvLyBUT0RPKGlzYWFjcykgY2xlYW4gdGhpcyB1cFxuICAgIHN0YXRlLnBlbmRpbmdjYisrO1xuICAgIHN0YXRlLmxhc3RCdWZmZXJlZFJlcXVlc3QgPSBudWxsO1xuICAgIGRvV3JpdGUoc3RyZWFtLCBzdGF0ZSwgdHJ1ZSwgc3RhdGUubGVuZ3RoLCBidWZmZXIsICcnLCBmdW5jdGlvbihlcnIpIHtcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgY2JzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHN0YXRlLnBlbmRpbmdjYi0tO1xuICAgICAgICBjYnNbaV0oZXJyKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIENsZWFyIGJ1ZmZlclxuICB9IGVsc2Uge1xuICAgIC8vIFNsb3cgY2FzZSwgd3JpdGUgY2h1bmtzIG9uZS1ieS1vbmVcbiAgICB3aGlsZSAoZW50cnkpIHtcbiAgICAgIHZhciBjaHVuayA9IGVudHJ5LmNodW5rO1xuICAgICAgdmFyIGVuY29kaW5nID0gZW50cnkuZW5jb2Rpbmc7XG4gICAgICB2YXIgY2IgPSBlbnRyeS5jYWxsYmFjaztcbiAgICAgIHZhciBsZW4gPSBzdGF0ZS5vYmplY3RNb2RlID8gMSA6IGNodW5rLmxlbmd0aDtcblxuICAgICAgZG9Xcml0ZShzdHJlYW0sIHN0YXRlLCBmYWxzZSwgbGVuLCBjaHVuaywgZW5jb2RpbmcsIGNiKTtcbiAgICAgIGVudHJ5ID0gZW50cnkubmV4dDtcbiAgICAgIC8vIGlmIHdlIGRpZG4ndCBjYWxsIHRoZSBvbndyaXRlIGltbWVkaWF0ZWx5LCB0aGVuXG4gICAgICAvLyBpdCBtZWFucyB0aGF0IHdlIG5lZWQgdG8gd2FpdCB1bnRpbCBpdCBkb2VzLlxuICAgICAgLy8gYWxzbywgdGhhdCBtZWFucyB0aGF0IHRoZSBjaHVuayBhbmQgY2IgYXJlIGN1cnJlbnRseVxuICAgICAgLy8gYmVpbmcgcHJvY2Vzc2VkLCBzbyBtb3ZlIHRoZSBidWZmZXIgY291bnRlciBwYXN0IHRoZW0uXG4gICAgICBpZiAoc3RhdGUud3JpdGluZykge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZW50cnkgPT09IG51bGwpXG4gICAgICBzdGF0ZS5sYXN0QnVmZmVyZWRSZXF1ZXN0ID0gbnVsbDtcbiAgfVxuICBzdGF0ZS5idWZmZXJlZFJlcXVlc3QgPSBlbnRyeTtcbiAgc3RhdGUuYnVmZmVyUHJvY2Vzc2luZyA9IGZhbHNlO1xufVxuXG5Xcml0YWJsZS5wcm90b3R5cGUuX3dyaXRlID0gZnVuY3Rpb24oY2h1bmssIGVuY29kaW5nLCBjYikge1xuICBjYihuZXcgRXJyb3IoJ25vdCBpbXBsZW1lbnRlZCcpKTtcbn07XG5cbldyaXRhYmxlLnByb3RvdHlwZS5fd3JpdGV2ID0gbnVsbDtcblxuV3JpdGFibGUucHJvdG90eXBlLmVuZCA9IGZ1bmN0aW9uKGNodW5rLCBlbmNvZGluZywgY2IpIHtcbiAgdmFyIHN0YXRlID0gdGhpcy5fd3JpdGFibGVTdGF0ZTtcblxuICBpZiAodHlwZW9mIGNodW5rID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2IgPSBjaHVuaztcbiAgICBjaHVuayA9IG51bGw7XG4gICAgZW5jb2RpbmcgPSBudWxsO1xuICB9IGVsc2UgaWYgKHR5cGVvZiBlbmNvZGluZyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNiID0gZW5jb2Rpbmc7XG4gICAgZW5jb2RpbmcgPSBudWxsO1xuICB9XG5cbiAgaWYgKGNodW5rICE9PSBudWxsICYmIGNodW5rICE9PSB1bmRlZmluZWQpXG4gICAgdGhpcy53cml0ZShjaHVuaywgZW5jb2RpbmcpO1xuXG4gIC8vIC5lbmQoKSBmdWxseSB1bmNvcmtzXG4gIGlmIChzdGF0ZS5jb3JrZWQpIHtcbiAgICBzdGF0ZS5jb3JrZWQgPSAxO1xuICAgIHRoaXMudW5jb3JrKCk7XG4gIH1cblxuICAvLyBpZ25vcmUgdW5uZWNlc3NhcnkgZW5kKCkgY2FsbHMuXG4gIGlmICghc3RhdGUuZW5kaW5nICYmICFzdGF0ZS5maW5pc2hlZClcbiAgICBlbmRXcml0YWJsZSh0aGlzLCBzdGF0ZSwgY2IpO1xufTtcblxuXG5mdW5jdGlvbiBuZWVkRmluaXNoKHN0YXRlKSB7XG4gIHJldHVybiAoc3RhdGUuZW5kaW5nICYmXG4gICAgICAgICAgc3RhdGUubGVuZ3RoID09PSAwICYmXG4gICAgICAgICAgc3RhdGUuYnVmZmVyZWRSZXF1ZXN0ID09PSBudWxsICYmXG4gICAgICAgICAgIXN0YXRlLmZpbmlzaGVkICYmXG4gICAgICAgICAgIXN0YXRlLndyaXRpbmcpO1xufVxuXG5mdW5jdGlvbiBwcmVmaW5pc2goc3RyZWFtLCBzdGF0ZSkge1xuICBpZiAoIXN0YXRlLnByZWZpbmlzaGVkKSB7XG4gICAgc3RhdGUucHJlZmluaXNoZWQgPSB0cnVlO1xuICAgIHN0cmVhbS5lbWl0KCdwcmVmaW5pc2gnKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaW5pc2hNYXliZShzdHJlYW0sIHN0YXRlKSB7XG4gIHZhciBuZWVkID0gbmVlZEZpbmlzaChzdGF0ZSk7XG4gIGlmIChuZWVkKSB7XG4gICAgaWYgKHN0YXRlLnBlbmRpbmdjYiA9PT0gMCkge1xuICAgICAgcHJlZmluaXNoKHN0cmVhbSwgc3RhdGUpO1xuICAgICAgc3RhdGUuZmluaXNoZWQgPSB0cnVlO1xuICAgICAgc3RyZWFtLmVtaXQoJ2ZpbmlzaCcpO1xuICAgIH0gZWxzZSB7XG4gICAgICBwcmVmaW5pc2goc3RyZWFtLCBzdGF0ZSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBuZWVkO1xufVxuXG5mdW5jdGlvbiBlbmRXcml0YWJsZShzdHJlYW0sIHN0YXRlLCBjYikge1xuICBzdGF0ZS5lbmRpbmcgPSB0cnVlO1xuICBmaW5pc2hNYXliZShzdHJlYW0sIHN0YXRlKTtcbiAgaWYgKGNiKSB7XG4gICAgaWYgKHN0YXRlLmZpbmlzaGVkKVxuICAgICAgcHJvY2Vzc05leHRUaWNrKGNiKTtcbiAgICBlbHNlXG4gICAgICBzdHJlYW0ub25jZSgnZmluaXNoJywgY2IpO1xuICB9XG4gIHN0YXRlLmVuZGVkID0gdHJ1ZTtcbn1cbiIsIi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG4vLyBOT1RFOiBUaGVzZSB0eXBlIGNoZWNraW5nIGZ1bmN0aW9ucyBpbnRlbnRpb25hbGx5IGRvbid0IHVzZSBgaW5zdGFuY2VvZmBcbi8vIGJlY2F1c2UgaXQgaXMgZnJhZ2lsZSBhbmQgY2FuIGJlIGVhc2lseSBmYWtlZCB3aXRoIGBPYmplY3QuY3JlYXRlKClgLlxuZnVuY3Rpb24gaXNBcnJheShhcikge1xuICByZXR1cm4gQXJyYXkuaXNBcnJheShhcik7XG59XG5leHBvcnRzLmlzQXJyYXkgPSBpc0FycmF5O1xuXG5mdW5jdGlvbiBpc0Jvb2xlYW4oYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnYm9vbGVhbic7XG59XG5leHBvcnRzLmlzQm9vbGVhbiA9IGlzQm9vbGVhbjtcblxuZnVuY3Rpb24gaXNOdWxsKGFyZykge1xuICByZXR1cm4gYXJnID09PSBudWxsO1xufVxuZXhwb3J0cy5pc051bGwgPSBpc051bGw7XG5cbmZ1bmN0aW9uIGlzTnVsbE9yVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gYXJnID09IG51bGw7XG59XG5leHBvcnRzLmlzTnVsbE9yVW5kZWZpbmVkID0gaXNOdWxsT3JVbmRlZmluZWQ7XG5cbmZ1bmN0aW9uIGlzTnVtYmVyKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ251bWJlcic7XG59XG5leHBvcnRzLmlzTnVtYmVyID0gaXNOdW1iZXI7XG5cbmZ1bmN0aW9uIGlzU3RyaW5nKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ3N0cmluZyc7XG59XG5leHBvcnRzLmlzU3RyaW5nID0gaXNTdHJpbmc7XG5cbmZ1bmN0aW9uIGlzU3ltYm9sKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ3N5bWJvbCc7XG59XG5leHBvcnRzLmlzU3ltYm9sID0gaXNTeW1ib2w7XG5cbmZ1bmN0aW9uIGlzVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gYXJnID09PSB2b2lkIDA7XG59XG5leHBvcnRzLmlzVW5kZWZpbmVkID0gaXNVbmRlZmluZWQ7XG5cbmZ1bmN0aW9uIGlzUmVnRXhwKHJlKSB7XG4gIHJldHVybiBpc09iamVjdChyZSkgJiYgb2JqZWN0VG9TdHJpbmcocmUpID09PSAnW29iamVjdCBSZWdFeHBdJztcbn1cbmV4cG9ydHMuaXNSZWdFeHAgPSBpc1JlZ0V4cDtcblxuZnVuY3Rpb24gaXNPYmplY3QoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBhcmcgIT09IG51bGw7XG59XG5leHBvcnRzLmlzT2JqZWN0ID0gaXNPYmplY3Q7XG5cbmZ1bmN0aW9uIGlzRGF0ZShkKSB7XG4gIHJldHVybiBpc09iamVjdChkKSAmJiBvYmplY3RUb1N0cmluZyhkKSA9PT0gJ1tvYmplY3QgRGF0ZV0nO1xufVxuZXhwb3J0cy5pc0RhdGUgPSBpc0RhdGU7XG5cbmZ1bmN0aW9uIGlzRXJyb3IoZSkge1xuICByZXR1cm4gaXNPYmplY3QoZSkgJiZcbiAgICAgIChvYmplY3RUb1N0cmluZyhlKSA9PT0gJ1tvYmplY3QgRXJyb3JdJyB8fCBlIGluc3RhbmNlb2YgRXJyb3IpO1xufVxuZXhwb3J0cy5pc0Vycm9yID0gaXNFcnJvcjtcblxuZnVuY3Rpb24gaXNGdW5jdGlvbihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdmdW5jdGlvbic7XG59XG5leHBvcnRzLmlzRnVuY3Rpb24gPSBpc0Z1bmN0aW9uO1xuXG5mdW5jdGlvbiBpc1ByaW1pdGl2ZShhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gbnVsbCB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ2Jvb2xlYW4nIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnbnVtYmVyJyB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ3N0cmluZycgfHxcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICdzeW1ib2wnIHx8ICAvLyBFUzYgc3ltYm9sXG4gICAgICAgICB0eXBlb2YgYXJnID09PSAndW5kZWZpbmVkJztcbn1cbmV4cG9ydHMuaXNQcmltaXRpdmUgPSBpc1ByaW1pdGl2ZTtcblxuZnVuY3Rpb24gaXNCdWZmZXIoYXJnKSB7XG4gIHJldHVybiBCdWZmZXIuaXNCdWZmZXIoYXJnKTtcbn1cbmV4cG9ydHMuaXNCdWZmZXIgPSBpc0J1ZmZlcjtcblxuZnVuY3Rpb24gb2JqZWN0VG9TdHJpbmcobykge1xuICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKG8pO1xufSIsIid1c2Ugc3RyaWN0Jztcbm1vZHVsZS5leHBvcnRzID0gbmV4dFRpY2s7XG5cbmZ1bmN0aW9uIG5leHRUaWNrKGZuKSB7XG4gIHZhciBhcmdzID0gbmV3IEFycmF5KGFyZ3VtZW50cy5sZW5ndGggLSAxKTtcbiAgdmFyIGkgPSAwO1xuICB3aGlsZSAoaSA8IGFyZ3MubGVuZ3RoKSB7XG4gICAgYXJnc1tpKytdID0gYXJndW1lbnRzW2ldO1xuICB9XG4gIHByb2Nlc3MubmV4dFRpY2soZnVuY3Rpb24gYWZ0ZXJUaWNrKCkge1xuICAgIGZuLmFwcGx5KG51bGwsIGFyZ3MpO1xuICB9KTtcbn1cbiIsIlxuLyoqXG4gKiBNb2R1bGUgZXhwb3J0cy5cbiAqL1xuXG5tb2R1bGUuZXhwb3J0cyA9IGRlcHJlY2F0ZTtcblxuLyoqXG4gKiBNYXJrIHRoYXQgYSBtZXRob2Qgc2hvdWxkIG5vdCBiZSB1c2VkLlxuICogUmV0dXJucyBhIG1vZGlmaWVkIGZ1bmN0aW9uIHdoaWNoIHdhcm5zIG9uY2UgYnkgZGVmYXVsdC5cbiAqXG4gKiBJZiBgbG9jYWxTdG9yYWdlLm5vRGVwcmVjYXRpb24gPSB0cnVlYCBpcyBzZXQsIHRoZW4gaXQgaXMgYSBuby1vcC5cbiAqXG4gKiBJZiBgbG9jYWxTdG9yYWdlLnRocm93RGVwcmVjYXRpb24gPSB0cnVlYCBpcyBzZXQsIHRoZW4gZGVwcmVjYXRlZCBmdW5jdGlvbnNcbiAqIHdpbGwgdGhyb3cgYW4gRXJyb3Igd2hlbiBpbnZva2VkLlxuICpcbiAqIElmIGBsb2NhbFN0b3JhZ2UudHJhY2VEZXByZWNhdGlvbiA9IHRydWVgIGlzIHNldCwgdGhlbiBkZXByZWNhdGVkIGZ1bmN0aW9uc1xuICogd2lsbCBpbnZva2UgYGNvbnNvbGUudHJhY2UoKWAgaW5zdGVhZCBvZiBgY29uc29sZS5lcnJvcigpYC5cbiAqXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmbiAtIHRoZSBmdW5jdGlvbiB0byBkZXByZWNhdGVcbiAqIEBwYXJhbSB7U3RyaW5nfSBtc2cgLSB0aGUgc3RyaW5nIHRvIHByaW50IHRvIHRoZSBjb25zb2xlIHdoZW4gYGZuYCBpcyBpbnZva2VkXG4gKiBAcmV0dXJucyB7RnVuY3Rpb259IGEgbmV3IFwiZGVwcmVjYXRlZFwiIHZlcnNpb24gb2YgYGZuYFxuICogQGFwaSBwdWJsaWNcbiAqL1xuXG5mdW5jdGlvbiBkZXByZWNhdGUgKGZuLCBtc2cpIHtcbiAgaWYgKGNvbmZpZygnbm9EZXByZWNhdGlvbicpKSB7XG4gICAgcmV0dXJuIGZuO1xuICB9XG5cbiAgdmFyIHdhcm5lZCA9IGZhbHNlO1xuICBmdW5jdGlvbiBkZXByZWNhdGVkKCkge1xuICAgIGlmICghd2FybmVkKSB7XG4gICAgICBpZiAoY29uZmlnKCd0aHJvd0RlcHJlY2F0aW9uJykpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1zZyk7XG4gICAgICB9IGVsc2UgaWYgKGNvbmZpZygndHJhY2VEZXByZWNhdGlvbicpKSB7XG4gICAgICAgIGNvbnNvbGUudHJhY2UobXNnKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnNvbGUud2Fybihtc2cpO1xuICAgICAgfVxuICAgICAgd2FybmVkID0gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gIH1cblxuICByZXR1cm4gZGVwcmVjYXRlZDtcbn1cblxuLyoqXG4gKiBDaGVja3MgYGxvY2FsU3RvcmFnZWAgZm9yIGJvb2xlYW4gdmFsdWVzIGZvciB0aGUgZ2l2ZW4gYG5hbWVgLlxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSBuYW1lXG4gKiBAcmV0dXJucyB7Qm9vbGVhbn1cbiAqIEBhcGkgcHJpdmF0ZVxuICovXG5cbmZ1bmN0aW9uIGNvbmZpZyAobmFtZSkge1xuICAvLyBhY2Nlc3NpbmcgZ2xvYmFsLmxvY2FsU3RvcmFnZSBjYW4gdHJpZ2dlciBhIERPTUV4Y2VwdGlvbiBpbiBzYW5kYm94ZWQgaWZyYW1lc1xuICB0cnkge1xuICAgIGlmICghZ2xvYmFsLmxvY2FsU3RvcmFnZSkgcmV0dXJuIGZhbHNlO1xuICB9IGNhdGNoIChfKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHZhciB2YWwgPSBnbG9iYWwubG9jYWxTdG9yYWdlW25hbWVdO1xuICBpZiAobnVsbCA9PSB2YWwpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIFN0cmluZyh2YWwpLnRvTG93ZXJDYXNlKCkgPT09ICd0cnVlJztcbn1cbiIsIm1vZHVsZS5leHBvcnRzID0gcmVxdWlyZShcIi4vbGliL19zdHJlYW1fcGFzc3Rocm91Z2guanNcIilcbiIsInZhciBTdHJlYW0gPSAoZnVuY3Rpb24gKCl7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlcXVpcmUoJ3N0JyArICdyZWFtJyk7IC8vIGhhY2sgdG8gZml4IGEgY2lyY3VsYXIgZGVwZW5kZW5jeSBpc3N1ZSB3aGVuIHVzZWQgd2l0aCBicm93c2VyaWZ5XG4gIH0gY2F0Y2goXyl7fVxufSgpKTtcbmV4cG9ydHMgPSBtb2R1bGUuZXhwb3J0cyA9IHJlcXVpcmUoJy4vbGliL19zdHJlYW1fcmVhZGFibGUuanMnKTtcbmV4cG9ydHMuU3RyZWFtID0gU3RyZWFtIHx8IGV4cG9ydHM7XG5leHBvcnRzLlJlYWRhYmxlID0gZXhwb3J0cztcbmV4cG9ydHMuV3JpdGFibGUgPSByZXF1aXJlKCcuL2xpYi9fc3RyZWFtX3dyaXRhYmxlLmpzJyk7XG5leHBvcnRzLkR1cGxleCA9IHJlcXVpcmUoJy4vbGliL19zdHJlYW1fZHVwbGV4LmpzJyk7XG5leHBvcnRzLlRyYW5zZm9ybSA9IHJlcXVpcmUoJy4vbGliL19zdHJlYW1fdHJhbnNmb3JtLmpzJyk7XG5leHBvcnRzLlBhc3NUaHJvdWdoID0gcmVxdWlyZSgnLi9saWIvX3N0cmVhbV9wYXNzdGhyb3VnaC5qcycpO1xuIiwibW9kdWxlLmV4cG9ydHMgPSByZXF1aXJlKFwiLi9saWIvX3N0cmVhbV90cmFuc2Zvcm0uanNcIilcbiIsIm1vZHVsZS5leHBvcnRzID0gcmVxdWlyZShcIi4vbGliL19zdHJlYW1fd3JpdGFibGUuanNcIilcbiIsIi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG5tb2R1bGUuZXhwb3J0cyA9IFN0cmVhbTtcblxudmFyIEVFID0gcmVxdWlyZSgnZXZlbnRzJykuRXZlbnRFbWl0dGVyO1xudmFyIGluaGVyaXRzID0gcmVxdWlyZSgnaW5oZXJpdHMnKTtcblxuaW5oZXJpdHMoU3RyZWFtLCBFRSk7XG5TdHJlYW0uUmVhZGFibGUgPSByZXF1aXJlKCdyZWFkYWJsZS1zdHJlYW0vcmVhZGFibGUuanMnKTtcblN0cmVhbS5Xcml0YWJsZSA9IHJlcXVpcmUoJ3JlYWRhYmxlLXN0cmVhbS93cml0YWJsZS5qcycpO1xuU3RyZWFtLkR1cGxleCA9IHJlcXVpcmUoJ3JlYWRhYmxlLXN0cmVhbS9kdXBsZXguanMnKTtcblN0cmVhbS5UcmFuc2Zvcm0gPSByZXF1aXJlKCdyZWFkYWJsZS1zdHJlYW0vdHJhbnNmb3JtLmpzJyk7XG5TdHJlYW0uUGFzc1Rocm91Z2ggPSByZXF1aXJlKCdyZWFkYWJsZS1zdHJlYW0vcGFzc3Rocm91Z2guanMnKTtcblxuLy8gQmFja3dhcmRzLWNvbXBhdCB3aXRoIG5vZGUgMC40LnhcblN0cmVhbS5TdHJlYW0gPSBTdHJlYW07XG5cblxuXG4vLyBvbGQtc3R5bGUgc3RyZWFtcy4gIE5vdGUgdGhhdCB0aGUgcGlwZSBtZXRob2QgKHRoZSBvbmx5IHJlbGV2YW50XG4vLyBwYXJ0IG9mIHRoaXMgY2xhc3MpIGlzIG92ZXJyaWRkZW4gaW4gdGhlIFJlYWRhYmxlIGNsYXNzLlxuXG5mdW5jdGlvbiBTdHJlYW0oKSB7XG4gIEVFLmNhbGwodGhpcyk7XG59XG5cblN0cmVhbS5wcm90b3R5cGUucGlwZSA9IGZ1bmN0aW9uKGRlc3QsIG9wdGlvbnMpIHtcbiAgdmFyIHNvdXJjZSA9IHRoaXM7XG5cbiAgZnVuY3Rpb24gb25kYXRhKGNodW5rKSB7XG4gICAgaWYgKGRlc3Qud3JpdGFibGUpIHtcbiAgICAgIGlmIChmYWxzZSA9PT0gZGVzdC53cml0ZShjaHVuaykgJiYgc291cmNlLnBhdXNlKSB7XG4gICAgICAgIHNvdXJjZS5wYXVzZSgpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHNvdXJjZS5vbignZGF0YScsIG9uZGF0YSk7XG5cbiAgZnVuY3Rpb24gb25kcmFpbigpIHtcbiAgICBpZiAoc291cmNlLnJlYWRhYmxlICYmIHNvdXJjZS5yZXN1bWUpIHtcbiAgICAgIHNvdXJjZS5yZXN1bWUoKTtcbiAgICB9XG4gIH1cblxuICBkZXN0Lm9uKCdkcmFpbicsIG9uZHJhaW4pO1xuXG4gIC8vIElmIHRoZSAnZW5kJyBvcHRpb24gaXMgbm90IHN1cHBsaWVkLCBkZXN0LmVuZCgpIHdpbGwgYmUgY2FsbGVkIHdoZW5cbiAgLy8gc291cmNlIGdldHMgdGhlICdlbmQnIG9yICdjbG9zZScgZXZlbnRzLiAgT25seSBkZXN0LmVuZCgpIG9uY2UuXG4gIGlmICghZGVzdC5faXNTdGRpbyAmJiAoIW9wdGlvbnMgfHwgb3B0aW9ucy5lbmQgIT09IGZhbHNlKSkge1xuICAgIHNvdXJjZS5vbignZW5kJywgb25lbmQpO1xuICAgIHNvdXJjZS5vbignY2xvc2UnLCBvbmNsb3NlKTtcbiAgfVxuXG4gIHZhciBkaWRPbkVuZCA9IGZhbHNlO1xuICBmdW5jdGlvbiBvbmVuZCgpIHtcbiAgICBpZiAoZGlkT25FbmQpIHJldHVybjtcbiAgICBkaWRPbkVuZCA9IHRydWU7XG5cbiAgICBkZXN0LmVuZCgpO1xuICB9XG5cblxuICBmdW5jdGlvbiBvbmNsb3NlKCkge1xuICAgIGlmIChkaWRPbkVuZCkgcmV0dXJuO1xuICAgIGRpZE9uRW5kID0gdHJ1ZTtcblxuICAgIGlmICh0eXBlb2YgZGVzdC5kZXN0cm95ID09PSAnZnVuY3Rpb24nKSBkZXN0LmRlc3Ryb3koKTtcbiAgfVxuXG4gIC8vIGRvbid0IGxlYXZlIGRhbmdsaW5nIHBpcGVzIHdoZW4gdGhlcmUgYXJlIGVycm9ycy5cbiAgZnVuY3Rpb24gb25lcnJvcihlcikge1xuICAgIGNsZWFudXAoKTtcbiAgICBpZiAoRUUubGlzdGVuZXJDb3VudCh0aGlzLCAnZXJyb3InKSA9PT0gMCkge1xuICAgICAgdGhyb3cgZXI7IC8vIFVuaGFuZGxlZCBzdHJlYW0gZXJyb3IgaW4gcGlwZS5cbiAgICB9XG4gIH1cblxuICBzb3VyY2Uub24oJ2Vycm9yJywgb25lcnJvcik7XG4gIGRlc3Qub24oJ2Vycm9yJywgb25lcnJvcik7XG5cbiAgLy8gcmVtb3ZlIGFsbCB0aGUgZXZlbnQgbGlzdGVuZXJzIHRoYXQgd2VyZSBhZGRlZC5cbiAgZnVuY3Rpb24gY2xlYW51cCgpIHtcbiAgICBzb3VyY2UucmVtb3ZlTGlzdGVuZXIoJ2RhdGEnLCBvbmRhdGEpO1xuICAgIGRlc3QucmVtb3ZlTGlzdGVuZXIoJ2RyYWluJywgb25kcmFpbik7XG5cbiAgICBzb3VyY2UucmVtb3ZlTGlzdGVuZXIoJ2VuZCcsIG9uZW5kKTtcbiAgICBzb3VyY2UucmVtb3ZlTGlzdGVuZXIoJ2Nsb3NlJywgb25jbG9zZSk7XG5cbiAgICBzb3VyY2UucmVtb3ZlTGlzdGVuZXIoJ2Vycm9yJywgb25lcnJvcik7XG4gICAgZGVzdC5yZW1vdmVMaXN0ZW5lcignZXJyb3InLCBvbmVycm9yKTtcblxuICAgIHNvdXJjZS5yZW1vdmVMaXN0ZW5lcignZW5kJywgY2xlYW51cCk7XG4gICAgc291cmNlLnJlbW92ZUxpc3RlbmVyKCdjbG9zZScsIGNsZWFudXApO1xuXG4gICAgZGVzdC5yZW1vdmVMaXN0ZW5lcignY2xvc2UnLCBjbGVhbnVwKTtcbiAgfVxuXG4gIHNvdXJjZS5vbignZW5kJywgY2xlYW51cCk7XG4gIHNvdXJjZS5vbignY2xvc2UnLCBjbGVhbnVwKTtcblxuICBkZXN0Lm9uKCdjbG9zZScsIGNsZWFudXApO1xuXG4gIGRlc3QuZW1pdCgncGlwZScsIHNvdXJjZSk7XG5cbiAgLy8gQWxsb3cgZm9yIHVuaXgtbGlrZSB1c2FnZTogQS5waXBlKEIpLnBpcGUoQylcbiAgcmV0dXJuIGRlc3Q7XG59O1xuIiwiLy8gQ29weXJpZ2h0IEpveWVudCwgSW5jLiBhbmQgb3RoZXIgTm9kZSBjb250cmlidXRvcnMuXG4vL1xuLy8gUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGFcbi8vIGNvcHkgb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGVcbi8vIFwiU29mdHdhcmVcIiksIHRvIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZ1xuLy8gd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLFxuLy8gZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdFxuLy8gcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlXG4vLyBmb2xsb3dpbmcgY29uZGl0aW9uczpcbi8vXG4vLyBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZFxuLy8gaW4gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4vL1xuLy8gVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTU1xuLy8gT1IgSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRlxuLy8gTUVSQ0hBTlRBQklMSVRZLCBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTlxuLy8gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sXG4vLyBEQU1BR0VTIE9SIE9USEVSIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1Jcbi8vIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLCBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEVcbi8vIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuXG5cbnZhciBCdWZmZXIgPSByZXF1aXJlKCdidWZmZXInKS5CdWZmZXI7XG5cbnZhciBpc0J1ZmZlckVuY29kaW5nID0gQnVmZmVyLmlzRW5jb2RpbmdcbiAgfHwgZnVuY3Rpb24oZW5jb2RpbmcpIHtcbiAgICAgICBzd2l0Y2ggKGVuY29kaW5nICYmIGVuY29kaW5nLnRvTG93ZXJDYXNlKCkpIHtcbiAgICAgICAgIGNhc2UgJ2hleCc6IGNhc2UgJ3V0ZjgnOiBjYXNlICd1dGYtOCc6IGNhc2UgJ2FzY2lpJzogY2FzZSAnYmluYXJ5JzogY2FzZSAnYmFzZTY0JzogY2FzZSAndWNzMic6IGNhc2UgJ3Vjcy0yJzogY2FzZSAndXRmMTZsZSc6IGNhc2UgJ3V0Zi0xNmxlJzogY2FzZSAncmF3JzogcmV0dXJuIHRydWU7XG4gICAgICAgICBkZWZhdWx0OiByZXR1cm4gZmFsc2U7XG4gICAgICAgfVxuICAgICB9XG5cblxuZnVuY3Rpb24gYXNzZXJ0RW5jb2RpbmcoZW5jb2RpbmcpIHtcbiAgaWYgKGVuY29kaW5nICYmICFpc0J1ZmZlckVuY29kaW5nKGVuY29kaW5nKSkge1xuICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBlbmNvZGluZzogJyArIGVuY29kaW5nKTtcbiAgfVxufVxuXG4vLyBTdHJpbmdEZWNvZGVyIHByb3ZpZGVzIGFuIGludGVyZmFjZSBmb3IgZWZmaWNpZW50bHkgc3BsaXR0aW5nIGEgc2VyaWVzIG9mXG4vLyBidWZmZXJzIGludG8gYSBzZXJpZXMgb2YgSlMgc3RyaW5ncyB3aXRob3V0IGJyZWFraW5nIGFwYXJ0IG11bHRpLWJ5dGVcbi8vIGNoYXJhY3RlcnMuIENFU1UtOCBpcyBoYW5kbGVkIGFzIHBhcnQgb2YgdGhlIFVURi04IGVuY29kaW5nLlxuLy9cbi8vIEBUT0RPIEhhbmRsaW5nIGFsbCBlbmNvZGluZ3MgaW5zaWRlIGEgc2luZ2xlIG9iamVjdCBtYWtlcyBpdCB2ZXJ5IGRpZmZpY3VsdFxuLy8gdG8gcmVhc29uIGFib3V0IHRoaXMgY29kZSwgc28gaXQgc2hvdWxkIGJlIHNwbGl0IHVwIGluIHRoZSBmdXR1cmUuXG4vLyBAVE9ETyBUaGVyZSBzaG91bGQgYmUgYSB1dGY4LXN0cmljdCBlbmNvZGluZyB0aGF0IHJlamVjdHMgaW52YWxpZCBVVEYtOCBjb2RlXG4vLyBwb2ludHMgYXMgdXNlZCBieSBDRVNVLTguXG52YXIgU3RyaW5nRGVjb2RlciA9IGV4cG9ydHMuU3RyaW5nRGVjb2RlciA9IGZ1bmN0aW9uKGVuY29kaW5nKSB7XG4gIHRoaXMuZW5jb2RpbmcgPSAoZW5jb2RpbmcgfHwgJ3V0ZjgnKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1stX10vLCAnJyk7XG4gIGFzc2VydEVuY29kaW5nKGVuY29kaW5nKTtcbiAgc3dpdGNoICh0aGlzLmVuY29kaW5nKSB7XG4gICAgY2FzZSAndXRmOCc6XG4gICAgICAvLyBDRVNVLTggcmVwcmVzZW50cyBlYWNoIG9mIFN1cnJvZ2F0ZSBQYWlyIGJ5IDMtYnl0ZXNcbiAgICAgIHRoaXMuc3Vycm9nYXRlU2l6ZSA9IDM7XG4gICAgICBicmVhaztcbiAgICBjYXNlICd1Y3MyJzpcbiAgICBjYXNlICd1dGYxNmxlJzpcbiAgICAgIC8vIFVURi0xNiByZXByZXNlbnRzIGVhY2ggb2YgU3Vycm9nYXRlIFBhaXIgYnkgMi1ieXRlc1xuICAgICAgdGhpcy5zdXJyb2dhdGVTaXplID0gMjtcbiAgICAgIHRoaXMuZGV0ZWN0SW5jb21wbGV0ZUNoYXIgPSB1dGYxNkRldGVjdEluY29tcGxldGVDaGFyO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAnYmFzZTY0JzpcbiAgICAgIC8vIEJhc2UtNjQgc3RvcmVzIDMgYnl0ZXMgaW4gNCBjaGFycywgYW5kIHBhZHMgdGhlIHJlbWFpbmRlci5cbiAgICAgIHRoaXMuc3Vycm9nYXRlU2l6ZSA9IDM7XG4gICAgICB0aGlzLmRldGVjdEluY29tcGxldGVDaGFyID0gYmFzZTY0RGV0ZWN0SW5jb21wbGV0ZUNoYXI7XG4gICAgICBicmVhaztcbiAgICBkZWZhdWx0OlxuICAgICAgdGhpcy53cml0ZSA9IHBhc3NUaHJvdWdoV3JpdGU7XG4gICAgICByZXR1cm47XG4gIH1cblxuICAvLyBFbm91Z2ggc3BhY2UgdG8gc3RvcmUgYWxsIGJ5dGVzIG9mIGEgc2luZ2xlIGNoYXJhY3Rlci4gVVRGLTggbmVlZHMgNFxuICAvLyBieXRlcywgYnV0IENFU1UtOCBtYXkgcmVxdWlyZSB1cCB0byA2ICgzIGJ5dGVzIHBlciBzdXJyb2dhdGUpLlxuICB0aGlzLmNoYXJCdWZmZXIgPSBuZXcgQnVmZmVyKDYpO1xuICAvLyBOdW1iZXIgb2YgYnl0ZXMgcmVjZWl2ZWQgZm9yIHRoZSBjdXJyZW50IGluY29tcGxldGUgbXVsdGktYnl0ZSBjaGFyYWN0ZXIuXG4gIHRoaXMuY2hhclJlY2VpdmVkID0gMDtcbiAgLy8gTnVtYmVyIG9mIGJ5dGVzIGV4cGVjdGVkIGZvciB0aGUgY3VycmVudCBpbmNvbXBsZXRlIG11bHRpLWJ5dGUgY2hhcmFjdGVyLlxuICB0aGlzLmNoYXJMZW5ndGggPSAwO1xufTtcblxuXG4vLyB3cml0ZSBkZWNvZGVzIHRoZSBnaXZlbiBidWZmZXIgYW5kIHJldHVybnMgaXQgYXMgSlMgc3RyaW5nIHRoYXQgaXNcbi8vIGd1YXJhbnRlZWQgdG8gbm90IGNvbnRhaW4gYW55IHBhcnRpYWwgbXVsdGktYnl0ZSBjaGFyYWN0ZXJzLiBBbnkgcGFydGlhbFxuLy8gY2hhcmFjdGVyIGZvdW5kIGF0IHRoZSBlbmQgb2YgdGhlIGJ1ZmZlciBpcyBidWZmZXJlZCB1cCwgYW5kIHdpbGwgYmVcbi8vIHJldHVybmVkIHdoZW4gY2FsbGluZyB3cml0ZSBhZ2FpbiB3aXRoIHRoZSByZW1haW5pbmcgYnl0ZXMuXG4vL1xuLy8gTm90ZTogQ29udmVydGluZyBhIEJ1ZmZlciBjb250YWluaW5nIGFuIG9ycGhhbiBzdXJyb2dhdGUgdG8gYSBTdHJpbmdcbi8vIGN1cnJlbnRseSB3b3JrcywgYnV0IGNvbnZlcnRpbmcgYSBTdHJpbmcgdG8gYSBCdWZmZXIgKHZpYSBgbmV3IEJ1ZmZlcmAsIG9yXG4vLyBCdWZmZXIjd3JpdGUpIHdpbGwgcmVwbGFjZSBpbmNvbXBsZXRlIHN1cnJvZ2F0ZXMgd2l0aCB0aGUgdW5pY29kZVxuLy8gcmVwbGFjZW1lbnQgY2hhcmFjdGVyLiBTZWUgaHR0cHM6Ly9jb2RlcmV2aWV3LmNocm9taXVtLm9yZy8xMjExNzMwMDkvIC5cblN0cmluZ0RlY29kZXIucHJvdG90eXBlLndyaXRlID0gZnVuY3Rpb24oYnVmZmVyKSB7XG4gIHZhciBjaGFyU3RyID0gJyc7XG4gIC8vIGlmIG91ciBsYXN0IHdyaXRlIGVuZGVkIHdpdGggYW4gaW5jb21wbGV0ZSBtdWx0aWJ5dGUgY2hhcmFjdGVyXG4gIHdoaWxlICh0aGlzLmNoYXJMZW5ndGgpIHtcbiAgICAvLyBkZXRlcm1pbmUgaG93IG1hbnkgcmVtYWluaW5nIGJ5dGVzIHRoaXMgYnVmZmVyIGhhcyB0byBvZmZlciBmb3IgdGhpcyBjaGFyXG4gICAgdmFyIGF2YWlsYWJsZSA9IChidWZmZXIubGVuZ3RoID49IHRoaXMuY2hhckxlbmd0aCAtIHRoaXMuY2hhclJlY2VpdmVkKSA/XG4gICAgICAgIHRoaXMuY2hhckxlbmd0aCAtIHRoaXMuY2hhclJlY2VpdmVkIDpcbiAgICAgICAgYnVmZmVyLmxlbmd0aDtcblxuICAgIC8vIGFkZCB0aGUgbmV3IGJ5dGVzIHRvIHRoZSBjaGFyIGJ1ZmZlclxuICAgIGJ1ZmZlci5jb3B5KHRoaXMuY2hhckJ1ZmZlciwgdGhpcy5jaGFyUmVjZWl2ZWQsIDAsIGF2YWlsYWJsZSk7XG4gICAgdGhpcy5jaGFyUmVjZWl2ZWQgKz0gYXZhaWxhYmxlO1xuXG4gICAgaWYgKHRoaXMuY2hhclJlY2VpdmVkIDwgdGhpcy5jaGFyTGVuZ3RoKSB7XG4gICAgICAvLyBzdGlsbCBub3QgZW5vdWdoIGNoYXJzIGluIHRoaXMgYnVmZmVyPyB3YWl0IGZvciBtb3JlIC4uLlxuICAgICAgcmV0dXJuICcnO1xuICAgIH1cblxuICAgIC8vIHJlbW92ZSBieXRlcyBiZWxvbmdpbmcgdG8gdGhlIGN1cnJlbnQgY2hhcmFjdGVyIGZyb20gdGhlIGJ1ZmZlclxuICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShhdmFpbGFibGUsIGJ1ZmZlci5sZW5ndGgpO1xuXG4gICAgLy8gZ2V0IHRoZSBjaGFyYWN0ZXIgdGhhdCB3YXMgc3BsaXRcbiAgICBjaGFyU3RyID0gdGhpcy5jaGFyQnVmZmVyLnNsaWNlKDAsIHRoaXMuY2hhckxlbmd0aCkudG9TdHJpbmcodGhpcy5lbmNvZGluZyk7XG5cbiAgICAvLyBDRVNVLTg6IGxlYWQgc3Vycm9nYXRlIChEODAwLURCRkYpIGlzIGFsc28gdGhlIGluY29tcGxldGUgY2hhcmFjdGVyXG4gICAgdmFyIGNoYXJDb2RlID0gY2hhclN0ci5jaGFyQ29kZUF0KGNoYXJTdHIubGVuZ3RoIC0gMSk7XG4gICAgaWYgKGNoYXJDb2RlID49IDB4RDgwMCAmJiBjaGFyQ29kZSA8PSAweERCRkYpIHtcbiAgICAgIHRoaXMuY2hhckxlbmd0aCArPSB0aGlzLnN1cnJvZ2F0ZVNpemU7XG4gICAgICBjaGFyU3RyID0gJyc7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgdGhpcy5jaGFyUmVjZWl2ZWQgPSB0aGlzLmNoYXJMZW5ndGggPSAwO1xuXG4gICAgLy8gaWYgdGhlcmUgYXJlIG5vIG1vcmUgYnl0ZXMgaW4gdGhpcyBidWZmZXIsIGp1c3QgZW1pdCBvdXIgY2hhclxuICAgIGlmIChidWZmZXIubGVuZ3RoID09PSAwKSB7XG4gICAgICByZXR1cm4gY2hhclN0cjtcbiAgICB9XG4gICAgYnJlYWs7XG4gIH1cblxuICAvLyBkZXRlcm1pbmUgYW5kIHNldCBjaGFyTGVuZ3RoIC8gY2hhclJlY2VpdmVkXG4gIHRoaXMuZGV0ZWN0SW5jb21wbGV0ZUNoYXIoYnVmZmVyKTtcblxuICB2YXIgZW5kID0gYnVmZmVyLmxlbmd0aDtcbiAgaWYgKHRoaXMuY2hhckxlbmd0aCkge1xuICAgIC8vIGJ1ZmZlciB0aGUgaW5jb21wbGV0ZSBjaGFyYWN0ZXIgYnl0ZXMgd2UgZ290XG4gICAgYnVmZmVyLmNvcHkodGhpcy5jaGFyQnVmZmVyLCAwLCBidWZmZXIubGVuZ3RoIC0gdGhpcy5jaGFyUmVjZWl2ZWQsIGVuZCk7XG4gICAgZW5kIC09IHRoaXMuY2hhclJlY2VpdmVkO1xuICB9XG5cbiAgY2hhclN0ciArPSBidWZmZXIudG9TdHJpbmcodGhpcy5lbmNvZGluZywgMCwgZW5kKTtcblxuICB2YXIgZW5kID0gY2hhclN0ci5sZW5ndGggLSAxO1xuICB2YXIgY2hhckNvZGUgPSBjaGFyU3RyLmNoYXJDb2RlQXQoZW5kKTtcbiAgLy8gQ0VTVS04OiBsZWFkIHN1cnJvZ2F0ZSAoRDgwMC1EQkZGKSBpcyBhbHNvIHRoZSBpbmNvbXBsZXRlIGNoYXJhY3RlclxuICBpZiAoY2hhckNvZGUgPj0gMHhEODAwICYmIGNoYXJDb2RlIDw9IDB4REJGRikge1xuICAgIHZhciBzaXplID0gdGhpcy5zdXJyb2dhdGVTaXplO1xuICAgIHRoaXMuY2hhckxlbmd0aCArPSBzaXplO1xuICAgIHRoaXMuY2hhclJlY2VpdmVkICs9IHNpemU7XG4gICAgdGhpcy5jaGFyQnVmZmVyLmNvcHkodGhpcy5jaGFyQnVmZmVyLCBzaXplLCAwLCBzaXplKTtcbiAgICBidWZmZXIuY29weSh0aGlzLmNoYXJCdWZmZXIsIDAsIDAsIHNpemUpO1xuICAgIHJldHVybiBjaGFyU3RyLnN1YnN0cmluZygwLCBlbmQpO1xuICB9XG5cbiAgLy8gb3IganVzdCBlbWl0IHRoZSBjaGFyU3RyXG4gIHJldHVybiBjaGFyU3RyO1xufTtcblxuLy8gZGV0ZWN0SW5jb21wbGV0ZUNoYXIgZGV0ZXJtaW5lcyBpZiB0aGVyZSBpcyBhbiBpbmNvbXBsZXRlIFVURi04IGNoYXJhY3RlciBhdFxuLy8gdGhlIGVuZCBvZiB0aGUgZ2l2ZW4gYnVmZmVyLiBJZiBzbywgaXQgc2V0cyB0aGlzLmNoYXJMZW5ndGggdG8gdGhlIGJ5dGVcbi8vIGxlbmd0aCB0aGF0IGNoYXJhY3RlciwgYW5kIHNldHMgdGhpcy5jaGFyUmVjZWl2ZWQgdG8gdGhlIG51bWJlciBvZiBieXRlc1xuLy8gdGhhdCBhcmUgYXZhaWxhYmxlIGZvciB0aGlzIGNoYXJhY3Rlci5cblN0cmluZ0RlY29kZXIucHJvdG90eXBlLmRldGVjdEluY29tcGxldGVDaGFyID0gZnVuY3Rpb24oYnVmZmVyKSB7XG4gIC8vIGRldGVybWluZSBob3cgbWFueSBieXRlcyB3ZSBoYXZlIHRvIGNoZWNrIGF0IHRoZSBlbmQgb2YgdGhpcyBidWZmZXJcbiAgdmFyIGkgPSAoYnVmZmVyLmxlbmd0aCA+PSAzKSA/IDMgOiBidWZmZXIubGVuZ3RoO1xuXG4gIC8vIEZpZ3VyZSBvdXQgaWYgb25lIG9mIHRoZSBsYXN0IGkgYnl0ZXMgb2Ygb3VyIGJ1ZmZlciBhbm5vdW5jZXMgYW5cbiAgLy8gaW5jb21wbGV0ZSBjaGFyLlxuICBmb3IgKDsgaSA+IDA7IGktLSkge1xuICAgIHZhciBjID0gYnVmZmVyW2J1ZmZlci5sZW5ndGggLSBpXTtcblxuICAgIC8vIFNlZSBodHRwOi8vZW4ud2lraXBlZGlhLm9yZy93aWtpL1VURi04I0Rlc2NyaXB0aW9uXG5cbiAgICAvLyAxMTBYWFhYWFxuICAgIGlmIChpID09IDEgJiYgYyA+PiA1ID09IDB4MDYpIHtcbiAgICAgIHRoaXMuY2hhckxlbmd0aCA9IDI7XG4gICAgICBicmVhaztcbiAgICB9XG5cbiAgICAvLyAxMTEwWFhYWFxuICAgIGlmIChpIDw9IDIgJiYgYyA+PiA0ID09IDB4MEUpIHtcbiAgICAgIHRoaXMuY2hhckxlbmd0aCA9IDM7XG4gICAgICBicmVhaztcbiAgICB9XG5cbiAgICAvLyAxMTExMFhYWFxuICAgIGlmIChpIDw9IDMgJiYgYyA+PiAzID09IDB4MUUpIHtcbiAgICAgIHRoaXMuY2hhckxlbmd0aCA9IDQ7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cbiAgdGhpcy5jaGFyUmVjZWl2ZWQgPSBpO1xufTtcblxuU3RyaW5nRGVjb2Rlci5wcm90b3R5cGUuZW5kID0gZnVuY3Rpb24oYnVmZmVyKSB7XG4gIHZhciByZXMgPSAnJztcbiAgaWYgKGJ1ZmZlciAmJiBidWZmZXIubGVuZ3RoKVxuICAgIHJlcyA9IHRoaXMud3JpdGUoYnVmZmVyKTtcblxuICBpZiAodGhpcy5jaGFyUmVjZWl2ZWQpIHtcbiAgICB2YXIgY3IgPSB0aGlzLmNoYXJSZWNlaXZlZDtcbiAgICB2YXIgYnVmID0gdGhpcy5jaGFyQnVmZmVyO1xuICAgIHZhciBlbmMgPSB0aGlzLmVuY29kaW5nO1xuICAgIHJlcyArPSBidWYuc2xpY2UoMCwgY3IpLnRvU3RyaW5nKGVuYyk7XG4gIH1cblxuICByZXR1cm4gcmVzO1xufTtcblxuZnVuY3Rpb24gcGFzc1Rocm91Z2hXcml0ZShidWZmZXIpIHtcbiAgcmV0dXJuIGJ1ZmZlci50b1N0cmluZyh0aGlzLmVuY29kaW5nKTtcbn1cblxuZnVuY3Rpb24gdXRmMTZEZXRlY3RJbmNvbXBsZXRlQ2hhcihidWZmZXIpIHtcbiAgdGhpcy5jaGFyUmVjZWl2ZWQgPSBidWZmZXIubGVuZ3RoICUgMjtcbiAgdGhpcy5jaGFyTGVuZ3RoID0gdGhpcy5jaGFyUmVjZWl2ZWQgPyAyIDogMDtcbn1cblxuZnVuY3Rpb24gYmFzZTY0RGV0ZWN0SW5jb21wbGV0ZUNoYXIoYnVmZmVyKSB7XG4gIHRoaXMuY2hhclJlY2VpdmVkID0gYnVmZmVyLmxlbmd0aCAlIDM7XG4gIHRoaXMuY2hhckxlbmd0aCA9IHRoaXMuY2hhclJlY2VpdmVkID8gMyA6IDA7XG59XG4iLCJtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIGlzQnVmZmVyKGFyZykge1xuICByZXR1cm4gYXJnICYmIHR5cGVvZiBhcmcgPT09ICdvYmplY3QnXG4gICAgJiYgdHlwZW9mIGFyZy5jb3B5ID09PSAnZnVuY3Rpb24nXG4gICAgJiYgdHlwZW9mIGFyZy5maWxsID09PSAnZnVuY3Rpb24nXG4gICAgJiYgdHlwZW9mIGFyZy5yZWFkVUludDggPT09ICdmdW5jdGlvbic7XG59IiwiLy8gQ29weXJpZ2h0IEpveWVudCwgSW5jLiBhbmQgb3RoZXIgTm9kZSBjb250cmlidXRvcnMuXG4vL1xuLy8gUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGFcbi8vIGNvcHkgb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGVcbi8vIFwiU29mdHdhcmVcIiksIHRvIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZ1xuLy8gd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLFxuLy8gZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdFxuLy8gcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlXG4vLyBmb2xsb3dpbmcgY29uZGl0aW9uczpcbi8vXG4vLyBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZFxuLy8gaW4gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4vL1xuLy8gVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTU1xuLy8gT1IgSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRlxuLy8gTUVSQ0hBTlRBQklMSVRZLCBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTlxuLy8gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sXG4vLyBEQU1BR0VTIE9SIE9USEVSIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1Jcbi8vIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLCBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEVcbi8vIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuXG5cbnZhciBmb3JtYXRSZWdFeHAgPSAvJVtzZGolXS9nO1xuZXhwb3J0cy5mb3JtYXQgPSBmdW5jdGlvbihmKSB7XG4gIGlmICghaXNTdHJpbmcoZikpIHtcbiAgICB2YXIgb2JqZWN0cyA9IFtdO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBvYmplY3RzLnB1c2goaW5zcGVjdChhcmd1bWVudHNbaV0pKTtcbiAgICB9XG4gICAgcmV0dXJuIG9iamVjdHMuam9pbignICcpO1xuICB9XG5cbiAgdmFyIGkgPSAxO1xuICB2YXIgYXJncyA9IGFyZ3VtZW50cztcbiAgdmFyIGxlbiA9IGFyZ3MubGVuZ3RoO1xuICB2YXIgc3RyID0gU3RyaW5nKGYpLnJlcGxhY2UoZm9ybWF0UmVnRXhwLCBmdW5jdGlvbih4KSB7XG4gICAgaWYgKHggPT09ICclJScpIHJldHVybiAnJSc7XG4gICAgaWYgKGkgPj0gbGVuKSByZXR1cm4geDtcbiAgICBzd2l0Y2ggKHgpIHtcbiAgICAgIGNhc2UgJyVzJzogcmV0dXJuIFN0cmluZyhhcmdzW2krK10pO1xuICAgICAgY2FzZSAnJWQnOiByZXR1cm4gTnVtYmVyKGFyZ3NbaSsrXSk7XG4gICAgICBjYXNlICclaic6XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGFyZ3NbaSsrXSk7XG4gICAgICAgIH0gY2F0Y2ggKF8pIHtcbiAgICAgICAgICByZXR1cm4gJ1tDaXJjdWxhcl0nO1xuICAgICAgICB9XG4gICAgICBkZWZhdWx0OlxuICAgICAgICByZXR1cm4geDtcbiAgICB9XG4gIH0pO1xuICBmb3IgKHZhciB4ID0gYXJnc1tpXTsgaSA8IGxlbjsgeCA9IGFyZ3NbKytpXSkge1xuICAgIGlmIChpc051bGwoeCkgfHwgIWlzT2JqZWN0KHgpKSB7XG4gICAgICBzdHIgKz0gJyAnICsgeDtcbiAgICB9IGVsc2Uge1xuICAgICAgc3RyICs9ICcgJyArIGluc3BlY3QoeCk7XG4gICAgfVxuICB9XG4gIHJldHVybiBzdHI7XG59O1xuXG5cbi8vIE1hcmsgdGhhdCBhIG1ldGhvZCBzaG91bGQgbm90IGJlIHVzZWQuXG4vLyBSZXR1cm5zIGEgbW9kaWZpZWQgZnVuY3Rpb24gd2hpY2ggd2FybnMgb25jZSBieSBkZWZhdWx0LlxuLy8gSWYgLS1uby1kZXByZWNhdGlvbiBpcyBzZXQsIHRoZW4gaXQgaXMgYSBuby1vcC5cbmV4cG9ydHMuZGVwcmVjYXRlID0gZnVuY3Rpb24oZm4sIG1zZykge1xuICAvLyBBbGxvdyBmb3IgZGVwcmVjYXRpbmcgdGhpbmdzIGluIHRoZSBwcm9jZXNzIG9mIHN0YXJ0aW5nIHVwLlxuICBpZiAoaXNVbmRlZmluZWQoZ2xvYmFsLnByb2Nlc3MpKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgcmV0dXJuIGV4cG9ydHMuZGVwcmVjYXRlKGZuLCBtc2cpLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfTtcbiAgfVxuXG4gIGlmIChwcm9jZXNzLm5vRGVwcmVjYXRpb24gPT09IHRydWUpIHtcbiAgICByZXR1cm4gZm47XG4gIH1cblxuICB2YXIgd2FybmVkID0gZmFsc2U7XG4gIGZ1bmN0aW9uIGRlcHJlY2F0ZWQoKSB7XG4gICAgaWYgKCF3YXJuZWQpIHtcbiAgICAgIGlmIChwcm9jZXNzLnRocm93RGVwcmVjYXRpb24pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1zZyk7XG4gICAgICB9IGVsc2UgaWYgKHByb2Nlc3MudHJhY2VEZXByZWNhdGlvbikge1xuICAgICAgICBjb25zb2xlLnRyYWNlKG1zZyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmVycm9yKG1zZyk7XG4gICAgICB9XG4gICAgICB3YXJuZWQgPSB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgfVxuXG4gIHJldHVybiBkZXByZWNhdGVkO1xufTtcblxuXG52YXIgZGVidWdzID0ge307XG52YXIgZGVidWdFbnZpcm9uO1xuZXhwb3J0cy5kZWJ1Z2xvZyA9IGZ1bmN0aW9uKHNldCkge1xuICBpZiAoaXNVbmRlZmluZWQoZGVidWdFbnZpcm9uKSlcbiAgICBkZWJ1Z0Vudmlyb24gPSBwcm9jZXNzLmVudi5OT0RFX0RFQlVHIHx8ICcnO1xuICBzZXQgPSBzZXQudG9VcHBlckNhc2UoKTtcbiAgaWYgKCFkZWJ1Z3Nbc2V0XSkge1xuICAgIGlmIChuZXcgUmVnRXhwKCdcXFxcYicgKyBzZXQgKyAnXFxcXGInLCAnaScpLnRlc3QoZGVidWdFbnZpcm9uKSkge1xuICAgICAgdmFyIHBpZCA9IHByb2Nlc3MucGlkO1xuICAgICAgZGVidWdzW3NldF0gPSBmdW5jdGlvbigpIHtcbiAgICAgICAgdmFyIG1zZyA9IGV4cG9ydHMuZm9ybWF0LmFwcGx5KGV4cG9ydHMsIGFyZ3VtZW50cyk7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoJyVzICVkOiAlcycsIHNldCwgcGlkLCBtc2cpO1xuICAgICAgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgZGVidWdzW3NldF0gPSBmdW5jdGlvbigpIHt9O1xuICAgIH1cbiAgfVxuICByZXR1cm4gZGVidWdzW3NldF07XG59O1xuXG5cbi8qKlxuICogRWNob3MgdGhlIHZhbHVlIG9mIGEgdmFsdWUuIFRyeXMgdG8gcHJpbnQgdGhlIHZhbHVlIG91dFxuICogaW4gdGhlIGJlc3Qgd2F5IHBvc3NpYmxlIGdpdmVuIHRoZSBkaWZmZXJlbnQgdHlwZXMuXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IG9iaiBUaGUgb2JqZWN0IHRvIHByaW50IG91dC5cbiAqIEBwYXJhbSB7T2JqZWN0fSBvcHRzIE9wdGlvbmFsIG9wdGlvbnMgb2JqZWN0IHRoYXQgYWx0ZXJzIHRoZSBvdXRwdXQuXG4gKi9cbi8qIGxlZ2FjeTogb2JqLCBzaG93SGlkZGVuLCBkZXB0aCwgY29sb3JzKi9cbmZ1bmN0aW9uIGluc3BlY3Qob2JqLCBvcHRzKSB7XG4gIC8vIGRlZmF1bHQgb3B0aW9uc1xuICB2YXIgY3R4ID0ge1xuICAgIHNlZW46IFtdLFxuICAgIHN0eWxpemU6IHN0eWxpemVOb0NvbG9yXG4gIH07XG4gIC8vIGxlZ2FjeS4uLlxuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+PSAzKSBjdHguZGVwdGggPSBhcmd1bWVudHNbMl07XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID49IDQpIGN0eC5jb2xvcnMgPSBhcmd1bWVudHNbM107XG4gIGlmIChpc0Jvb2xlYW4ob3B0cykpIHtcbiAgICAvLyBsZWdhY3kuLi5cbiAgICBjdHguc2hvd0hpZGRlbiA9IG9wdHM7XG4gIH0gZWxzZSBpZiAob3B0cykge1xuICAgIC8vIGdvdCBhbiBcIm9wdGlvbnNcIiBvYmplY3RcbiAgICBleHBvcnRzLl9leHRlbmQoY3R4LCBvcHRzKTtcbiAgfVxuICAvLyBzZXQgZGVmYXVsdCBvcHRpb25zXG4gIGlmIChpc1VuZGVmaW5lZChjdHguc2hvd0hpZGRlbikpIGN0eC5zaG93SGlkZGVuID0gZmFsc2U7XG4gIGlmIChpc1VuZGVmaW5lZChjdHguZGVwdGgpKSBjdHguZGVwdGggPSAyO1xuICBpZiAoaXNVbmRlZmluZWQoY3R4LmNvbG9ycykpIGN0eC5jb2xvcnMgPSBmYWxzZTtcbiAgaWYgKGlzVW5kZWZpbmVkKGN0eC5jdXN0b21JbnNwZWN0KSkgY3R4LmN1c3RvbUluc3BlY3QgPSB0cnVlO1xuICBpZiAoY3R4LmNvbG9ycykgY3R4LnN0eWxpemUgPSBzdHlsaXplV2l0aENvbG9yO1xuICByZXR1cm4gZm9ybWF0VmFsdWUoY3R4LCBvYmosIGN0eC5kZXB0aCk7XG59XG5leHBvcnRzLmluc3BlY3QgPSBpbnNwZWN0O1xuXG5cbi8vIGh0dHA6Ly9lbi53aWtpcGVkaWEub3JnL3dpa2kvQU5TSV9lc2NhcGVfY29kZSNncmFwaGljc1xuaW5zcGVjdC5jb2xvcnMgPSB7XG4gICdib2xkJyA6IFsxLCAyMl0sXG4gICdpdGFsaWMnIDogWzMsIDIzXSxcbiAgJ3VuZGVybGluZScgOiBbNCwgMjRdLFxuICAnaW52ZXJzZScgOiBbNywgMjddLFxuICAnd2hpdGUnIDogWzM3LCAzOV0sXG4gICdncmV5JyA6IFs5MCwgMzldLFxuICAnYmxhY2snIDogWzMwLCAzOV0sXG4gICdibHVlJyA6IFszNCwgMzldLFxuICAnY3lhbicgOiBbMzYsIDM5XSxcbiAgJ2dyZWVuJyA6IFszMiwgMzldLFxuICAnbWFnZW50YScgOiBbMzUsIDM5XSxcbiAgJ3JlZCcgOiBbMzEsIDM5XSxcbiAgJ3llbGxvdycgOiBbMzMsIDM5XVxufTtcblxuLy8gRG9uJ3QgdXNlICdibHVlJyBub3QgdmlzaWJsZSBvbiBjbWQuZXhlXG5pbnNwZWN0LnN0eWxlcyA9IHtcbiAgJ3NwZWNpYWwnOiAnY3lhbicsXG4gICdudW1iZXInOiAneWVsbG93JyxcbiAgJ2Jvb2xlYW4nOiAneWVsbG93JyxcbiAgJ3VuZGVmaW5lZCc6ICdncmV5JyxcbiAgJ251bGwnOiAnYm9sZCcsXG4gICdzdHJpbmcnOiAnZ3JlZW4nLFxuICAnZGF0ZSc6ICdtYWdlbnRhJyxcbiAgLy8gXCJuYW1lXCI6IGludGVudGlvbmFsbHkgbm90IHN0eWxpbmdcbiAgJ3JlZ2V4cCc6ICdyZWQnXG59O1xuXG5cbmZ1bmN0aW9uIHN0eWxpemVXaXRoQ29sb3Ioc3RyLCBzdHlsZVR5cGUpIHtcbiAgdmFyIHN0eWxlID0gaW5zcGVjdC5zdHlsZXNbc3R5bGVUeXBlXTtcblxuICBpZiAoc3R5bGUpIHtcbiAgICByZXR1cm4gJ1xcdTAwMWJbJyArIGluc3BlY3QuY29sb3JzW3N0eWxlXVswXSArICdtJyArIHN0ciArXG4gICAgICAgICAgICdcXHUwMDFiWycgKyBpbnNwZWN0LmNvbG9yc1tzdHlsZV1bMV0gKyAnbSc7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIHN0cjtcbiAgfVxufVxuXG5cbmZ1bmN0aW9uIHN0eWxpemVOb0NvbG9yKHN0ciwgc3R5bGVUeXBlKSB7XG4gIHJldHVybiBzdHI7XG59XG5cblxuZnVuY3Rpb24gYXJyYXlUb0hhc2goYXJyYXkpIHtcbiAgdmFyIGhhc2ggPSB7fTtcblxuICBhcnJheS5mb3JFYWNoKGZ1bmN0aW9uKHZhbCwgaWR4KSB7XG4gICAgaGFzaFt2YWxdID0gdHJ1ZTtcbiAgfSk7XG5cbiAgcmV0dXJuIGhhc2g7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0VmFsdWUoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzKSB7XG4gIC8vIFByb3ZpZGUgYSBob29rIGZvciB1c2VyLXNwZWNpZmllZCBpbnNwZWN0IGZ1bmN0aW9ucy5cbiAgLy8gQ2hlY2sgdGhhdCB2YWx1ZSBpcyBhbiBvYmplY3Qgd2l0aCBhbiBpbnNwZWN0IGZ1bmN0aW9uIG9uIGl0XG4gIGlmIChjdHguY3VzdG9tSW5zcGVjdCAmJlxuICAgICAgdmFsdWUgJiZcbiAgICAgIGlzRnVuY3Rpb24odmFsdWUuaW5zcGVjdCkgJiZcbiAgICAgIC8vIEZpbHRlciBvdXQgdGhlIHV0aWwgbW9kdWxlLCBpdCdzIGluc3BlY3QgZnVuY3Rpb24gaXMgc3BlY2lhbFxuICAgICAgdmFsdWUuaW5zcGVjdCAhPT0gZXhwb3J0cy5pbnNwZWN0ICYmXG4gICAgICAvLyBBbHNvIGZpbHRlciBvdXQgYW55IHByb3RvdHlwZSBvYmplY3RzIHVzaW5nIHRoZSBjaXJjdWxhciBjaGVjay5cbiAgICAgICEodmFsdWUuY29uc3RydWN0b3IgJiYgdmFsdWUuY29uc3RydWN0b3IucHJvdG90eXBlID09PSB2YWx1ZSkpIHtcbiAgICB2YXIgcmV0ID0gdmFsdWUuaW5zcGVjdChyZWN1cnNlVGltZXMsIGN0eCk7XG4gICAgaWYgKCFpc1N0cmluZyhyZXQpKSB7XG4gICAgICByZXQgPSBmb3JtYXRWYWx1ZShjdHgsIHJldCwgcmVjdXJzZVRpbWVzKTtcbiAgICB9XG4gICAgcmV0dXJuIHJldDtcbiAgfVxuXG4gIC8vIFByaW1pdGl2ZSB0eXBlcyBjYW5ub3QgaGF2ZSBwcm9wZXJ0aWVzXG4gIHZhciBwcmltaXRpdmUgPSBmb3JtYXRQcmltaXRpdmUoY3R4LCB2YWx1ZSk7XG4gIGlmIChwcmltaXRpdmUpIHtcbiAgICByZXR1cm4gcHJpbWl0aXZlO1xuICB9XG5cbiAgLy8gTG9vayB1cCB0aGUga2V5cyBvZiB0aGUgb2JqZWN0LlxuICB2YXIga2V5cyA9IE9iamVjdC5rZXlzKHZhbHVlKTtcbiAgdmFyIHZpc2libGVLZXlzID0gYXJyYXlUb0hhc2goa2V5cyk7XG5cbiAgaWYgKGN0eC5zaG93SGlkZGVuKSB7XG4gICAga2V5cyA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eU5hbWVzKHZhbHVlKTtcbiAgfVxuXG4gIC8vIElFIGRvZXNuJ3QgbWFrZSBlcnJvciBmaWVsZHMgbm9uLWVudW1lcmFibGVcbiAgLy8gaHR0cDovL21zZG4ubWljcm9zb2Z0LmNvbS9lbi11cy9saWJyYXJ5L2llL2R3dzUyc2J0KHY9dnMuOTQpLmFzcHhcbiAgaWYgKGlzRXJyb3IodmFsdWUpXG4gICAgICAmJiAoa2V5cy5pbmRleE9mKCdtZXNzYWdlJykgPj0gMCB8fCBrZXlzLmluZGV4T2YoJ2Rlc2NyaXB0aW9uJykgPj0gMCkpIHtcbiAgICByZXR1cm4gZm9ybWF0RXJyb3IodmFsdWUpO1xuICB9XG5cbiAgLy8gU29tZSB0eXBlIG9mIG9iamVjdCB3aXRob3V0IHByb3BlcnRpZXMgY2FuIGJlIHNob3J0Y3V0dGVkLlxuICBpZiAoa2V5cy5sZW5ndGggPT09IDApIHtcbiAgICBpZiAoaXNGdW5jdGlvbih2YWx1ZSkpIHtcbiAgICAgIHZhciBuYW1lID0gdmFsdWUubmFtZSA/ICc6ICcgKyB2YWx1ZS5uYW1lIDogJyc7XG4gICAgICByZXR1cm4gY3R4LnN0eWxpemUoJ1tGdW5jdGlvbicgKyBuYW1lICsgJ10nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgICBpZiAoaXNSZWdFeHAodmFsdWUpKSB7XG4gICAgICByZXR1cm4gY3R4LnN0eWxpemUoUmVnRXhwLnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHZhbHVlKSwgJ3JlZ2V4cCcpO1xuICAgIH1cbiAgICBpZiAoaXNEYXRlKHZhbHVlKSkge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKERhdGUucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpLCAnZGF0ZScpO1xuICAgIH1cbiAgICBpZiAoaXNFcnJvcih2YWx1ZSkpIHtcbiAgICAgIHJldHVybiBmb3JtYXRFcnJvcih2YWx1ZSk7XG4gICAgfVxuICB9XG5cbiAgdmFyIGJhc2UgPSAnJywgYXJyYXkgPSBmYWxzZSwgYnJhY2VzID0gWyd7JywgJ30nXTtcblxuICAvLyBNYWtlIEFycmF5IHNheSB0aGF0IHRoZXkgYXJlIEFycmF5XG4gIGlmIChpc0FycmF5KHZhbHVlKSkge1xuICAgIGFycmF5ID0gdHJ1ZTtcbiAgICBicmFjZXMgPSBbJ1snLCAnXSddO1xuICB9XG5cbiAgLy8gTWFrZSBmdW5jdGlvbnMgc2F5IHRoYXQgdGhleSBhcmUgZnVuY3Rpb25zXG4gIGlmIChpc0Z1bmN0aW9uKHZhbHVlKSkge1xuICAgIHZhciBuID0gdmFsdWUubmFtZSA/ICc6ICcgKyB2YWx1ZS5uYW1lIDogJyc7XG4gICAgYmFzZSA9ICcgW0Z1bmN0aW9uJyArIG4gKyAnXSc7XG4gIH1cblxuICAvLyBNYWtlIFJlZ0V4cHMgc2F5IHRoYXQgdGhleSBhcmUgUmVnRXhwc1xuICBpZiAoaXNSZWdFeHAodmFsdWUpKSB7XG4gICAgYmFzZSA9ICcgJyArIFJlZ0V4cC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSk7XG4gIH1cblxuICAvLyBNYWtlIGRhdGVzIHdpdGggcHJvcGVydGllcyBmaXJzdCBzYXkgdGhlIGRhdGVcbiAgaWYgKGlzRGF0ZSh2YWx1ZSkpIHtcbiAgICBiYXNlID0gJyAnICsgRGF0ZS5wcm90b3R5cGUudG9VVENTdHJpbmcuY2FsbCh2YWx1ZSk7XG4gIH1cblxuICAvLyBNYWtlIGVycm9yIHdpdGggbWVzc2FnZSBmaXJzdCBzYXkgdGhlIGVycm9yXG4gIGlmIChpc0Vycm9yKHZhbHVlKSkge1xuICAgIGJhc2UgPSAnICcgKyBmb3JtYXRFcnJvcih2YWx1ZSk7XG4gIH1cblxuICBpZiAoa2V5cy5sZW5ndGggPT09IDAgJiYgKCFhcnJheSB8fCB2YWx1ZS5sZW5ndGggPT0gMCkpIHtcbiAgICByZXR1cm4gYnJhY2VzWzBdICsgYmFzZSArIGJyYWNlc1sxXTtcbiAgfVxuXG4gIGlmIChyZWN1cnNlVGltZXMgPCAwKSB7XG4gICAgaWYgKGlzUmVnRXhwKHZhbHVlKSkge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKFJlZ0V4cC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSksICdyZWdleHAnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKCdbT2JqZWN0XScsICdzcGVjaWFsJyk7XG4gICAgfVxuICB9XG5cbiAgY3R4LnNlZW4ucHVzaCh2YWx1ZSk7XG5cbiAgdmFyIG91dHB1dDtcbiAgaWYgKGFycmF5KSB7XG4gICAgb3V0cHV0ID0gZm9ybWF0QXJyYXkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5cyk7XG4gIH0gZWxzZSB7XG4gICAgb3V0cHV0ID0ga2V5cy5tYXAoZnVuY3Rpb24oa2V5KSB7XG4gICAgICByZXR1cm4gZm9ybWF0UHJvcGVydHkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5LCBhcnJheSk7XG4gICAgfSk7XG4gIH1cblxuICBjdHguc2Vlbi5wb3AoKTtcblxuICByZXR1cm4gcmVkdWNlVG9TaW5nbGVTdHJpbmcob3V0cHV0LCBiYXNlLCBicmFjZXMpO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdFByaW1pdGl2ZShjdHgsIHZhbHVlKSB7XG4gIGlmIChpc1VuZGVmaW5lZCh2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCd1bmRlZmluZWQnLCAndW5kZWZpbmVkJyk7XG4gIGlmIChpc1N0cmluZyh2YWx1ZSkpIHtcbiAgICB2YXIgc2ltcGxlID0gJ1xcJycgKyBKU09OLnN0cmluZ2lmeSh2YWx1ZSkucmVwbGFjZSgvXlwifFwiJC9nLCAnJylcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIilcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXFxcXCIvZywgJ1wiJykgKyAnXFwnJztcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoc2ltcGxlLCAnc3RyaW5nJyk7XG4gIH1cbiAgaWYgKGlzTnVtYmVyKHZhbHVlKSlcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoJycgKyB2YWx1ZSwgJ251bWJlcicpO1xuICBpZiAoaXNCb29sZWFuKHZhbHVlKSlcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoJycgKyB2YWx1ZSwgJ2Jvb2xlYW4nKTtcbiAgLy8gRm9yIHNvbWUgcmVhc29uIHR5cGVvZiBudWxsIGlzIFwib2JqZWN0XCIsIHNvIHNwZWNpYWwgY2FzZSBoZXJlLlxuICBpZiAoaXNOdWxsKHZhbHVlKSlcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoJ251bGwnLCAnbnVsbCcpO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdEVycm9yKHZhbHVlKSB7XG4gIHJldHVybiAnWycgKyBFcnJvci5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSkgKyAnXSc7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0QXJyYXkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5cykge1xuICB2YXIgb3V0cHV0ID0gW107XG4gIGZvciAodmFyIGkgPSAwLCBsID0gdmFsdWUubGVuZ3RoOyBpIDwgbDsgKytpKSB7XG4gICAgaWYgKGhhc093blByb3BlcnR5KHZhbHVlLCBTdHJpbmcoaSkpKSB7XG4gICAgICBvdXRwdXQucHVzaChmb3JtYXRQcm9wZXJ0eShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLFxuICAgICAgICAgIFN0cmluZyhpKSwgdHJ1ZSkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBvdXRwdXQucHVzaCgnJyk7XG4gICAgfVxuICB9XG4gIGtleXMuZm9yRWFjaChmdW5jdGlvbihrZXkpIHtcbiAgICBpZiAoIWtleS5tYXRjaCgvXlxcZCskLykpIHtcbiAgICAgIG91dHB1dC5wdXNoKGZvcm1hdFByb3BlcnR5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsXG4gICAgICAgICAga2V5LCB0cnVlKSk7XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIG91dHB1dDtcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRQcm9wZXJ0eShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLCBrZXksIGFycmF5KSB7XG4gIHZhciBuYW1lLCBzdHIsIGRlc2M7XG4gIGRlc2MgPSBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKHZhbHVlLCBrZXkpIHx8IHsgdmFsdWU6IHZhbHVlW2tleV0gfTtcbiAgaWYgKGRlc2MuZ2V0KSB7XG4gICAgaWYgKGRlc2Muc2V0KSB7XG4gICAgICBzdHIgPSBjdHguc3R5bGl6ZSgnW0dldHRlci9TZXR0ZXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3RyID0gY3R4LnN0eWxpemUoJ1tHZXR0ZXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgaWYgKGRlc2Muc2V0KSB7XG4gICAgICBzdHIgPSBjdHguc3R5bGl6ZSgnW1NldHRlcl0nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgfVxuICBpZiAoIWhhc093blByb3BlcnR5KHZpc2libGVLZXlzLCBrZXkpKSB7XG4gICAgbmFtZSA9ICdbJyArIGtleSArICddJztcbiAgfVxuICBpZiAoIXN0cikge1xuICAgIGlmIChjdHguc2Vlbi5pbmRleE9mKGRlc2MudmFsdWUpIDwgMCkge1xuICAgICAgaWYgKGlzTnVsbChyZWN1cnNlVGltZXMpKSB7XG4gICAgICAgIHN0ciA9IGZvcm1hdFZhbHVlKGN0eCwgZGVzYy52YWx1ZSwgbnVsbCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzdHIgPSBmb3JtYXRWYWx1ZShjdHgsIGRlc2MudmFsdWUsIHJlY3Vyc2VUaW1lcyAtIDEpO1xuICAgICAgfVxuICAgICAgaWYgKHN0ci5pbmRleE9mKCdcXG4nKSA+IC0xKSB7XG4gICAgICAgIGlmIChhcnJheSkge1xuICAgICAgICAgIHN0ciA9IHN0ci5zcGxpdCgnXFxuJykubWFwKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgICAgICAgIHJldHVybiAnICAnICsgbGluZTtcbiAgICAgICAgICB9KS5qb2luKCdcXG4nKS5zdWJzdHIoMik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc3RyID0gJ1xcbicgKyBzdHIuc3BsaXQoJ1xcbicpLm1hcChmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgICAgICByZXR1cm4gJyAgICcgKyBsaW5lO1xuICAgICAgICAgIH0pLmpvaW4oJ1xcbicpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0ciA9IGN0eC5zdHlsaXplKCdbQ2lyY3VsYXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gIH1cbiAgaWYgKGlzVW5kZWZpbmVkKG5hbWUpKSB7XG4gICAgaWYgKGFycmF5ICYmIGtleS5tYXRjaCgvXlxcZCskLykpIHtcbiAgICAgIHJldHVybiBzdHI7XG4gICAgfVxuICAgIG5hbWUgPSBKU09OLnN0cmluZ2lmeSgnJyArIGtleSk7XG4gICAgaWYgKG5hbWUubWF0Y2goL15cIihbYS16QS1aX11bYS16QS1aXzAtOV0qKVwiJC8pKSB7XG4gICAgICBuYW1lID0gbmFtZS5zdWJzdHIoMSwgbmFtZS5sZW5ndGggLSAyKTtcbiAgICAgIG5hbWUgPSBjdHguc3R5bGl6ZShuYW1lLCAnbmFtZScpO1xuICAgIH0gZWxzZSB7XG4gICAgICBuYW1lID0gbmFtZS5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIilcbiAgICAgICAgICAgICAgICAgLnJlcGxhY2UoL1xcXFxcIi9nLCAnXCInKVxuICAgICAgICAgICAgICAgICAucmVwbGFjZSgvKF5cInxcIiQpL2csIFwiJ1wiKTtcbiAgICAgIG5hbWUgPSBjdHguc3R5bGl6ZShuYW1lLCAnc3RyaW5nJyk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG5hbWUgKyAnOiAnICsgc3RyO1xufVxuXG5cbmZ1bmN0aW9uIHJlZHVjZVRvU2luZ2xlU3RyaW5nKG91dHB1dCwgYmFzZSwgYnJhY2VzKSB7XG4gIHZhciBudW1MaW5lc0VzdCA9IDA7XG4gIHZhciBsZW5ndGggPSBvdXRwdXQucmVkdWNlKGZ1bmN0aW9uKHByZXYsIGN1cikge1xuICAgIG51bUxpbmVzRXN0Kys7XG4gICAgaWYgKGN1ci5pbmRleE9mKCdcXG4nKSA+PSAwKSBudW1MaW5lc0VzdCsrO1xuICAgIHJldHVybiBwcmV2ICsgY3VyLnJlcGxhY2UoL1xcdTAwMWJcXFtcXGRcXGQ/bS9nLCAnJykubGVuZ3RoICsgMTtcbiAgfSwgMCk7XG5cbiAgaWYgKGxlbmd0aCA+IDYwKSB7XG4gICAgcmV0dXJuIGJyYWNlc1swXSArXG4gICAgICAgICAgIChiYXNlID09PSAnJyA/ICcnIDogYmFzZSArICdcXG4gJykgK1xuICAgICAgICAgICAnICcgK1xuICAgICAgICAgICBvdXRwdXQuam9pbignLFxcbiAgJykgK1xuICAgICAgICAgICAnICcgK1xuICAgICAgICAgICBicmFjZXNbMV07XG4gIH1cblxuICByZXR1cm4gYnJhY2VzWzBdICsgYmFzZSArICcgJyArIG91dHB1dC5qb2luKCcsICcpICsgJyAnICsgYnJhY2VzWzFdO1xufVxuXG5cbi8vIE5PVEU6IFRoZXNlIHR5cGUgY2hlY2tpbmcgZnVuY3Rpb25zIGludGVudGlvbmFsbHkgZG9uJ3QgdXNlIGBpbnN0YW5jZW9mYFxuLy8gYmVjYXVzZSBpdCBpcyBmcmFnaWxlIGFuZCBjYW4gYmUgZWFzaWx5IGZha2VkIHdpdGggYE9iamVjdC5jcmVhdGUoKWAuXG5mdW5jdGlvbiBpc0FycmF5KGFyKSB7XG4gIHJldHVybiBBcnJheS5pc0FycmF5KGFyKTtcbn1cbmV4cG9ydHMuaXNBcnJheSA9IGlzQXJyYXk7XG5cbmZ1bmN0aW9uIGlzQm9vbGVhbihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdib29sZWFuJztcbn1cbmV4cG9ydHMuaXNCb29sZWFuID0gaXNCb29sZWFuO1xuXG5mdW5jdGlvbiBpc051bGwoYXJnKSB7XG4gIHJldHVybiBhcmcgPT09IG51bGw7XG59XG5leHBvcnRzLmlzTnVsbCA9IGlzTnVsbDtcblxuZnVuY3Rpb24gaXNOdWxsT3JVbmRlZmluZWQoYXJnKSB7XG4gIHJldHVybiBhcmcgPT0gbnVsbDtcbn1cbmV4cG9ydHMuaXNOdWxsT3JVbmRlZmluZWQgPSBpc051bGxPclVuZGVmaW5lZDtcblxuZnVuY3Rpb24gaXNOdW1iZXIoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnbnVtYmVyJztcbn1cbmV4cG9ydHMuaXNOdW1iZXIgPSBpc051bWJlcjtcblxuZnVuY3Rpb24gaXNTdHJpbmcoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnc3RyaW5nJztcbn1cbmV4cG9ydHMuaXNTdHJpbmcgPSBpc1N0cmluZztcblxuZnVuY3Rpb24gaXNTeW1ib2woYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnc3ltYm9sJztcbn1cbmV4cG9ydHMuaXNTeW1ib2wgPSBpc1N5bWJvbDtcblxuZnVuY3Rpb24gaXNVbmRlZmluZWQoYXJnKSB7XG4gIHJldHVybiBhcmcgPT09IHZvaWQgMDtcbn1cbmV4cG9ydHMuaXNVbmRlZmluZWQgPSBpc1VuZGVmaW5lZDtcblxuZnVuY3Rpb24gaXNSZWdFeHAocmUpIHtcbiAgcmV0dXJuIGlzT2JqZWN0KHJlKSAmJiBvYmplY3RUb1N0cmluZyhyZSkgPT09ICdbb2JqZWN0IFJlZ0V4cF0nO1xufVxuZXhwb3J0cy5pc1JlZ0V4cCA9IGlzUmVnRXhwO1xuXG5mdW5jdGlvbiBpc09iamVjdChhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdvYmplY3QnICYmIGFyZyAhPT0gbnVsbDtcbn1cbmV4cG9ydHMuaXNPYmplY3QgPSBpc09iamVjdDtcblxuZnVuY3Rpb24gaXNEYXRlKGQpIHtcbiAgcmV0dXJuIGlzT2JqZWN0KGQpICYmIG9iamVjdFRvU3RyaW5nKGQpID09PSAnW29iamVjdCBEYXRlXSc7XG59XG5leHBvcnRzLmlzRGF0ZSA9IGlzRGF0ZTtcblxuZnVuY3Rpb24gaXNFcnJvcihlKSB7XG4gIHJldHVybiBpc09iamVjdChlKSAmJlxuICAgICAgKG9iamVjdFRvU3RyaW5nKGUpID09PSAnW29iamVjdCBFcnJvcl0nIHx8IGUgaW5zdGFuY2VvZiBFcnJvcik7XG59XG5leHBvcnRzLmlzRXJyb3IgPSBpc0Vycm9yO1xuXG5mdW5jdGlvbiBpc0Z1bmN0aW9uKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ2Z1bmN0aW9uJztcbn1cbmV4cG9ydHMuaXNGdW5jdGlvbiA9IGlzRnVuY3Rpb247XG5cbmZ1bmN0aW9uIGlzUHJpbWl0aXZlKGFyZykge1xuICByZXR1cm4gYXJnID09PSBudWxsIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnYm9vbGVhbicgfHxcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICdudW1iZXInIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnc3RyaW5nJyB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ3N5bWJvbCcgfHwgIC8vIEVTNiBzeW1ib2xcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICd1bmRlZmluZWQnO1xufVxuZXhwb3J0cy5pc1ByaW1pdGl2ZSA9IGlzUHJpbWl0aXZlO1xuXG5leHBvcnRzLmlzQnVmZmVyID0gcmVxdWlyZSgnLi9zdXBwb3J0L2lzQnVmZmVyJyk7XG5cbmZ1bmN0aW9uIG9iamVjdFRvU3RyaW5nKG8pIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChvKTtcbn1cblxuXG5mdW5jdGlvbiBwYWQobikge1xuICByZXR1cm4gbiA8IDEwID8gJzAnICsgbi50b1N0cmluZygxMCkgOiBuLnRvU3RyaW5nKDEwKTtcbn1cblxuXG52YXIgbW9udGhzID0gWydKYW4nLCAnRmViJywgJ01hcicsICdBcHInLCAnTWF5JywgJ0p1bicsICdKdWwnLCAnQXVnJywgJ1NlcCcsXG4gICAgICAgICAgICAgICdPY3QnLCAnTm92JywgJ0RlYyddO1xuXG4vLyAyNiBGZWIgMTY6MTk6MzRcbmZ1bmN0aW9uIHRpbWVzdGFtcCgpIHtcbiAgdmFyIGQgPSBuZXcgRGF0ZSgpO1xuICB2YXIgdGltZSA9IFtwYWQoZC5nZXRIb3VycygpKSxcbiAgICAgICAgICAgICAgcGFkKGQuZ2V0TWludXRlcygpKSxcbiAgICAgICAgICAgICAgcGFkKGQuZ2V0U2Vjb25kcygpKV0uam9pbignOicpO1xuICByZXR1cm4gW2QuZ2V0RGF0ZSgpLCBtb250aHNbZC5nZXRNb250aCgpXSwgdGltZV0uam9pbignICcpO1xufVxuXG5cbi8vIGxvZyBpcyBqdXN0IGEgdGhpbiB3cmFwcGVyIHRvIGNvbnNvbGUubG9nIHRoYXQgcHJlcGVuZHMgYSB0aW1lc3RhbXBcbmV4cG9ydHMubG9nID0gZnVuY3Rpb24oKSB7XG4gIGNvbnNvbGUubG9nKCclcyAtICVzJywgdGltZXN0YW1wKCksIGV4cG9ydHMuZm9ybWF0LmFwcGx5KGV4cG9ydHMsIGFyZ3VtZW50cykpO1xufTtcblxuXG4vKipcbiAqIEluaGVyaXQgdGhlIHByb3RvdHlwZSBtZXRob2RzIGZyb20gb25lIGNvbnN0cnVjdG9yIGludG8gYW5vdGhlci5cbiAqXG4gKiBUaGUgRnVuY3Rpb24ucHJvdG90eXBlLmluaGVyaXRzIGZyb20gbGFuZy5qcyByZXdyaXR0ZW4gYXMgYSBzdGFuZGFsb25lXG4gKiBmdW5jdGlvbiAobm90IG9uIEZ1bmN0aW9uLnByb3RvdHlwZSkuIE5PVEU6IElmIHRoaXMgZmlsZSBpcyB0byBiZSBsb2FkZWRcbiAqIGR1cmluZyBib290c3RyYXBwaW5nIHRoaXMgZnVuY3Rpb24gbmVlZHMgdG8gYmUgcmV3cml0dGVuIHVzaW5nIHNvbWUgbmF0aXZlXG4gKiBmdW5jdGlvbnMgYXMgcHJvdG90eXBlIHNldHVwIHVzaW5nIG5vcm1hbCBKYXZhU2NyaXB0IGRvZXMgbm90IHdvcmsgYXNcbiAqIGV4cGVjdGVkIGR1cmluZyBib290c3RyYXBwaW5nIChzZWUgbWlycm9yLmpzIGluIHIxMTQ5MDMpLlxuICpcbiAqIEBwYXJhbSB7ZnVuY3Rpb259IGN0b3IgQ29uc3RydWN0b3IgZnVuY3Rpb24gd2hpY2ggbmVlZHMgdG8gaW5oZXJpdCB0aGVcbiAqICAgICBwcm90b3R5cGUuXG4gKiBAcGFyYW0ge2Z1bmN0aW9ufSBzdXBlckN0b3IgQ29uc3RydWN0b3IgZnVuY3Rpb24gdG8gaW5oZXJpdCBwcm90b3R5cGUgZnJvbS5cbiAqL1xuZXhwb3J0cy5pbmhlcml0cyA9IHJlcXVpcmUoJ2luaGVyaXRzJyk7XG5cbmV4cG9ydHMuX2V4dGVuZCA9IGZ1bmN0aW9uKG9yaWdpbiwgYWRkKSB7XG4gIC8vIERvbid0IGRvIGFueXRoaW5nIGlmIGFkZCBpc24ndCBhbiBvYmplY3RcbiAgaWYgKCFhZGQgfHwgIWlzT2JqZWN0KGFkZCkpIHJldHVybiBvcmlnaW47XG5cbiAgdmFyIGtleXMgPSBPYmplY3Qua2V5cyhhZGQpO1xuICB2YXIgaSA9IGtleXMubGVuZ3RoO1xuICB3aGlsZSAoaS0tKSB7XG4gICAgb3JpZ2luW2tleXNbaV1dID0gYWRkW2tleXNbaV1dO1xuICB9XG4gIHJldHVybiBvcmlnaW47XG59O1xuXG5mdW5jdGlvbiBoYXNPd25Qcm9wZXJ0eShvYmosIHByb3ApIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIHByb3ApO1xufVxuIiwidmFyIEV2ZW50RW1pdHRlciA9IHJlcXVpcmUoJ2V2ZW50cycpLkV2ZW50RW1pdHRlcjtcbnZhciB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuXG52YXIgU3ByYXkgPSByZXF1aXJlKCdzcHJheS13cnRjJyk7XG52YXIgQ2F1c2FsQnJvYWRjYXN0ID0gcmVxdWlyZSgnY2F1c2FsLWJyb2FkY2FzdC1kZWZpbml0aW9uJyk7XG52YXIgVlZ3RSA9IHJlcXVpcmUoJ3ZlcnNpb24tdmVjdG9yLXdpdGgtZXhjZXB0aW9ucycpO1xudmFyIExTRVFUcmVlID0gcmVxdWlyZSgnbHNlcXRyZWUnKTtcbnZhciBHVUlEID0gcmVxdWlyZSgnLi9ndWlkLmpzJyk7XG5cbnZhciBNSW5zZXJ0T3BlcmF0aW9uID0gcmVxdWlyZSgnLi9tZXNzYWdlcy5qcycpLk1JbnNlcnRPcGVyYXRpb247XG52YXIgTUFFSW5zZXJ0T3BlcmF0aW9uID0gcmVxdWlyZSgnLi9tZXNzYWdlcy5qcycpLk1BRUluc2VydE9wZXJhdGlvbjtcbnZhciBNUmVtb3ZlT3BlcmF0aW9uID0gcmVxdWlyZSgnLi9tZXNzYWdlcy5qcycpLk1SZW1vdmVPcGVyYXRpb247XG52YXIgTUNhcmV0TW92ZWRPcGVyYXRpb24gPSByZXF1aXJlKCcuL21lc3NhZ2VzLmpzJykuTUNhcmV0TW92ZWRPcGVyYXRpb247XG5cbnV0aWwuaW5oZXJpdHMoQ3JhdGVDb3JlLCBFdmVudEVtaXR0ZXIpO1xuXG4vKiFcbiAqIFxcYnJpZWYgbGluayB0b2dldGhlciBhbGwgY29tcG9uZW50cyBvZiB0aGUgbW9kZWwgb2YgdGhlIENSQVRFIGVkaXRvclxuICogXFxwYXJhbSBpZCB0aGUgdW5pcXVlIHNpdGUgaWRlbnRpZmllclxuICogXFxwYXJhbSBvcHRpb25zIHRoZSB3ZWJydGMgc3BlY2lmaWMgb3B0aW9ucyBcbiAqL1xuZnVuY3Rpb24gQ3JhdGVDb3JlKGlkLCBvcHRpb25zKXtcbiAgICBFdmVudEVtaXR0ZXIuY2FsbCh0aGlzKTtcbiAgICBcbiAgICB0aGlzLmlkID0gaWQgfHwgR1VJRCgpO1xuICAgIHRoaXMub3B0aW9ucyA9IG9wdGlvbnM7XG4gICAgdGhpcy5icm9hZGNhc3QgPSBuZXcgQ2F1c2FsQnJvYWRjYXN0KG5ldyBTcHJheSh0aGlzLmlkLCB0aGlzLm9wdGlvbnMpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuZXcgVlZ3RSh0aGlzLmlkKSk7XG4gICAgdGhpcy5zZXF1ZW5jZSA9IG5ldyBMU0VRVHJlZSh0aGlzLmlkKTtcblxuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAvLyAjQSByZWd1bGFyIHJlY2VpdmVcbiAgICB0aGlzLmJyb2FkY2FzdC5vbigncmVjZWl2ZScsIGZ1bmN0aW9uKHJlY2VpdmVkQnJvYWRjYXN0TWVzc2FnZSl7XG4gICAgICAgIHN3aXRjaCAocmVjZWl2ZWRCcm9hZGNhc3RNZXNzYWdlLnR5cGUpe1xuICAgICAgICBjYXNlICdNUmVtb3ZlT3BlcmF0aW9uJzpcbiAgICAgICAgICAgIHNlbGYucmVtb3RlUmVtb3ZlKHJlY2VpdmVkQnJvYWRjYXN0TWVzc2FnZS5yZW1vdmUpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ01JbnNlcnRPcGVyYXRpb24nOlxuICAgICAgICAgICAgc2VsZi5yZW1vdGVJbnNlcnQocmVjZWl2ZWRCcm9hZGNhc3RNZXNzYWdlLmluc2VydCk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnTUNhcmV0TW92ZWRPcGVyYXRpb24nOlxuICAgICAgICAgICAgc2VsZi5yZW1vdGVDYXJldE1vdmVkKHJlY2VpdmVkQnJvYWRjYXN0TWVzc2FnZS5jYXJldE1vdmVkKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9O1xuICAgIH0pO1xuICAgIC8vICNCIGFudGktZW50cm9weSBmb3IgdGhlIG1pc3Npbmcgb3BlcmF0aW9uXG4gICAgdGhpcy5icm9hZGNhc3Qub24oJ2FudGlFbnRyb3B5JywgZnVuY3Rpb24oc29ja2V0LCByZW1vdGVWVndFLCBsb2NhbFZWd0Upe1xuICAgICAgICB2YXIgcmVtb3RlVlZ3RSA9IChuZXcgVlZ3RShudWxsKSkuZnJvbUpTT04ocmVtb3RlVlZ3RSk7IC8vIGNhc3RcbiAgICAgICAgdmFyIHRvU2VhcmNoID0gW107XG4gICAgICAgIC8vICMxIGZvciBlYWNoIGVudHJ5IG9mIG91ciBWVndFLCBsb29rIGlmIHRoZSByZW1vdGUgVlZ3RSBrbm93cyBsZXNzXG4gICAgICAgIGZvciAodmFyIGk9MDsgaTxsb2NhbFZWd0UudmVjdG9yLmFyci5sZW5ndGg7ICsraSl7XG4gICAgICAgICAgICB2YXIgbG9jYWxFbnRyeSA9IGxvY2FsVlZ3RS52ZWN0b3IuYXJyW2ldO1xuICAgICAgICAgICAgdmFyIGluZGV4ID0gcmVtb3RlVlZ3RS52ZWN0b3IuaW5kZXhPZihsb2NhbFZWd0UudmVjdG9yLmFycltpXSk7XG4gICAgICAgICAgICB2YXIgc3RhcnQgPSAxO1xuICAgICAgICAgICAgLy8gI0EgY2hlY2sgaWYgdGhlIGVudHJ5IGV4aXN0cyBpbiB0aGUgcmVtb3RlIHZ2d2VcbiAgICAgICAgICAgIGlmIChpbmRleCA+PTApeyBzdGFydCA9IHJlbW90ZVZWd0UudmVjdG9yLmFycltpbmRleF0udiArIDE7IH07XG4gICAgICAgICAgICBmb3IgKHZhciBqPXN0YXJ0OyBqPD1sb2NhbEVudHJ5LnY7ICsrail7XG4gICAgICAgICAgICAgICAgLy8gI0IgY2hlY2sgaWYgbm90IG9uZSBvZiB0aGUgbG9jYWwgZXhjZXB0aW9uc1xuICAgICAgICAgICAgICAgIGlmIChsb2NhbEVudHJ5LnguaW5kZXhPZihqKTwwKXtcbiAgICAgICAgICAgICAgICAgICAgdG9TZWFyY2gucHVzaCh7X2U6IGxvY2FsRW50cnkuZSwgX2M6IGp9KTtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIC8vICNDIGhhbmRsZSB0aGUgZXhjZXB0aW9ucyBvZiB0aGUgcmVtb3RlIHZlY3RvclxuICAgICAgICAgICAgaWYgKGluZGV4ID49MCl7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgaj0wOyBqPHJlbW90ZVZWd0UudmVjdG9yLmFycltpbmRleF0ueC5sZW5ndGg7KytqKXtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGV4Y2VwdCA9IHJlbW90ZVZWd0UudmVjdG9yLmFycltpbmRleF0ueFtqXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGxvY2FsRW50cnkueC5pbmRleE9mKGV4Y2VwdCk8MCAmJiBleGNlcHQ8PWxvY2FsRW50cnkudil7XG4gICAgICAgICAgICAgICAgICAgICAgICB0b1NlYXJjaC5wdXNoKHtfZTogbG9jYWxFbnRyeS5lLCBfYzogZXhjZXB0fSk7XG4gICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH07XG4gICAgICAgIH07XG4gICAgICAgIHZhciBlbGVtZW50cyA9IHNlbGYuZ2V0RWxlbWVudHModG9TZWFyY2gpO1xuICAgICAgICAvL3ZhciBlbGVtZW50cyA9IFtdO1xuICAgICAgICAvLyAjMiBzZW5kIGJhY2sgdGhlIGZvdW5kIGVsZW1lbnRzXG4gICAgICAgIHNlbGYuYnJvYWRjYXN0LnNlbmRBbnRpRW50cm9weVJlc3BvbnNlKHNvY2tldCwgbG9jYWxWVndFLCBlbGVtZW50cyk7XG4gICAgfSk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgY3JlYXRlIHRoZSBjb3JlIGZyb20gYW4gZXhpc3Rpbmcgb2JqZWN0XG4gKiBcXHBhcmFtIG9iamVjdCB0aGUgb2JqZWN0IHRvIGluaXRpYWxpemUgdGhlIGNvcmUgbW9kZWwgb2YgY3JhdGUgY29udGFpbmluZyBhIFxuICogc2VxdWVuY2UgYW5kIGNhdXNhbGl0eSB0cmFja2luZyBtZXRhZGF0YVxuICovXG5DcmF0ZUNvcmUucHJvdG90eXBlLmluaXQgPSBmdW5jdGlvbihvYmplY3Qpe1xuICAgIC8vIGltcG9ydCB0aGUgc2VxdWVuY2UgYW5kIHZlcnNpb24gdmVjdG9yLCB5ZXQgaXQga2VlcHMgdGhlIGlkZW50aWZpZXIgb2ZcbiAgICAvLyB0aGlzIGluc3RhbmNlIG9mIHRoZSBjb3JlLlxuICAgIHZhciBsb2NhbCA9IHRoaXMuYnJvYWRjYXN0LmNhdXNhbGl0eS5sb2NhbDtcbiAgICB0aGlzLmJyb2FkY2FzdC5jYXVzYWxpdHkuZnJvbUpTT04ob2JqZWN0LmNhdXNhbGl0eSk7XG4gICAgdGhpcy5icm9hZGNhc3QuY2F1c2FsaXR5LmxvY2FsID0gbG9jYWw7XG4gICAgdGhpcy5icm9hZGNhc3QuY2F1c2FsaXR5LnZlY3Rvci5pbnNlcnQodGhpcy5icm9hZGNhc3QuY2F1c2FsaXR5LmxvY2FsKTtcbiAgICBcbiAgICB0aGlzLnNlcXVlbmNlLmZyb21KU09OKG9iamVjdC5zZXF1ZW5jZSk7XG4gICAgdGhpcy5zZXF1ZW5jZS5fcyA9IGxvY2FsLmU7XG4gICAgdGhpcy5zZXF1ZW5jZS5fYyA9IGxvY2FsLnY7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgbG9jYWwgaW5zZXJ0aW9uIG9mIGEgY2hhcmFjdGVyIGluc2lkZSB0aGUgc2VxdWVuY2Ugc3RydWN0dXJlLiBJdFxuICogYnJvYWRjYXN0cyB0aGUgb3BlcmF0aW9uIHRvIHRoZSByZXN0IG9mIHRoZSBuZXR3b3JrLlxuICogXFxwYXJhbSBjaGFyYWN0ZXIgdGhlIGNoYXJhY3RlciB0byBpbnNlcnQgaW4gdGhlIHNlcXVlbmNlXG4gKiBcXHBhcmFtIGluZGV4IHRoZSBpbmRleCBpbiB0aGUgc2VxdWVuY2UgdG8gaW5zZXJ0XG4gKiBcXHJldHVybiB0aGUgaWRlbnRpZmllciBmcmVzaGx5IGFsbG9jYXRlZFxuICovXG5DcmF0ZUNvcmUucHJvdG90eXBlLmluc2VydCA9IGZ1bmN0aW9uKGNoYXJhY3RlciwgaW5kZXgpe1xuICAgIHZhciBlaSA9IHRoaXMuc2VxdWVuY2UuaW5zZXJ0KGNoYXJhY3RlciwgaW5kZXgpO1xuICAgIHZhciBpZCA9IHtfZTogZWkuX2kuX3NbZWkuX2kuX3MubGVuZ3RoLTFdLCBfYzogZWkuX2kuX2NbZWkuX2kuX2MubGVuZ3RoLTFdfTtcbiAgICB0aGlzLmJyb2FkY2FzdC5zZW5kKG5ldyBNSW5zZXJ0T3BlcmF0aW9uKGVpKSwgaWQsIG51bGwpO1xuICAgIHJldHVybiBlaTtcbn07XG5cbi8qIVxuICogXFxicmllZiBsb2NhbCBkZWxldGlvbiBvZiBhIGNoYXJhY3RlciBmcm9tIHRoZSBzZXF1ZW5jZSBzdHJ1Y3R1cmUuIEl0IFxuICogYnJvYWRjYXN0cyB0aGUgb3BlcmF0aW9uIHRvIHRoZSByZXN0IG9mIHRoZSBuZXR3b3JrLlxuICogXFxwYXJhbSBpbmRleCB0aGUgaW5kZXggb2YgdGhlIGVsZW1lbnQgdG8gcmVtb3ZlXG4gKiBcXHJldHVybiB0aGUgaWRlbnRpZmllciBmcmVzaGx5IHJlbW92ZWRcbiAqL1xuQ3JhdGVDb3JlLnByb3RvdHlwZS5yZW1vdmUgPSBmdW5jdGlvbihpbmRleCl7XG4gICAgdmFyIGkgPSB0aGlzLnNlcXVlbmNlLnJlbW92ZShpbmRleCk7XG4gICAgdmFyIGlzUmVhZHkgPSB7X2U6IGkuX3NbaS5fcy5sZW5ndGgtMV0sIF9jOiBpLl9jW2kuX2MubGVuZ3RoLTFdfTtcbiAgICB0aGlzLnNlcXVlbmNlLl9jICs9IDE7XG4gICAgdmFyIGlkID0ge19lOnRoaXMuc2VxdWVuY2UuX3MsIF9jOiB0aGlzLnNlcXVlbmNlLl9jIH0gLy8gKFRPRE8pIGZpeCB1Z2x5bmVzc1xuICAgIHRoaXMuYnJvYWRjYXN0LnNlbmQobmV3IE1SZW1vdmVPcGVyYXRpb24oaSksIGlkLCBpc1JlYWR5KTtcbiAgICByZXR1cm4gaTtcbn07XG5cbkNyYXRlQ29yZS5wcm90b3R5cGUuY2FyZXRNb3ZlZCA9IGZ1bmN0aW9uKGluZGV4KXtcbiAgICB2YXIgaXNSZWFkeSA9IHtcbiAgICBfZTogdGhpcy5zZXF1ZW5jZS5fcyxcbiAgICBfYzogdGhpcy5zZXF1ZW5jZS5fY1xuICAgIH07XG4gICAgdGhpcy5zZXF1ZW5jZS5fYyArPSAxO1xuICAgIHZhciBpZCA9IHtfZTp0aGlzLnNlcXVlbmNlLl9zLCBfYzogdGhpcy5zZXF1ZW5jZS5fYyB9IC8vIChUT0RPKSBmaXggdWdseW5lc3NcbiAgICB2YXIgcGFyYW0gPSB7XG4gICAgaW5kZXg6IGluZGV4LFxuICAgIGd1aWQgOiB0aGlzLnNlcXVlbmNlLl9zXG4gICAgfVxuICAgIHRoaXMuYnJvYWRjYXN0LnNlbmQobmV3IE1DYXJldE1vdmVkT3BlcmF0aW9uKHBhcmFtKSwgaWQsIGlzUmVhZHkpO1xuICAgIGNvbnNvbGUubG9nKFwiTUNhcmV0TW92ZWRPcGVyYXRpb24gc2VuZGVkXCIpO1xuICAgIHJldHVybiBpbmRleDtcbn07XG5cbi8qIVxuICogXFxicmllZiBpbnNlcnRpb24gb2YgYW4gZWxlbWVudCBmcm9tIGEgcmVtb3RlIHNpdGUuIEl0IGVtaXRzICdyZW1vdGVJbnNlcnQnIFxuICogd2l0aCB0aGUgaW5kZXggb2YgdGhlIGVsZW1lbnQgdG8gaW5zZXJ0LCAtMSBpZiBhbHJlYWR5IGV4aXN0aW5nLlxuICogXFxwYXJhbSBlaSB0aGUgcmVzdWx0IG9mIHRoZSByZW1vdGUgaW5zZXJ0IG9wZXJhdGlvblxuICovXG5DcmF0ZUNvcmUucHJvdG90eXBlLnJlbW90ZUluc2VydCA9IGZ1bmN0aW9uKGVpKXtcbiAgICB2YXIgaW5kZXggPSB0aGlzLnNlcXVlbmNlLmFwcGx5SW5zZXJ0KGVpLl9lLCBlaS5faSwgZmFsc2UpO1xuICAgIHRoaXMuZW1pdCgncmVtb3RlSW5zZXJ0JyxcbiAgICAgICAgICAgICAgZWkuX2UsXG4gICAgICAgICAgICAgIGluZGV4KTtcbiAgICAvLyAoVE9ETykgZml4IHRoZSBub0luZGV4IHRoaW5nXG4gICAgaWYgKGVpLl9pLl9zKXtcbiAgICAgIHRoaXMuZW1pdCgncmVtb3RlQ2FyZXRNb3ZlZCcsIGVpLl9pLl9zWzBdLCBpbmRleCk7XG4gICAgfWVsc2V7XG4gICAgLy8gYW50aS1lbnRyb3B5IGluc2VydCBtZXNzYWdlXG4gICAgdGhpcy5lbWl0KCdyZW1vdGVDYXJldE1vdmVkJywgZWkuX2kudC5zLCBpbmRleCk7XG4gICAgfVxufTtcblxuLyohXG4gKiBcXGJyaWVmIHJlbW92YWwgb2YgYW4gZWxlbWVudCBmcm9tIGEgcmVtb3RlIHNpdGUuICBJdCBlbWl0cyAncmVtb3RlUmVtb3ZlJ1xuICogd2l0aCB0aGUgaW5kZXggb2YgdGhlIGVsZW1lbnQgdG8gcmVtb3ZlLCAtMSBpZiBkb2VzIG5vdCBleGlzdFxuICogXFxwYXJhbSBpZCB0aGUgcmVzdWx0IG9mIHRoZSByZW1vdGUgaW5zZXJ0IG9wZXJhdGlvblxuICovXG5DcmF0ZUNvcmUucHJvdG90eXBlLnJlbW90ZVJlbW92ZSA9IGZ1bmN0aW9uKGlkKXtcbiAgICB2YXIgaW5kZXggPSB0aGlzLnNlcXVlbmNlLmFwcGx5UmVtb3ZlKGlkKTtcbiAgICB0aGlzLmVtaXQoJ3JlbW90ZVJlbW92ZScsIGluZGV4KTtcbiAgICBpZiAoaWQuX2kuX3Mpe1xuICAgIHRoaXMuZW1pdCgncmVtb3RlQ2FyZXRNb3ZlZCcsIGlkLl9zWzBdLCBpbmRleCAtIDEpO1xuICAgIH1lbHNle1xuICAgIC8vIGFudGktZW50cm9weSBpbnNlcnQgbWVzc2FnZVxuICAgIHRoaXMuZW1pdCgncmVtb3RlQ2FyZXRNb3ZlZCcsIGlkLnQucywgaW5kZXggLSAxKTtcbiAgICB9XG59O1xuXG5DcmF0ZUNvcmUucHJvdG90eXBlLnJlbW90ZUNhcmV0TW92ZWQgPSBmdW5jdGlvbihwYXJhbSl7XG4gICAgdGhpcy5lbWl0KCdyZW1vdGVDYXJldE1vdmVkJywgcGFyYW0uZ3VpZCwgcGFyYW0uaW5kZXgpO1xufTtcblxuXG4vKiFcbiAqIFxcYnJpZWYgc2VhcmNoIGEgc2V0IG9mIGVsZW1lbnRzIGluIG91ciBzZXF1ZW5jZSBhbmQgcmV0dXJuIHRoZW1cbiAqIFxccGFyYW0gdG9TZWFyY2ggdGhlIGFycmF5IG9mIGVsZW1lbnRzIHtfZSwgX2N9IHRvIHNlYXJjaFxuICogXFxyZXR1cm5zIGFuIGFycmF5IG9mIG5vZGVzXG4gKi9cbkNyYXRlQ29yZS5wcm90b3R5cGUuZ2V0RWxlbWVudHMgPSBmdW5jdGlvbih0b1NlYXJjaCl7XG4gICAgdmFyIHJlc3VsdCA9IFtdLCBmb3VuZCwgbm9kZSwgdGVtcE5vZGUsIGk9dGhpcy5zZXF1ZW5jZS5sZW5ndGgsIGo9MDtcbiAgICAvLyAoVE9ETykgaW1wcm92ZSByZXNlYXJjaCBieSBleHBsb2l0aW5nIHRoZSBmYWN0IHRoYXQgaWYgYSBub2RlIGlzXG4gICAgLy8gbWlzc2luZywgYWxsIGl0cyBjaGlsZHJlbiBhcmUgbWlzc2luZyB0b28uXG4gICAgLy8gKFRPRE8pIGltcHJvdmUgdGhlIHJldHVybmVkIHJlcHJlc2VudGF0aW9uOiBlaXRoZXIgYSB0cmVlIHRvIGZhY3Rvcml6ZVxuICAgIC8vIGNvbW1vbiBwYXJ0cyBvZiB0aGUgc3RydWN0dXJlIG9yIGlkZW50aWZpZXJzIHRvIGdldCB0aGUgcG9seWxvZyBzaXplXG4gICAgLy8gKFRPRE8pIGltcHJvdmUgdGhlIHNlYXJjaCBieSB1c2luZyB0aGUgZmFjdCB0aGF0IHRvU2VhcmNoIGlzIGEgc29ydGVkXG4gICAgLy8gYXJyYXksIHBvc3NpYmx5IHJlc3RydWN0dXJlIHRoaXMgYXJndW1lbnQgdG8gYmUgZXZlbiBtb3JlIGVmZmljaWVudFxuICAgIHdoaWxlICh0b1NlYXJjaC5sZW5ndGggPiAwICYmIGk8PXRoaXMuc2VxdWVuY2UubGVuZ3RoICYmIGk+MCl7XG4gICAgICAgIG5vZGUgPSB0aGlzLnNlcXVlbmNlLmdldChpKTtcbiAgICAgICAgdGVtcE5vZGUgPSBub2RlO1xuICAgICAgICB3aGlsZSggdGVtcE5vZGUuY2hpbGRyZW4ubGVuZ3RoID4gMCl7XG4gICAgICAgICAgICB0ZW1wTm9kZSA9IHRlbXBOb2RlLmNoaWxkcmVuWzBdO1xuICAgICAgICB9O1xuICAgICAgICBqID0gMDtcbiAgICAgICAgZm91bmQgPSBmYWxzZTtcbiAgICAgICAgd2hpbGUgKGogPCB0b1NlYXJjaC5sZW5ndGggJiYgIWZvdW5kKXtcbiAgICAgICAgICAgIGlmICh0ZW1wTm9kZS50LnMgPT09IHRvU2VhcmNoW2pdLl9lICYmXG4gICAgICAgICAgICAgICAgdGVtcE5vZGUudC5jID09PSB0b1NlYXJjaFtqXS5fYyl7XG4gICAgICAgICAgICAgICAgZm91bmQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJlc3VsdC5wdXNoKG5ldyBNQUVJbnNlcnRPcGVyYXRpb24oe19lOiB0ZW1wTm9kZS5lLCBfaTpub2RlfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtfZTogdG9TZWFyY2hbal0uX2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgX2M6IHRvU2VhcmNoW2pdLl9jfSApKTtcbiAgICAgICAgICAgICAgICB0b1NlYXJjaC5zcGxpY2UoaiwxKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgKytqO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfTtcbiAgICAgICAgLy8gICAgICAgICsraTtcbiAgICAgICAgLS1pO1xuICAgIH07XG4gICAgIHJldHVybiByZXN1bHQ7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IENyYXRlQ29yZTtcbiJdfQ==
