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
    this.deltaAntiEntropy = 1000*60*1/6; // (TODO) configurable
    this.unicast = new Unicast(this.source, this.name+'-unicast');
    
    this.buffer = [];
    
    var self = this;
    this.source.on(self.name+'-broadcast-receive', function(socket, message){
        self.receiveBroadcast(message);
    });
    this.unicast.on('receive', function(socket, message){
        self.receiveUnicast(socket, message);
    });
    setInterval(function(){
        self.unicast.send(new MAntiEntropyRequest(self.causality));
    }, this.deltaAntiEntropy);
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
        this.unicast.send(
            new MAntiEntropyResponse(causalityAtReceipt, messages),
            socket);
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
        // #1 considere each message in the response independantly
        for (var i = 0; i<message.elements.length; ++i){
            // #2 only check if the message has not been received yet
            if (!this.stopPropagation(message.elements[i])){
                this.causality.incrementFrom(message.elements[i].id);
                this.emit('receive', message.elements[i].payload);
            };
        };
        // #2 merge causality structures
        this.causality.merge(message.causality);
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

},{"./guid.js":4,"./messages":5,"./messages.js":5,"events":41,"unicast-definition":7,"util":59}],4:[function(require,module,exports){
module.exports=require(1)
},{"/Users/chat-wane/Desktop/project/crate-core/lib/guid.js":1}],5:[function(require,module,exports){

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
 * \param name the name of the protocol, default 'causal'
 * \param causality the causality structure
 * \param elements the elements to send
 */
function MAntiEntropyResponse(causality, elements){
    this.type = 'MAntiEntropyResponse';
    this.causality = causality;
    this.elements = elements;
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

},{"./messages":6,"events":41,"util":59}],8:[function(require,module,exports){
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
        currentPath.push(triple);
        if (currentNode.e!==null){
            self.root.add(new LSEQNode(currentPath, currentNode.e));
        };
        for (var i = 0; i<currentNode.children.length; ++i){
            depthFirst(currentNode.children[i], currentPath);
        };
    };
    for (var i = 0; i<object.root.children.length; ++i){
        depthFirst(object.root, []);
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
module.exports=require(1)
},{"/Users/chat-wane/Desktop/project/crate-core/lib/guid.js":1}],17:[function(require,module,exports){
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

},{}],18:[function(require,module,exports){
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

module.exports = PartialView;

},{"sorted-cmp-array":31}],19:[function(require,module,exports){
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

module.exports = Sockets;

},{"sorted-cmp-array":31}],20:[function(require,module,exports){
var EventEmitter = require('events').EventEmitter;
var Socket = require('simple-peer');
var util = require('util');

var PartialView = require('./partialview.js');
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
 * \brief get a set of neighbors
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

Spray.prototype.updateState = function(){
    if (this.partialView.length() > 0 && this.state !== 'connect'){
        this.state = 'connect';
        this.emit('statechange', 'connect');
    }
    if (this.partialView.length() === 0 && this.pending.length() > 0 &&
        this.state !== 'partial'){
        this.state = 'partial';
        this.emit('statechange', 'partial');
    };
    if (this.partialView.length() === 0 && this.pending.length() === 0 &&
        this.state !== 'disconnect'){
        this.state = 'disconnect';
        this.emit('statechange', 'disconnect');
    };
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
    });
    socket.on('data', function(receivedMessage){
        self.receive(socket, receivedMessage);
    });
    socket.on('stream', function(stream){
        self.emit('stream', socket, stream);
    });
    socket.on('close', function(){
        console.log('wrtc: a connection has been closed');
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
    });
    // #3 closed connection
    socket.on('close', function(){
        console.log('wrtc: a connection has been closed');
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

},{"./guid.js":16,"./messages.js":17,"./partialview.js":18,"./sockets.js":19,"events":41,"simple-peer":21,"util":59}],21:[function(require,module,exports){
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

}).call(this,require("buffer").Buffer)
},{"buffer":37,"debug":22,"hat":25,"inherits":26,"is-typedarray":27,"once":29,"stream":56,"typedarray-to-buffer":30}],22:[function(require,module,exports){

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

},{"./debug":23}],23:[function(require,module,exports){

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

},{"ms":24}],24:[function(require,module,exports){
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

},{}],25:[function(require,module,exports){
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

},{}],26:[function(require,module,exports){
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

},{}],27:[function(require,module,exports){
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

},{}],28:[function(require,module,exports){
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

},{}],29:[function(require,module,exports){
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

},{"wrappy":28}],30:[function(require,module,exports){
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
},{"buffer":37,"is-typedarray":27}],31:[function(require,module,exports){
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

},{"binary-search":32}],32:[function(require,module,exports){
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

},{}],33:[function(require,module,exports){
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


},{"./vvweentry.js":34,"sorted-cmp-array":35}],34:[function(require,module,exports){

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

},{}],35:[function(require,module,exports){
module.exports=require(31)
},{"/Users/chat-wane/Desktop/project/crate-core/node_modules/spray-wrtc/node_modules/sorted-cmp-array/index.js":31,"binary-search":36}],36:[function(require,module,exports){
module.exports=require(32)
},{"/Users/chat-wane/Desktop/project/crate-core/node_modules/spray-wrtc/node_modules/sorted-cmp-array/node_modules/binary-search/index.js":32}],37:[function(require,module,exports){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */

var base64 = require('base64-js')
var ieee754 = require('ieee754')
var isArray = require('is-array')

exports.Buffer = Buffer
exports.SlowBuffer = Buffer
exports.INSPECT_MAX_BYTES = 50
Buffer.poolSize = 8192 // not used by this implementation

var kMaxLength = 0x3fffffff

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Use Object implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * Note:
 *
 * - Implementation must support adding new properties to `Uint8Array` instances.
 *   Firefox 4-29 lacked support, fixed in Firefox 30+.
 *   See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438.
 *
 *  - Chrome 9-10 is missing the `TypedArray.prototype.subarray` function.
 *
 *  - IE10 has a broken `TypedArray.prototype.subarray` function which returns arrays of
 *    incorrect length in some situations.
 *
 * We detect these buggy browsers and set `Buffer.TYPED_ARRAY_SUPPORT` to `false` so they will
 * get the Object implementation, which is slower but will work correctly.
 */
Buffer.TYPED_ARRAY_SUPPORT = (function () {
  try {
    var buf = new ArrayBuffer(0)
    var arr = new Uint8Array(buf)
    arr.foo = function () { return 42 }
    return 42 === arr.foo() && // typed array instances can be augmented
        typeof arr.subarray === 'function' && // chrome 9-10 lack `subarray`
        new Uint8Array(1).subarray(1, 1).byteLength === 0 // ie10 has broken `subarray`
  } catch (e) {
    return false
  }
})()

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
function Buffer (subject, encoding, noZero) {
  if (!(this instanceof Buffer))
    return new Buffer(subject, encoding, noZero)

  var type = typeof subject

  // Find the length
  var length
  if (type === 'number')
    length = subject > 0 ? subject >>> 0 : 0
  else if (type === 'string') {
    if (encoding === 'base64')
      subject = base64clean(subject)
    length = Buffer.byteLength(subject, encoding)
  } else if (type === 'object' && subject !== null) { // assume object is array-like
    if (subject.type === 'Buffer' && isArray(subject.data))
      subject = subject.data
    length = +subject.length > 0 ? Math.floor(+subject.length) : 0
  } else
    throw new TypeError('must start with number, buffer, array or string')

  if (this.length > kMaxLength)
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
      'size: 0x' + kMaxLength.toString(16) + ' bytes')

  var buf
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Preferred: Return an augmented `Uint8Array` instance for best performance
    buf = Buffer._augment(new Uint8Array(length))
  } else {
    // Fallback: Return THIS instance of Buffer (created by `new`)
    buf = this
    buf.length = length
    buf._isBuffer = true
  }

  var i
  if (Buffer.TYPED_ARRAY_SUPPORT && typeof subject.byteLength === 'number') {
    // Speed optimization -- use set if we're copying from a typed array
    buf._set(subject)
  } else if (isArrayish(subject)) {
    // Treat array-ish objects as a byte array
    if (Buffer.isBuffer(subject)) {
      for (i = 0; i < length; i++)
        buf[i] = subject.readUInt8(i)
    } else {
      for (i = 0; i < length; i++)
        buf[i] = ((subject[i] % 256) + 256) % 256
    }
  } else if (type === 'string') {
    buf.write(subject, 0, encoding)
  } else if (type === 'number' && !Buffer.TYPED_ARRAY_SUPPORT && !noZero) {
    for (i = 0; i < length; i++) {
      buf[i] = 0
    }
  }

  return buf
}

Buffer.isBuffer = function (b) {
  return !!(b != null && b._isBuffer)
}

Buffer.compare = function (a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b))
    throw new TypeError('Arguments must be Buffers')

  var x = a.length
  var y = b.length
  for (var i = 0, len = Math.min(x, y); i < len && a[i] === b[i]; i++) {}
  if (i !== len) {
    x = a[i]
    y = b[i]
  }
  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function (encoding) {
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

Buffer.concat = function (list, totalLength) {
  if (!isArray(list)) throw new TypeError('Usage: Buffer.concat(list[, length])')

  if (list.length === 0) {
    return new Buffer(0)
  } else if (list.length === 1) {
    return list[0]
  }

  var i
  if (totalLength === undefined) {
    totalLength = 0
    for (i = 0; i < list.length; i++) {
      totalLength += list[i].length
    }
  }

  var buf = new Buffer(totalLength)
  var pos = 0
  for (i = 0; i < list.length; i++) {
    var item = list[i]
    item.copy(buf, pos)
    pos += item.length
  }
  return buf
}

Buffer.byteLength = function (str, encoding) {
  var ret
  str = str + ''
  switch (encoding || 'utf8') {
    case 'ascii':
    case 'binary':
    case 'raw':
      ret = str.length
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = str.length * 2
      break
    case 'hex':
      ret = str.length >>> 1
      break
    case 'utf8':
    case 'utf-8':
      ret = utf8ToBytes(str).length
      break
    case 'base64':
      ret = base64ToBytes(str).length
      break
    default:
      ret = str.length
  }
  return ret
}

// pre-set for values that may exist in the future
Buffer.prototype.length = undefined
Buffer.prototype.parent = undefined

// toString(encoding, start=0, end=buffer.length)
Buffer.prototype.toString = function (encoding, start, end) {
  var loweredCase = false

  start = start >>> 0
  end = end === undefined || end === Infinity ? this.length : end >>> 0

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
        if (loweredCase)
          throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.equals = function (b) {
  if(!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  if (this.length > 0) {
    str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
    if (this.length > max)
      str += ' ... '
  }
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  return Buffer.compare(this, b)
}

// `get` will be removed in Node 0.13+
Buffer.prototype.get = function (offset) {
  console.log('.get() is deprecated. Access using array indexes instead.')
  return this.readUInt8(offset)
}

// `set` will be removed in Node 0.13+
Buffer.prototype.set = function (v, offset) {
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
    var byte = parseInt(string.substr(i * 2, 2), 16)
    if (isNaN(byte)) throw new Error('Invalid hex string')
    buf[offset + i] = byte
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  var charsWritten = blitBuffer(utf8ToBytes(string), buf, offset, length)
  return charsWritten
}

function asciiWrite (buf, string, offset, length) {
  var charsWritten = blitBuffer(asciiToBytes(string), buf, offset, length)
  return charsWritten
}

function binaryWrite (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  var charsWritten = blitBuffer(base64ToBytes(string), buf, offset, length)
  return charsWritten
}

function utf16leWrite (buf, string, offset, length) {
  var charsWritten = blitBuffer(utf16leToBytes(string), buf, offset, length)
  return charsWritten
}

Buffer.prototype.write = function (string, offset, length, encoding) {
  // Support both (string, offset, length, encoding)
  // and the legacy (string, encoding, offset, length)
  if (isFinite(offset)) {
    if (!isFinite(length)) {
      encoding = length
      length = undefined
    }
  } else {  // legacy
    var swap = encoding
    encoding = offset
    offset = length
    length = swap
  }

  offset = Number(offset) || 0
  var remaining = this.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }
  encoding = String(encoding || 'utf8').toLowerCase()

  var ret
  switch (encoding) {
    case 'hex':
      ret = hexWrite(this, string, offset, length)
      break
    case 'utf8':
    case 'utf-8':
      ret = utf8Write(this, string, offset, length)
      break
    case 'ascii':
      ret = asciiWrite(this, string, offset, length)
      break
    case 'binary':
      ret = binaryWrite(this, string, offset, length)
      break
    case 'base64':
      ret = base64Write(this, string, offset, length)
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = utf16leWrite(this, string, offset, length)
      break
    default:
      throw new TypeError('Unknown encoding: ' + encoding)
  }
  return ret
}

Buffer.prototype.toJSON = function () {
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
  var res = ''
  var tmp = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    if (buf[i] <= 0x7F) {
      res += decodeUtf8Char(tmp) + String.fromCharCode(buf[i])
      tmp = ''
    } else {
      tmp += '%' + buf[i].toString(16)
    }
  }

  return res + decodeUtf8Char(tmp)
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function binarySlice (buf, start, end) {
  return asciiSlice(buf, start, end)
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

Buffer.prototype.slice = function (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len;
    if (start < 0)
      start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0)
      end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start)
    end = start

  if (Buffer.TYPED_ARRAY_SUPPORT) {
    return Buffer._augment(this.subarray(start, end))
  } else {
    var sliceLen = end - start
    var newBuf = new Buffer(sliceLen, undefined, true)
    for (var i = 0; i < sliceLen; i++) {
      newBuf[i] = this[i + start]
    }
    return newBuf
  }
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0)
    throw new RangeError('offset is not uint')
  if (offset + ext > length)
    throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUInt8 = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
      ((this[offset + 1] << 16) |
      (this[offset + 2] << 8) |
      this[offset + 3])
}

Buffer.prototype.readInt8 = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80))
    return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)

  return (this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16) |
      (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
      (this[offset + 1] << 16) |
      (this[offset + 2] << 8) |
      (this[offset + 3])
}

Buffer.prototype.readFloatLE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function (offset, noAssert) {
  if (!noAssert)
    checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('buffer must be a Buffer instance')
  if (value > max || value < min) throw new TypeError('value is out of bounds')
  if (offset + ext > buf.length) throw new TypeError('index out of range')
}

Buffer.prototype.writeUInt8 = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 1, 0xff, 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  this[offset] = value
  return offset + 1
}

function objectWriteUInt16 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 2); i < j; i++) {
    buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>>
      (littleEndian ? i : 1 - i) * 8
  }
}

Buffer.prototype.writeUInt16LE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = value
    this[offset + 1] = (value >>> 8)
  } else objectWriteUInt16(this, value, offset, true)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = value
  } else objectWriteUInt16(this, value, offset, false)
  return offset + 2
}

function objectWriteUInt32 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffffffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 4); i < j; i++) {
    buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff
  }
}

Buffer.prototype.writeUInt32LE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset + 3] = (value >>> 24)
    this[offset + 2] = (value >>> 16)
    this[offset + 1] = (value >>> 8)
    this[offset] = value
  } else objectWriteUInt32(this, value, offset, true)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = value
  } else objectWriteUInt32(this, value, offset, false)
  return offset + 4
}

Buffer.prototype.writeInt8 = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  if (value < 0) value = 0xff + value + 1
  this[offset] = value
  return offset + 1
}

Buffer.prototype.writeInt16LE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = value
    this[offset + 1] = (value >>> 8)
  } else objectWriteUInt16(this, value, offset, true)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = value
  } else objectWriteUInt16(this, value, offset, false)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = value
    this[offset + 1] = (value >>> 8)
    this[offset + 2] = (value >>> 16)
    this[offset + 3] = (value >>> 24)
  } else objectWriteUInt32(this, value, offset, true)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert)
    checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = value
  } else objectWriteUInt32(this, value, offset, false)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (value > max || value < min) throw new TypeError('value is out of bounds')
  if (offset + ext > buf.length) throw new TypeError('index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert)
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert)
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function (target, target_start, start, end) {
  var source = this

  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (!target_start) target_start = 0

  // Copy 0 bytes; we're done
  if (end === start) return
  if (target.length === 0 || source.length === 0) return

  // Fatal error conditions
  if (end < start) throw new TypeError('sourceEnd < sourceStart')
  if (target_start < 0 || target_start >= target.length)
    throw new TypeError('targetStart out of bounds')
  if (start < 0 || start >= source.length) throw new TypeError('sourceStart out of bounds')
  if (end < 0 || end > source.length) throw new TypeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length)
    end = this.length
  if (target.length - target_start < end - start)
    end = target.length - target_start + start

  var len = end - start

  if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
    for (var i = 0; i < len; i++) {
      target[i + target_start] = this[i + start]
    }
  } else {
    target._set(this.subarray(start, start + len), target_start)
  }
}

// fill(value, start=0, end=buffer.length)
Buffer.prototype.fill = function (value, start, end) {
  if (!value) value = 0
  if (!start) start = 0
  if (!end) end = this.length

  if (end < start) throw new TypeError('end < start')

  // Fill 0 bytes; we're done
  if (end === start) return
  if (this.length === 0) return

  if (start < 0 || start >= this.length) throw new TypeError('start out of bounds')
  if (end < 0 || end > this.length) throw new TypeError('end out of bounds')

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
Buffer.prototype.toArrayBuffer = function () {
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
Buffer._augment = function (arr) {
  arr.constructor = Buffer
  arr._isBuffer = true

  // save reference to original Uint8Array get/set methods before overwriting
  arr._get = arr.get
  arr._set = arr.set

  // deprecated, will be removed in node 0.13+
  arr.get = BP.get
  arr.set = BP.set

  arr.write = BP.write
  arr.toString = BP.toString
  arr.toLocaleString = BP.toString
  arr.toJSON = BP.toJSON
  arr.equals = BP.equals
  arr.compare = BP.compare
  arr.copy = BP.copy
  arr.slice = BP.slice
  arr.readUInt8 = BP.readUInt8
  arr.readUInt16LE = BP.readUInt16LE
  arr.readUInt16BE = BP.readUInt16BE
  arr.readUInt32LE = BP.readUInt32LE
  arr.readUInt32BE = BP.readUInt32BE
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
  arr.writeUInt16LE = BP.writeUInt16LE
  arr.writeUInt16BE = BP.writeUInt16BE
  arr.writeUInt32LE = BP.writeUInt32LE
  arr.writeUInt32BE = BP.writeUInt32BE
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

var INVALID_BASE64_RE = /[^+\/0-9A-z]/g

function base64clean (str) {
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = stringtrim(str).replace(INVALID_BASE64_RE, '')
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

function isArrayish (subject) {
  return isArray(subject) || Buffer.isBuffer(subject) ||
      subject && typeof subject === 'object' &&
      typeof subject.length === 'number'
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    var b = str.charCodeAt(i)
    if (b <= 0x7F) {
      byteArray.push(b)
    } else {
      var start = i
      if (b >= 0xD800 && b <= 0xDFFF) i++
      var h = encodeURIComponent(str.slice(start, i+1)).substr(1).split('%')
      for (var j = 0; j < h.length; j++) {
        byteArray.push(parseInt(h[j], 16))
      }
    }
  }
  return byteArray
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(str)
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; i++) {
    if ((i + offset >= dst.length) || (i >= src.length))
      break
    dst[i + offset] = src[i]
  }
  return i
}

function decodeUtf8Char (str) {
  try {
    return decodeURIComponent(str)
  } catch (err) {
    return String.fromCharCode(0xFFFD) // UTF 8 invalid char
  }
}

},{"base64-js":38,"ieee754":39,"is-array":40}],38:[function(require,module,exports){
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

	function decode (elt) {
		var code = elt.charCodeAt(0)
		if (code === PLUS)
			return 62 // '+'
		if (code === SLASH)
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

},{}],39:[function(require,module,exports){
exports.read = function(buffer, offset, isLE, mLen, nBytes) {
  var e, m,
      eLen = nBytes * 8 - mLen - 1,
      eMax = (1 << eLen) - 1,
      eBias = eMax >> 1,
      nBits = -7,
      i = isLE ? (nBytes - 1) : 0,
      d = isLE ? -1 : 1,
      s = buffer[offset + i];

  i += d;

  e = s & ((1 << (-nBits)) - 1);
  s >>= (-nBits);
  nBits += eLen;
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8);

  m = e & ((1 << (-nBits)) - 1);
  e >>= (-nBits);
  nBits += mLen;
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8);

  if (e === 0) {
    e = 1 - eBias;
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity);
  } else {
    m = m + Math.pow(2, mLen);
    e = e - eBias;
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
};

exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c,
      eLen = nBytes * 8 - mLen - 1,
      eMax = (1 << eLen) - 1,
      eBias = eMax >> 1,
      rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0),
      i = isLE ? 0 : (nBytes - 1),
      d = isLE ? 1 : -1,
      s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0;

  value = Math.abs(value);

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0;
    e = eMax;
  } else {
    e = Math.floor(Math.log(value) / Math.LN2);
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--;
      c *= 2;
    }
    if (e + eBias >= 1) {
      value += rt / c;
    } else {
      value += rt * Math.pow(2, 1 - eBias);
    }
    if (value * c >= 2) {
      e++;
      c /= 2;
    }

    if (e + eBias >= eMax) {
      m = 0;
      e = eMax;
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen);
      e = e + eBias;
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
      e = 0;
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8);

  e = (e << mLen) | m;
  eLen += mLen;
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8);

  buffer[offset + i - d] |= s * 128;
};

},{}],40:[function(require,module,exports){

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

},{}],41:[function(require,module,exports){
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

},{}],42:[function(require,module,exports){
module.exports=require(26)
},{"/Users/chat-wane/Desktop/project/crate-core/node_modules/spray-wrtc/node_modules/simple-peer/node_modules/inherits/inherits_browser.js":26}],43:[function(require,module,exports){
module.exports = Array.isArray || function (arr) {
  return Object.prototype.toString.call(arr) == '[object Array]';
};

},{}],44:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
    && window.setImmediate;
    var canMutationObserver = typeof window !== 'undefined'
    && window.MutationObserver;
    var canPost = typeof window !== 'undefined'
    && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return function (f) { return window.setImmediate(f) };
    }

    var queue = [];

    if (canMutationObserver) {
        var hiddenDiv = document.createElement("div");
        var observer = new MutationObserver(function () {
            var queueList = queue.slice();
            queue.length = 0;
            queueList.forEach(function (fn) {
                fn();
            });
        });

        observer.observe(hiddenDiv, { attributes: true });

        return function nextTick(fn) {
            if (!queue.length) {
                hiddenDiv.setAttribute('yes', 'no');
            }
            queue.push(fn);
        };
    }

    if (canPost) {
        window.addEventListener('message', function (ev) {
            var source = ev.source;
            if ((source === window || source === null) && ev.data === 'process-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('process-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

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

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

},{}],45:[function(require,module,exports){
module.exports = require("./lib/_stream_duplex.js")

},{"./lib/_stream_duplex.js":46}],46:[function(require,module,exports){
(function (process){
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

// a duplex stream is just a stream that is both readable and writable.
// Since JS doesn't have multiple prototypal inheritance, this class
// prototypally inherits from Readable, and then parasitically from
// Writable.

module.exports = Duplex;

/*<replacement>*/
var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) keys.push(key);
  return keys;
}
/*</replacement>*/


/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

var Readable = require('./_stream_readable');
var Writable = require('./_stream_writable');

util.inherits(Duplex, Readable);

forEach(objectKeys(Writable.prototype), function(method) {
  if (!Duplex.prototype[method])
    Duplex.prototype[method] = Writable.prototype[method];
});

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
  process.nextTick(this.end.bind(this));
}

function forEach (xs, f) {
  for (var i = 0, l = xs.length; i < l; i++) {
    f(xs[i], i);
  }
}

}).call(this,require('_process'))
},{"./_stream_readable":48,"./_stream_writable":50,"_process":44,"core-util-is":51,"inherits":42}],47:[function(require,module,exports){
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

// a passthrough stream.
// basically just the most minimal sort of Transform stream.
// Every written chunk gets output as-is.

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

},{"./_stream_transform":49,"core-util-is":51,"inherits":42}],48:[function(require,module,exports){
(function (process){
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

module.exports = Readable;

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

var Stream = require('stream');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

var StringDecoder;

util.inherits(Readable, Stream);

function ReadableState(options, stream) {
  options = options || {};

  // the point at which it stops calling _read() to fill the buffer
  // Note: 0 is a valid value, means "don't call _read preemptively ever"
  var hwm = options.highWaterMark;
  this.highWaterMark = (hwm || hwm === 0) ? hwm : 16 * 1024;

  // cast to ints.
  this.highWaterMark = ~~this.highWaterMark;

  this.buffer = [];
  this.length = 0;
  this.pipes = null;
  this.pipesCount = 0;
  this.flowing = false;
  this.ended = false;
  this.endEmitted = false;
  this.reading = false;

  // In streams that never have any data, and do push(null) right away,
  // the consumer can miss the 'end' event if they do some I/O before
  // consuming the stream.  So, we don't emit('end') until some reading
  // happens.
  this.calledRead = false;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, becuase any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // whenever we return null, then we set a flag to say
  // that we're awaiting a 'readable' event emission.
  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;


  // object stream flag. Used to make read(n) ignore n and to
  // make all the buffer merging and length checks go away
  this.objectMode = !!options.objectMode;

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
  if (!(this instanceof Readable))
    return new Readable(options);

  this._readableState = new ReadableState(options, this);

  // legacy
  this.readable = true;

  Stream.call(this);
}

// Manually shove something into the read() buffer.
// This returns true if the highWaterMark has not been hit yet,
// similar to how Writable.write() returns true if you should
// write() some more.
Readable.prototype.push = function(chunk, encoding) {
  var state = this._readableState;

  if (typeof chunk === 'string' && !state.objectMode) {
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

function readableAddChunk(stream, state, chunk, encoding, addToFront) {
  var er = chunkInvalid(state, chunk);
  if (er) {
    stream.emit('error', er);
  } else if (chunk === null || chunk === undefined) {
    state.reading = false;
    if (!state.ended)
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

      // update the buffer info.
      state.length += state.objectMode ? 1 : chunk.length;
      if (addToFront) {
        state.buffer.unshift(chunk);
      } else {
        state.reading = false;
        state.buffer.push(chunk);
      }

      if (state.needReadable)
        emitReadable(stream);

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
    } else
      return state.length;
  }

  return n;
}

// you can override either this method, or the async _read(n) below.
Readable.prototype.read = function(n) {
  var state = this._readableState;
  state.calledRead = true;
  var nOrig = n;
  var ret;

  if (typeof n !== 'number' || n > 0)
    state.emittedReadable = false;

  // if we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.
  if (n === 0 &&
      state.needReadable &&
      (state.length >= state.highWaterMark || state.ended)) {
    emitReadable(this);
    return null;
  }

  n = howMuchToRead(n, state);

  // if we've ended, and we're now clear, then finish it up.
  if (n === 0 && state.ended) {
    ret = null;

    // In cases where the decoder did not receive enough data
    // to produce a full chunk, then immediately received an
    // EOF, state.buffer will contain [<Buffer >, <Buffer 00 ...>].
    // howMuchToRead will see this and coerce the amount to
    // read to zero (because it's looking at the length of the
    // first <Buffer > in state.buffer), and we'll end up here.
    //
    // This can only happen via state.decoder -- no other venue
    // exists for pushing a zero-length chunk into state.buffer
    // and triggering this behavior. In this case, we return our
    // remaining data and end the stream, if appropriate.
    if (state.length > 0 && state.decoder) {
      ret = fromList(n, state);
      state.length -= ret.length;
    }

    if (state.length === 0)
      endReadable(this);

    return ret;
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

  // if we currently have less than the highWaterMark, then also read some
  if (state.length - n <= state.highWaterMark)
    doRead = true;

  // however, if we've ended, then there's no point, and if we're already
  // reading, then it's unnecessary.
  if (state.ended || state.reading)
    doRead = false;

  if (doRead) {
    state.reading = true;
    state.sync = true;
    // if the length is currently zero, then we *need* a readable event.
    if (state.length === 0)
      state.needReadable = true;
    // call internal read method
    this._read(state.highWaterMark);
    state.sync = false;
  }

  // If _read called its callback synchronously, then `reading`
  // will be false, and we need to re-evaluate how much data we
  // can return to the user.
  if (doRead && !state.reading)
    n = howMuchToRead(nOrig, state);

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

  // If we happened to read() exactly the remaining amount in the
  // buffer, and the EOF has been seen at this point, then make sure
  // that we emit 'end' on the very next tick.
  if (state.ended && !state.endEmitted && state.length === 0)
    endReadable(this);

  return ret;
};

function chunkInvalid(state, chunk) {
  var er = null;
  if (!Buffer.isBuffer(chunk) &&
      'string' !== typeof chunk &&
      chunk !== null &&
      chunk !== undefined &&
      !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  return er;
}


function onEofChunk(stream, state) {
  if (state.decoder && !state.ended) {
    var chunk = state.decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;

  // if we've ended and we have some data left, then emit
  // 'readable' now to make sure it gets picked up.
  if (state.length > 0)
    emitReadable(stream);
  else
    endReadable(stream);
}

// Don't emit readable right away in sync mode, because this can trigger
// another read() call => stack overflow.  This way, it might trigger
// a nextTick recursion warning, but that's not so bad.
function emitReadable(stream) {
  var state = stream._readableState;
  state.needReadable = false;
  if (state.emittedReadable)
    return;

  state.emittedReadable = true;
  if (state.sync)
    process.nextTick(function() {
      emitReadable_(stream);
    });
  else
    emitReadable_(stream);
}

function emitReadable_(stream) {
  stream.emit('readable');
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
    process.nextTick(function() {
      maybeReadMore_(stream, state);
    });
  }
}

function maybeReadMore_(stream, state) {
  var len = state.length;
  while (!state.reading && !state.flowing && !state.ended &&
         state.length < state.highWaterMark) {
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

  var doEnd = (!pipeOpts || pipeOpts.end !== false) &&
              dest !== process.stdout &&
              dest !== process.stderr;

  var endFn = doEnd ? onend : cleanup;
  if (state.endEmitted)
    process.nextTick(endFn);
  else
    src.once('end', endFn);

  dest.on('unpipe', onunpipe);
  function onunpipe(readable) {
    if (readable !== src) return;
    cleanup();
  }

  function onend() {
    dest.end();
  }

  // when the dest drains, it reduces the awaitDrain counter
  // on the source.  This would be more elegant with a .once()
  // handler in flow(), but adding and removing repeatedly is
  // too slow.
  var ondrain = pipeOnDrain(src);
  dest.on('drain', ondrain);

  function cleanup() {
    // cleanup event handlers once the pipe is broken
    dest.removeListener('close', onclose);
    dest.removeListener('finish', onfinish);
    dest.removeListener('drain', ondrain);
    dest.removeListener('error', onerror);
    dest.removeListener('unpipe', onunpipe);
    src.removeListener('end', onend);
    src.removeListener('end', cleanup);

    // if the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    // So, if this is awaiting a drain, then we just call it now.
    // If we don't know, then assume that we are waiting for one.
    if (!dest._writableState || dest._writableState.needDrain)
      ondrain();
  }

  // if the dest has an error, then stop piping into it.
  // however, don't suppress the throwing behavior for this.
  function onerror(er) {
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
    dest.removeListener('close', onclose);
    unpipe();
  }
  dest.once('finish', onfinish);

  function unpipe() {
    src.unpipe(dest);
  }

  // tell the dest that it's being piped to
  dest.emit('pipe', src);

  // start the flow if it hasn't been started already.
  if (!state.flowing) {
    // the handler that waits for readable events after all
    // the data gets sucked out in flow.
    // This would be easier to follow with a .once() handler
    // in flow(), but that is too slow.
    this.on('readable', pipeOnReadable);

    state.flowing = true;
    process.nextTick(function() {
      flow(src);
    });
  }

  return dest;
};

function pipeOnDrain(src) {
  return function() {
    var dest = this;
    var state = src._readableState;
    state.awaitDrain--;
    if (state.awaitDrain === 0)
      flow(src);
  };
}

function flow(src) {
  var state = src._readableState;
  var chunk;
  state.awaitDrain = 0;

  function write(dest, i, list) {
    var written = dest.write(chunk);
    if (false === written) {
      state.awaitDrain++;
    }
  }

  while (state.pipesCount && null !== (chunk = src.read())) {

    if (state.pipesCount === 1)
      write(state.pipes, 0, null);
    else
      forEach(state.pipes, write);

    src.emit('data', chunk);

    // if anyone needs a drain, then we have to wait for that.
    if (state.awaitDrain > 0)
      return;
  }

  // if every destination was unpiped, either before entering this
  // function, or in the while loop, then stop flowing.
  //
  // NB: This is a pretty rare edge case.
  if (state.pipesCount === 0) {
    state.flowing = false;

    // if there were data event listeners added, then switch to old mode.
    if (EE.listenerCount(src, 'data') > 0)
      emitDataEvents(src);
    return;
  }

  // at this point, no one needed a drain, so we just ran out of data
  // on the next readable event, start it over again.
  state.ranOut = true;
}

function pipeOnReadable() {
  if (this._readableState.ranOut) {
    this._readableState.ranOut = false;
    flow(this);
  }
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
    this.removeListener('readable', pipeOnReadable);
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
    this.removeListener('readable', pipeOnReadable);
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

  if (ev === 'data' && !this._readableState.flowing)
    emitDataEvents(this);

  if (ev === 'readable' && this.readable) {
    var state = this._readableState;
    if (!state.readableListening) {
      state.readableListening = true;
      state.emittedReadable = false;
      state.needReadable = true;
      if (!state.reading) {
        this.read(0);
      } else if (state.length) {
        emitReadable(this, state);
      }
    }
  }

  return res;
};
Readable.prototype.addListener = Readable.prototype.on;

// pause() and resume() are remnants of the legacy readable stream API
// If the user uses them, then switch into old mode.
Readable.prototype.resume = function() {
  emitDataEvents(this);
  this.read(0);
  this.emit('resume');
};

Readable.prototype.pause = function() {
  emitDataEvents(this, true);
  this.emit('pause');
};

function emitDataEvents(stream, startPaused) {
  var state = stream._readableState;

  if (state.flowing) {
    // https://github.com/isaacs/readable-stream/issues/16
    throw new Error('Cannot switch to old mode now.');
  }

  var paused = startPaused || false;
  var readable = false;

  // convert to an old-style stream.
  stream.readable = true;
  stream.pipe = Stream.prototype.pipe;
  stream.on = stream.addListener = Stream.prototype.on;

  stream.on('readable', function() {
    readable = true;

    var c;
    while (!paused && (null !== (c = stream.read())))
      stream.emit('data', c);

    if (c === null) {
      readable = false;
      stream._readableState.needReadable = true;
    }
  });

  stream.pause = function() {
    paused = true;
    this.emit('pause');
  };

  stream.resume = function() {
    paused = false;
    if (readable)
      process.nextTick(function() {
        stream.emit('readable');
      });
    else
      this.read(0);
    this.emit('resume');
  };

  // now make it start, just in case it hadn't already.
  stream.emit('readable');
}

// wrap an old-style stream as the async data source.
// This is *not* part of the readable stream interface.
// It is an ugly unfortunate mess of history.
Readable.prototype.wrap = function(stream) {
  var state = this._readableState;
  var paused = false;

  var self = this;
  stream.on('end', function() {
    if (state.decoder && !state.ended) {
      var chunk = state.decoder.end();
      if (chunk && chunk.length)
        self.push(chunk);
    }

    self.push(null);
  });

  stream.on('data', function(chunk) {
    if (state.decoder)
      chunk = state.decoder.write(chunk);

    // don't skip over falsy values in objectMode
    //if (state.objectMode && util.isNullOrUndefined(chunk))
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
    if (typeof stream[i] === 'function' &&
        typeof this[i] === 'undefined') {
      this[i] = function(method) { return function() {
        return stream[method].apply(stream, arguments);
      }}(i);
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

  if (!state.endEmitted && state.calledRead) {
    state.ended = true;
    process.nextTick(function() {
      // Check that we didn't get one last unshift.
      if (!state.endEmitted && state.length === 0) {
        state.endEmitted = true;
        stream.readable = false;
        stream.emit('end');
      }
    });
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
},{"_process":44,"buffer":37,"core-util-is":51,"events":41,"inherits":42,"isarray":43,"stream":56,"string_decoder/":57}],49:[function(require,module,exports){
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

module.exports = Transform;

var Duplex = require('./_stream_duplex');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

util.inherits(Transform, Duplex);


function TransformState(options, stream) {
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

  var ts = this._transformState = new TransformState(options, this);

  // when the writable side finishes, then flush out anything remaining.
  var stream = this;

  // start out asking for a readable event once data is transformed.
  this._readableState.needReadable = true;

  // we have implemented the _read method, and done the other things
  // that Readable wants before the first _read call, so unset the
  // sync guard flag.
  this._readableState.sync = false;

  this.once('finish', function() {
    if ('function' === typeof this._flush)
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
  var rs = stream._readableState;
  var ts = stream._transformState;

  if (ws.length)
    throw new Error('calling transform done when ws.length != 0');

  if (ts.transforming)
    throw new Error('calling transform done when still transforming');

  return stream.push(null);
}

},{"./_stream_duplex":46,"core-util-is":51,"inherits":42}],50:[function(require,module,exports){
(function (process){
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

// A bit simpler than readable streams.
// Implement an async ._write(chunk, cb), and it'll handle all
// the drain event emission and buffering.

module.exports = Writable;

/*<replacement>*/
var Buffer = require('buffer').Buffer;
/*</replacement>*/

Writable.WritableState = WritableState;


/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

var Stream = require('stream');

util.inherits(Writable, Stream);

function WriteReq(chunk, encoding, cb) {
  this.chunk = chunk;
  this.encoding = encoding;
  this.callback = cb;
}

function WritableState(options, stream) {
  options = options || {};

  // the point at which write() starts returning false
  // Note: 0 is a valid value, means that we always return false if
  // the entire buffer is not flushed immediately on write()
  var hwm = options.highWaterMark;
  this.highWaterMark = (hwm || hwm === 0) ? hwm : 16 * 1024;

  // object stream flag to indicate whether or not this stream
  // contains buffers or objects.
  this.objectMode = !!options.objectMode;

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

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, becuase any
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

  this.buffer = [];

  // True if the error was already emitted and should not be thrown again
  this.errorEmitted = false;
}

function Writable(options) {
  var Duplex = require('./_stream_duplex');

  // Writable ctor is applied to Duplexes, though they're not
  // instanceof Writable, they're instanceof Readable.
  if (!(this instanceof Writable) && !(this instanceof Duplex))
    return new Writable(options);

  this._writableState = new WritableState(options, this);

  // legacy.
  this.writable = true;

  Stream.call(this);
}

// Otherwise people can pipe Writable streams, which is just wrong.
Writable.prototype.pipe = function() {
  this.emit('error', new Error('Cannot pipe. Not readable.'));
};


function writeAfterEnd(stream, state, cb) {
  var er = new Error('write after end');
  // TODO: defer error events consistently everywhere, not just the cb
  stream.emit('error', er);
  process.nextTick(function() {
    cb(er);
  });
}

// If we get something that is not a buffer, string, null, or undefined,
// and we're not in objectMode, then that's an error.
// Otherwise stream chunks are all considered to be of length=1, and the
// watermarks determine how many objects to keep in the buffer, rather than
// how many bytes or characters.
function validChunk(stream, state, chunk, cb) {
  var valid = true;
  if (!Buffer.isBuffer(chunk) &&
      'string' !== typeof chunk &&
      chunk !== null &&
      chunk !== undefined &&
      !state.objectMode) {
    var er = new TypeError('Invalid non-string/buffer chunk');
    stream.emit('error', er);
    process.nextTick(function() {
      cb(er);
    });
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
    cb = function() {};

  if (state.ended)
    writeAfterEnd(this, state, cb);
  else if (validChunk(this, state, chunk, cb))
    ret = writeOrBuffer(this, state, chunk, encoding, cb);

  return ret;
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

  if (state.writing)
    state.buffer.push(new WriteReq(chunk, encoding, cb));
  else
    doWrite(stream, state, len, chunk, encoding, cb);

  return ret;
}

function doWrite(stream, state, len, chunk, encoding, cb) {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  stream._write(chunk, encoding, state.onwrite);
  state.sync = false;
}

function onwriteError(stream, state, sync, er, cb) {
  if (sync)
    process.nextTick(function() {
      cb(er);
    });
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
    var finished = needFinish(stream, state);

    if (!finished && !state.bufferProcessing && state.buffer.length)
      clearBuffer(stream, state);

    if (sync) {
      process.nextTick(function() {
        afterWrite(stream, state, finished, cb);
      });
    } else {
      afterWrite(stream, state, finished, cb);
    }
  }
}

function afterWrite(stream, state, finished, cb) {
  if (!finished)
    onwriteDrain(stream, state);
  cb();
  if (finished)
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

  for (var c = 0; c < state.buffer.length; c++) {
    var entry = state.buffer[c];
    var chunk = entry.chunk;
    var encoding = entry.encoding;
    var cb = entry.callback;
    var len = state.objectMode ? 1 : chunk.length;

    doWrite(stream, state, len, chunk, encoding, cb);

    // if we didn't call the onwrite immediately, then
    // it means that we need to wait until it does.
    // also, that means that the chunk and cb are currently
    // being processed, so move the buffer counter past them.
    if (state.writing) {
      c++;
      break;
    }
  }

  state.bufferProcessing = false;
  if (c < state.buffer.length)
    state.buffer = state.buffer.slice(c);
  else
    state.buffer.length = 0;
}

Writable.prototype._write = function(chunk, encoding, cb) {
  cb(new Error('not implemented'));
};

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

  if (typeof chunk !== 'undefined' && chunk !== null)
    this.write(chunk, encoding);

  // ignore unnecessary end() calls.
  if (!state.ending && !state.finished)
    endWritable(this, state, cb);
};


function needFinish(stream, state) {
  return (state.ending &&
          state.length === 0 &&
          !state.finished &&
          !state.writing);
}

function finishMaybe(stream, state) {
  var need = needFinish(stream, state);
  if (need) {
    state.finished = true;
    stream.emit('finish');
  }
  return need;
}

function endWritable(stream, state, cb) {
  state.ending = true;
  finishMaybe(stream, state);
  if (cb) {
    if (state.finished)
      process.nextTick(cb);
    else
      stream.once('finish', cb);
  }
  state.ended = true;
}

}).call(this,require('_process'))
},{"./_stream_duplex":46,"_process":44,"buffer":37,"core-util-is":51,"inherits":42,"stream":56}],51:[function(require,module,exports){
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
}).call(this,require("buffer").Buffer)
},{"buffer":37}],52:[function(require,module,exports){
module.exports = require("./lib/_stream_passthrough.js")

},{"./lib/_stream_passthrough.js":47}],53:[function(require,module,exports){
var Stream = require('stream'); // hack to fix a circular dependency issue when used with browserify
exports = module.exports = require('./lib/_stream_readable.js');
exports.Stream = Stream;
exports.Readable = exports;
exports.Writable = require('./lib/_stream_writable.js');
exports.Duplex = require('./lib/_stream_duplex.js');
exports.Transform = require('./lib/_stream_transform.js');
exports.PassThrough = require('./lib/_stream_passthrough.js');

},{"./lib/_stream_duplex.js":46,"./lib/_stream_passthrough.js":47,"./lib/_stream_readable.js":48,"./lib/_stream_transform.js":49,"./lib/_stream_writable.js":50,"stream":56}],54:[function(require,module,exports){
module.exports = require("./lib/_stream_transform.js")

},{"./lib/_stream_transform.js":49}],55:[function(require,module,exports){
module.exports = require("./lib/_stream_writable.js")

},{"./lib/_stream_writable.js":50}],56:[function(require,module,exports){
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

},{"events":41,"inherits":42,"readable-stream/duplex.js":45,"readable-stream/passthrough.js":52,"readable-stream/readable.js":53,"readable-stream/transform.js":54,"readable-stream/writable.js":55}],57:[function(require,module,exports){
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

},{"buffer":37}],58:[function(require,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],59:[function(require,module,exports){
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
},{"./support/isBuffer":58,"_process":44,"inherits":42}],"crate-core":[function(require,module,exports){
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
        };
    });
    // #B anti-entropy for the missing operation
    this.broadcast.on('antiEntropy', function(socket, remoteVVwE, localVVwE){
        /*var remoteVVwE = (new VVwE(null)).fromJSON(remoteVVwE); // cast
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
        var elements = self.getElements(toSearch);*/
        var elements = [];
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
    // (TODO)
    /* this.broadcast = new CausalBroadcast(new Spray(this.id, this.options),
                                         (new VVwE(this.id)).fromJSON(
                                             object.causality));
    this.sequence = (new LSEQTree(id)).fromJSON(object.sequence);*/
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

/*!
 * \brief insertion of an element from a remote site. It emits 'remoteInsert' 
 * with the index of the element to insert, -1 if already existing.
 * \param ei the result of the remote insert operation
 */
CrateCore.prototype.remoteInsert = function(ei){
    this.emit('remoteInsert',
              ei._e,
              this.sequence.applyInsert(ei._e, ei._i, true));
    // (TODO) fix the noIndex thing
};

/*!
 * \brief removal of an element from a remote site.  It emits 'remoteRemove'
 * with the index of the element to remove, -1 if does not exist
 * \param id the result of the remote insert operation
 */
CrateCore.prototype.remoteRemove = function(id){
    this.emit('remoteRemove', this.sequence.applyRemove(id));
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

},{"./guid.js":1,"./messages.js":2,"causal-broadcast-definition":3,"events":41,"lseqtree":11,"spray-wrtc":20,"util":59,"version-vector-with-exceptions":33}]},{},[])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXItcGFjay9fcHJlbHVkZS5qcyIsImxpYi9ndWlkLmpzIiwibGliL21lc3NhZ2VzLmpzIiwibm9kZV9tb2R1bGVzL2NhdXNhbC1icm9hZGNhc3QtZGVmaW5pdGlvbi9saWIvY2F1c2FsYnJvYWRjYXN0LmpzIiwibm9kZV9tb2R1bGVzL2NhdXNhbC1icm9hZGNhc3QtZGVmaW5pdGlvbi9saWIvbWVzc2FnZXMuanMiLCJub2RlX21vZHVsZXMvY2F1c2FsLWJyb2FkY2FzdC1kZWZpbml0aW9uL25vZGVfbW9kdWxlcy91bmljYXN0LWRlZmluaXRpb24vbGliL21lc3NhZ2VzLmpzIiwibm9kZV9tb2R1bGVzL2NhdXNhbC1icm9hZGNhc3QtZGVmaW5pdGlvbi9ub2RlX21vZHVsZXMvdW5pY2FzdC1kZWZpbml0aW9uL2xpYi91bmljYXN0LmpzIiwibm9kZV9tb2R1bGVzL2xzZXF0cmVlL2xpYi9iYXNlLmpzIiwibm9kZV9tb2R1bGVzL2xzZXF0cmVlL2xpYi9pZGVudGlmaWVyLmpzIiwibm9kZV9tb2R1bGVzL2xzZXF0cmVlL2xpYi9sc2Vxbm9kZS5qcyIsIm5vZGVfbW9kdWxlcy9sc2VxdHJlZS9saWIvbHNlcXRyZWUuanMiLCJub2RlX21vZHVsZXMvbHNlcXRyZWUvbGliL3N0cmF0ZWd5LmpzIiwibm9kZV9tb2R1bGVzL2xzZXF0cmVlL2xpYi90cmlwbGUuanMiLCJub2RlX21vZHVsZXMvbHNlcXRyZWUvbGliL3V0aWwuanMiLCJub2RlX21vZHVsZXMvbHNlcXRyZWUvbm9kZV9tb2R1bGVzL0JpZ0ludC9zcmMvQmlnSW50LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbGliL21lc3NhZ2VzLmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbGliL3BhcnRpYWx2aWV3LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbGliL3NvY2tldHMuanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9saWIvc3ByYXkuanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvc2ltcGxlLXBlZXIvaW5kZXguanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvc2ltcGxlLXBlZXIvbm9kZV9tb2R1bGVzL2RlYnVnL2Jyb3dzZXIuanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvc2ltcGxlLXBlZXIvbm9kZV9tb2R1bGVzL2RlYnVnL2RlYnVnLmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL3NpbXBsZS1wZWVyL25vZGVfbW9kdWxlcy9kZWJ1Zy9ub2RlX21vZHVsZXMvbXMvaW5kZXguanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvc2ltcGxlLXBlZXIvbm9kZV9tb2R1bGVzL2hhdC9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9zaW1wbGUtcGVlci9ub2RlX21vZHVsZXMvaW5oZXJpdHMvaW5oZXJpdHNfYnJvd3Nlci5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9zaW1wbGUtcGVlci9ub2RlX21vZHVsZXMvaXMtdHlwZWRhcnJheS9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9zaW1wbGUtcGVlci9ub2RlX21vZHVsZXMvb25jZS9ub2RlX21vZHVsZXMvd3JhcHB5L3dyYXBweS5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9zaW1wbGUtcGVlci9ub2RlX21vZHVsZXMvb25jZS9vbmNlLmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL3NpbXBsZS1wZWVyL25vZGVfbW9kdWxlcy90eXBlZGFycmF5LXRvLWJ1ZmZlci9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9zb3J0ZWQtY21wLWFycmF5L2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL3NvcnRlZC1jbXAtYXJyYXkvbm9kZV9tb2R1bGVzL2JpbmFyeS1zZWFyY2gvaW5kZXguanMiLCJub2RlX21vZHVsZXMvdmVyc2lvbi12ZWN0b3Itd2l0aC1leGNlcHRpb25zL2xpYi92dndlLmpzIiwibm9kZV9tb2R1bGVzL3ZlcnNpb24tdmVjdG9yLXdpdGgtZXhjZXB0aW9ucy9saWIvdnZ3ZWVudHJ5LmpzIiwiLi4vLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvYnVmZmVyL2luZGV4LmpzIiwiLi4vLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvYnVmZmVyL25vZGVfbW9kdWxlcy9iYXNlNjQtanMvbGliL2I2NC5qcyIsIi4uLy4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2J1ZmZlci9ub2RlX21vZHVsZXMvaWVlZTc1NC9pbmRleC5qcyIsIi4uLy4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2J1ZmZlci9ub2RlX21vZHVsZXMvaXMtYXJyYXkvaW5kZXguanMiLCIuLi8uLi8uLi8uLi8uLi91c3IvbG9jYWwvbGliL25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9ldmVudHMvZXZlbnRzLmpzIiwiLi4vLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvaXNhcnJheS9pbmRleC5qcyIsIi4uLy4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3Byb2Nlc3MvYnJvd3Nlci5qcyIsIi4uLy4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3JlYWRhYmxlLXN0cmVhbS9kdXBsZXguanMiLCIuLi8uLi8uLi8uLi8uLi91c3IvbG9jYWwvbGliL25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9yZWFkYWJsZS1zdHJlYW0vbGliL19zdHJlYW1fZHVwbGV4LmpzIiwiLi4vLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvcmVhZGFibGUtc3RyZWFtL2xpYi9fc3RyZWFtX3Bhc3N0aHJvdWdoLmpzIiwiLi4vLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvcmVhZGFibGUtc3RyZWFtL2xpYi9fc3RyZWFtX3JlYWRhYmxlLmpzIiwiLi4vLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvcmVhZGFibGUtc3RyZWFtL2xpYi9fc3RyZWFtX3RyYW5zZm9ybS5qcyIsIi4uLy4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3JlYWRhYmxlLXN0cmVhbS9saWIvX3N0cmVhbV93cml0YWJsZS5qcyIsIi4uLy4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3JlYWRhYmxlLXN0cmVhbS9ub2RlX21vZHVsZXMvY29yZS11dGlsLWlzL2xpYi91dGlsLmpzIiwiLi4vLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvcmVhZGFibGUtc3RyZWFtL3Bhc3N0aHJvdWdoLmpzIiwiLi4vLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvcmVhZGFibGUtc3RyZWFtL3JlYWRhYmxlLmpzIiwiLi4vLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvcmVhZGFibGUtc3RyZWFtL3RyYW5zZm9ybS5qcyIsIi4uLy4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3JlYWRhYmxlLXN0cmVhbS93cml0YWJsZS5qcyIsIi4uLy4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3N0cmVhbS1icm93c2VyaWZ5L2luZGV4LmpzIiwiLi4vLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvc3RyaW5nX2RlY29kZXIvaW5kZXguanMiLCIuLi8uLi8uLi8uLi8uLi91c3IvbG9jYWwvbGliL25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy91dGlsL3N1cHBvcnQvaXNCdWZmZXJCcm93c2VyLmpzIiwiLi4vLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvdXRpbC91dGlsLmpzIiwibGliL2NyYXRlLWNvcmUuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUN0TEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNYQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3RUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdPQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUM3Z0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3TUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzltQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25nQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeEtBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyTUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOURBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3pDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbkNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDakpBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7O0FDOURBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM2hDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4SEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDN1NBO0FBQ0E7QUFDQTtBQUNBOztBQ0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0RkE7QUFDQTs7QUNEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4OUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xOQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BZQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1R0E7QUFDQTs7QUNEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUkE7QUFDQTs7QUNEQTtBQUNBOztBQ0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3TkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0xBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVrQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCIvKlxuICogXFx1cmwgaHR0cHM6Ly9naXRodWIuY29tL2p1c3RheWFrL3l1dGlscy9ibG9iL21hc3Rlci95dXRpbHMuanNcbiAqIFxcYXV0aG9yIGp1c3RheWFrXG4gKi9cblxuLyohXG4gKiBcXGJyaWVmIGdldCBhIGdsb2JhbGx5IHVuaXF1ZSAod2l0aCBoaWdoIHByb2JhYmlsaXR5KSBpZGVudGlmaWVyXG4gKiBcXHJldHVybiBhIHN0cmluZyBiZWluZyB0aGUgaWRlbnRpZmllclxuICovXG5mdW5jdGlvbiBHVUlEKCl7XG4gICAgdmFyIGQgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKTtcbiAgICB2YXIgZ3VpZCA9ICd4eHh4eHh4eC14eHh4LTR4eHgteXh4eC14eHh4eHh4eHh4eHgnLnJlcGxhY2UoL1t4eV0vZywgZnVuY3Rpb24gKGMpIHtcbiAgICAgICAgdmFyIHIgPSAoZCArIE1hdGgucmFuZG9tKCkgKiAxNikgJSAxNiB8IDA7XG4gICAgICAgIGQgPSBNYXRoLmZsb29yKGQgLyAxNik7XG4gICAgICAgIHJldHVybiAoYyA9PT0gJ3gnID8gciA6IChyICYgMHgzIHwgMHg4KSkudG9TdHJpbmcoMTYpO1xuICAgIH0pO1xuICAgIHJldHVybiBndWlkO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBHVUlEO1xuIiwiLyohXG4gKiBcXGJyaWVmIG9iamVjdCB0aGF0IHJlcHJlc2VudHMgdGhlIHJlc3VsdCBvZiBhbiBpbnNlcnQgb3BlcmF0aW9uXG4gKiBcXHBhcmFtIGluc2VydCB0aGUgcmVzdWx0IG9mIHRoZSBsb2NhbCBpbnNlcnQgb3BlcmF0aW9uXG4gKi9cbmZ1bmN0aW9uIE1JbnNlcnRPcGVyYXRpb24oaW5zZXJ0KXtcbiAgICB0aGlzLnR5cGUgPSBcIk1JbnNlcnRPcGVyYXRpb25cIjtcbiAgICB0aGlzLmluc2VydCA9IGluc2VydDtcbn07XG5tb2R1bGUuZXhwb3J0cy5NSW5zZXJ0T3BlcmF0aW9uID0gTUluc2VydE9wZXJhdGlvbjtcblxuZnVuY3Rpb24gTUFFSW5zZXJ0T3BlcmF0aW9uKGluc2VydCwgaWQpe1xuICAgIHRoaXMudHlwZSA9IFwiTUFFSW5zZXJ0T3BlcmF0aW9uXCI7XG4gICAgdGhpcy5wYXlsb2FkID0gbmV3IE1JbnNlcnRPcGVyYXRpb24oaW5zZXJ0KTtcbiAgICB0aGlzLmlkID0gaWQ7XG4gICAgdGhpcy5pc1JlYWR5ID0gbnVsbDtcbn07XG5tb2R1bGUuZXhwb3J0cy5NQUVJbnNlcnRPcGVyYXRpb24gPSBNQUVJbnNlcnRPcGVyYXRpb247XG5cbi8qIVxuICogXFxicmllZiBvYmplY3QgdGhhdCByZXByZXNlbnRzIHRoZSByZXN1bHQgb2YgYSBkZWxldGUgb3BlcmF0aW9uXG4gKiBcXHBhcmFtIHJlbW92ZSB0aGUgcmVzdWx0IG9mIHRoZSBsb2NhbCBkZWxldGUgb3BlcmF0aW9uXG4gKi9cbmZ1bmN0aW9uIE1SZW1vdmVPcGVyYXRpb24ocmVtb3ZlKXtcbiAgICB0aGlzLnR5cGUgPSBcIk1SZW1vdmVPcGVyYXRpb25cIjtcbiAgICB0aGlzLnJlbW92ZSA9IHJlbW92ZTtcbn07XG5tb2R1bGUuZXhwb3J0cy5NUmVtb3ZlT3BlcmF0aW9uID0gTVJlbW92ZU9wZXJhdGlvbjtcbiIsInZhciBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKS5FdmVudEVtaXR0ZXI7XG52YXIgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcbnZhciBHVUlEID0gcmVxdWlyZSgnLi9ndWlkLmpzJyk7XG5cbnZhciBNQnJvYWRjYXN0ID0gcmVxdWlyZSgnLi9tZXNzYWdlcycpLk1Ccm9hZGNhc3Q7XG52YXIgTUFudGlFbnRyb3B5UmVxdWVzdCA9IHJlcXVpcmUoJy4vbWVzc2FnZXMuanMnKS5NQW50aUVudHJvcHlSZXF1ZXN0O1xudmFyIE1BbnRpRW50cm9weVJlc3BvbnNlID0gcmVxdWlyZSgnLi9tZXNzYWdlcy5qcycpLk1BbnRpRW50cm9weVJlc3BvbnNlO1xuXG52YXIgVW5pY2FzdCA9IHJlcXVpcmUoJ3VuaWNhc3QtZGVmaW5pdGlvbicpO1xuXG51dGlsLmluaGVyaXRzKENhdXNhbEJyb2FkY2FzdCwgRXZlbnRFbWl0dGVyKTtcblxuLyohXG4gKiBJdCB0YWtlcyBhIHVuaXF1ZSB2YWx1ZSBmb3IgcGVlciBhbmQgYSBjb3VudGVyIHRvIGRpc3Rpbmd1aXNoIGEgbWVzc2FnZS4gSXRcbiAqIGVtaXRzICdyZWNlaXZlJyBldmVudCB3aGVuIHRoZSBtZXNzYWdlIGlzIGNvbnNpZGVyZWQgcmVhZHlcbiAqIFxccGFyYW0gc291cmNlIHRoZSBwcm90b2NvbCByZWNlaXZpbmcgdGhlIG1lc3NhZ2VzXG4gKiBcXHBhcmFtIGNhdXNhbGl0eSB0aGUgY2F1c2FsaXR5IHRyYWNraW5nIHN0cnVjdHVyZVxuICovXG5mdW5jdGlvbiBDYXVzYWxCcm9hZGNhc3Qoc291cmNlLCBjYXVzYWxpdHksIG5hbWUpIHtcbiAgICBFdmVudEVtaXR0ZXIuY2FsbCh0aGlzKTtcbiAgICB0aGlzLm5hbWUgPSBuYW1lIHx8ICdjYXVzYWwnO1xuICAgIHRoaXMuc291cmNlID0gc291cmNlO1xuICAgIHRoaXMuY2F1c2FsaXR5ID0gY2F1c2FsaXR5O1xuICAgIHRoaXMuZGVsdGFBbnRpRW50cm9weSA9IDEwMDAqNjAqMS82OyAvLyAoVE9ETykgY29uZmlndXJhYmxlXG4gICAgdGhpcy51bmljYXN0ID0gbmV3IFVuaWNhc3QodGhpcy5zb3VyY2UsIHRoaXMubmFtZSsnLXVuaWNhc3QnKTtcbiAgICBcbiAgICB0aGlzLmJ1ZmZlciA9IFtdO1xuICAgIFxuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICB0aGlzLnNvdXJjZS5vbihzZWxmLm5hbWUrJy1icm9hZGNhc3QtcmVjZWl2ZScsIGZ1bmN0aW9uKHNvY2tldCwgbWVzc2FnZSl7XG4gICAgICAgIHNlbGYucmVjZWl2ZUJyb2FkY2FzdChtZXNzYWdlKTtcbiAgICB9KTtcbiAgICB0aGlzLnVuaWNhc3Qub24oJ3JlY2VpdmUnLCBmdW5jdGlvbihzb2NrZXQsIG1lc3NhZ2Upe1xuICAgICAgICBzZWxmLnJlY2VpdmVVbmljYXN0KHNvY2tldCwgbWVzc2FnZSk7XG4gICAgfSk7XG4gICAgc2V0SW50ZXJ2YWwoZnVuY3Rpb24oKXtcbiAgICAgICAgc2VsZi51bmljYXN0LnNlbmQobmV3IE1BbnRpRW50cm9weVJlcXVlc3Qoc2VsZi5jYXVzYWxpdHkpKTtcbiAgICB9LCB0aGlzLmRlbHRhQW50aUVudHJvcHkpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGJyb2FkY2FzdCB0aGUgbWVzc2FnZSB0byBhbGwgcGFydGljaXBhbnRzXG4gKiBcXHBhcmFtIG1lc3NhZ2UgdGhlIG1lc3NhZ2UgdG8gYnJvYWRjYXN0XG4gKiBcXHBhcmFtIGlkIHRoZSBpZCBvZiB0aGUgbWVzc2FnZVxuICogXFxwYXJhbSBpc1JlYWR5IHRoZSBpZChzKSB0aGF0IG11c3QgZXhpc3QgdG8gZGVsaXZlciB0aGUgbWVzc2FnZVxuICovXG5DYXVzYWxCcm9hZGNhc3QucHJvdG90eXBlLnNlbmQgPSBmdW5jdGlvbihtZXNzYWdlLCBpZCwgaXNSZWFkeSl7XG4gICAgLy8gIzEgZ2V0IHRoZSBuZWlnaGJvcmhvb2QgYW5kIGNyZWF0ZSB0aGUgbWVzc2FnZVxuICAgIHZhciBsaW5rcyA9IHRoaXMuc291cmNlLmdldFBlZXJzKE51bWJlci5NQVhfVkFMVUUpO1xuICAgIHZhciBtQnJvYWRjYXN0ID0gbmV3IE1Ccm9hZGNhc3QodGhpcy5uYW1lLCBpZCB8fCBHVUlEKCksIGlzUmVhZHksIG1lc3NhZ2UpO1xuICAgIC8vICMyIHJlZ2lzdGVyIHRoZSBtZXNzYWdlIGluIHRoZSBzdHJ1Y3R1cmVcbiAgICB0aGlzLmNhdXNhbGl0eS5pbmNyZW1lbnRGcm9tKGlkKTtcbiAgICAvLyAjMyBzZW5kIHRoZSBtZXNzYWdlIHRvIHRoZSBuZWlnaGJvcmhvb2RcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxpbmtzLmxlbmd0aDsgKytpKXtcbiAgICAgICAgaWYgKGxpbmtzW2ldLmNvbm5lY3RlZCAmJlxuICAgICAgICAgICAgbGlua3NbaV0uX2NoYW5uZWwgJiYgbGlua3NbaV0uX2NoYW5uZWwucmVhZHlTdGF0ZT09PSdvcGVuJyl7XG4gICAgICAgICAgICBsaW5rc1tpXS5zZW5kKG1Ccm9hZGNhc3QpO1xuICAgICAgICB9O1xuICAgIH07XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgYW5zd2VycyB0byBhbiBhbnRpZW50cm9weSByZXF1ZXN0IG1lc3NhZ2Ugd2l0aCB0aGUgbWlzc2luZyBlbGVtZW50c1xuICogXFxwYXJhbSBzb2NrZXQgdGhlIG9yaWdpbiBvZiB0aGUgcmVxdWVzdFxuICogXFxwYXJhbSBjYXVzYWxpdHlBdFJlY2VpcHQgdGhlIGxvY2FsIGNhdXNhbGl0eSBzdHJ1Y3R1cmUgd2hlbiB0aGUgbWVzc2FnZSB3YXNcbiAqIHJlY2VpdmVkXG4gKiBcXHBhcmFtIG1lc3NhZ2VzIHRoZSBtaXNzaW5nIG1lc3NhZ2VzXG4gKi8gXG5DYXVzYWxCcm9hZGNhc3QucHJvdG90eXBlLnNlbmRBbnRpRW50cm9weVJlc3BvbnNlID1cbiAgICBmdW5jdGlvbihzb2NrZXQsIGNhdXNhbGl0eUF0UmVjZWlwdCwgbWVzc2FnZXMpe1xuICAgICAgICB0aGlzLnVuaWNhc3Quc2VuZChcbiAgICAgICAgICAgIG5ldyBNQW50aUVudHJvcHlSZXNwb25zZShjYXVzYWxpdHlBdFJlY2VpcHQsIG1lc3NhZ2VzKSxcbiAgICAgICAgICAgIHNvY2tldCk7XG4gICAgfTtcblxuLyohXG4gKiBcXGJyaWVmIHJlY2VpdmUgYSBicm9hZGNhc3QgbWVzc2FnZVxuICogXFxwYXJhbSBtZXNzYWdlIHRoZSByZWNlaXZlZCBtZXNzYWdlXG4gKi9cbkNhdXNhbEJyb2FkY2FzdC5wcm90b3R5cGUucmVjZWl2ZUJyb2FkY2FzdCA9IGZ1bmN0aW9uKG1lc3NhZ2Upe1xuICAgIHZhciBpZCA9IG1lc3NhZ2UuaWQsXG4gICAgICAgIGlzUmVhZHkgPSBtZXNzYWdlLmlzUmVhZHk7XG5cbiAgICBpZiAoIXRoaXMuc3RvcFByb3BhZ2F0aW9uKG1lc3NhZ2UpKXtcbiAgICAgICAgLy8gIzEgcmVnaXN0ZXIgdGhlIG9wZXJhdGlvblxuICAgICAgICB0aGlzLmJ1ZmZlci5wdXNoKG1lc3NhZ2UpO1xuICAgICAgICAvLyAjMiBkZWxpdmVyXG4gICAgICAgIHRoaXMucmV2aWV3QnVmZmVyKCk7XG4gICAgICAgIC8vICMzIHJlYnJvYWRjYXN0XG4gICAgICAgIHZhciBsaW5rcyA9IHRoaXMuc291cmNlLmdldFBlZXJzKE51bWJlci5NQVhfVkFMVUUpO1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxpbmtzLmxlbmd0aDsgKytpKXtcbiAgICAgICAgICAgIGlmIChsaW5rc1tpXS5jb25uZWN0ZWQgJiZcbiAgICAgICAgICAgICAgICBsaW5rc1tpXS5fY2hhbm5lbCAmJiBsaW5rc1tpXS5fY2hhbm5lbC5yZWFkeVN0YXRlPT09J29wZW4nKXtcbiAgICAgICAgICAgICAgICBsaW5rc1tpXS5zZW5kKG1lc3NhZ2UpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfTtcbiAgICB9O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGdvIHRocm91Z2ggdGhlIGJ1ZmZlciBvZiBtZXNzYWdlcyBhbmQgZGVsaXZlcnMgYWxsXG4gKiByZWFkeSBvcGVyYXRpb25zXG4gKi9cbkNhdXNhbEJyb2FkY2FzdC5wcm90b3R5cGUucmV2aWV3QnVmZmVyID0gZnVuY3Rpb24oKXtcbiAgICB2YXIgZm91bmQgPSBmYWxzZSxcbiAgICAgICAgaSA9IHRoaXMuYnVmZmVyLmxlbmd0aCAtIDE7XG4gICAgd2hpbGUoaT49MCl7XG4gICAgICAgIHZhciBtZXNzYWdlID0gdGhpcy5idWZmZXJbaV07XG4gICAgICAgIGlmICh0aGlzLmNhdXNhbGl0eS5pc0xvd2VyKG1lc3NhZ2UuaWQpKXtcbiAgICAgICAgICAgIHRoaXMuYnVmZmVyLnNwbGljZShpLCAxKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmNhdXNhbGl0eS5pc1JlYWR5KG1lc3NhZ2UuaXNSZWFkeSkpe1xuICAgICAgICAgICAgICAgIGZvdW5kID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICB0aGlzLmNhdXNhbGl0eS5pbmNyZW1lbnRGcm9tKG1lc3NhZ2UuaWQpO1xuICAgICAgICAgICAgICAgIHRoaXMuYnVmZmVyLnNwbGljZShpLCAxKTtcbiAgICAgICAgICAgICAgICB0aGlzLmVtaXQoJ3JlY2VpdmUnLCBtZXNzYWdlLnBheWxvYWQpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfTtcbiAgICAgICAgLS1pO1xuICAgIH07XG4gICAgaWYgKGZvdW5kKXsgdGhpcy5yZXZpZXdCdWZmZXIoKTsgIH07XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgcmVjZWl2ZSBhIHVuaWNhc3QgbWVzc2FnZSwgaS5lLiwgZWl0aGVyIGFuIGFudGllbnRyb3B5IHJlcXVlc3Qgb3IgYW5cbiAqIGFudGllbnRyb3B5IHJlc3BvbnNlXG4gKiBcXGJyaWVmIHNvY2tldCB0aGUgb3JpZ2luIG9mIHRoZSBtZXNzYWdlXG4gKiBcXGJyaWVmIG1lc3NhZ2UgdGhlIG1lc3NhZ2UgcmVjZWl2ZWQgXG4gKi9cbkNhdXNhbEJyb2FkY2FzdC5wcm90b3R5cGUucmVjZWl2ZVVuaWNhc3QgPSBmdW5jdGlvbihzb2NrZXQsIG1lc3NhZ2Upe1xuICAgIHN3aXRjaCAobWVzc2FnZS50eXBlKXtcbiAgICBjYXNlICdNQW50aUVudHJvcHlSZXF1ZXN0JzpcbiAgICAgICAgdGhpcy5lbWl0KCdhbnRpRW50cm9weScsXG4gICAgICAgICAgICAgICAgICBzb2NrZXQsIG1lc3NhZ2UuY2F1c2FsaXR5LCB0aGlzLmNhdXNhbGl0eS5jbG9uZSgpKTtcbiAgICAgICAgYnJlYWs7XG4gICAgY2FzZSAnTUFudGlFbnRyb3B5UmVzcG9uc2UnOlxuICAgICAgICAvLyAjMSBjb25zaWRlcmUgZWFjaCBtZXNzYWdlIGluIHRoZSByZXNwb25zZSBpbmRlcGVuZGFudGx5XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpPG1lc3NhZ2UuZWxlbWVudHMubGVuZ3RoOyArK2kpe1xuICAgICAgICAgICAgLy8gIzIgb25seSBjaGVjayBpZiB0aGUgbWVzc2FnZSBoYXMgbm90IGJlZW4gcmVjZWl2ZWQgeWV0XG4gICAgICAgICAgICBpZiAoIXRoaXMuc3RvcFByb3BhZ2F0aW9uKG1lc3NhZ2UuZWxlbWVudHNbaV0pKXtcbiAgICAgICAgICAgICAgICB0aGlzLmNhdXNhbGl0eS5pbmNyZW1lbnRGcm9tKG1lc3NhZ2UuZWxlbWVudHNbaV0uaWQpO1xuICAgICAgICAgICAgICAgIHRoaXMuZW1pdCgncmVjZWl2ZScsIG1lc3NhZ2UuZWxlbWVudHNbaV0ucGF5bG9hZCk7XG4gICAgICAgICAgICB9O1xuICAgICAgICB9O1xuICAgICAgICAvLyAjMiBtZXJnZSBjYXVzYWxpdHkgc3RydWN0dXJlc1xuICAgICAgICB0aGlzLmNhdXNhbGl0eS5tZXJnZShtZXNzYWdlLmNhdXNhbGl0eSk7XG4gICAgICAgIGJyZWFrO1xuICAgIH07XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0cyBjYWxsZWQgd2hlbiBhIGJyb2FkY2FzdCBtZXNzYWdlIHJlYWNoZXMgdGhpcyBub2RlLiAgdGhpc1xuICogZnVuY3Rpb24gZXZhbHVhdGVzIGlmIHRoZSBub2RlIHNob3VsZCBwcm9wYWdhdGUgdGhlIG1lc3NhZ2UgZnVydGhlciBvciBpZiBpdFxuICogc2hvdWxkIHN0b3Agc2VuZGluZyBpdC5cbiAqIFxccGFyYW0gbWVzc2FnZSBhIGJyb2FkY2FzdCBtZXNzYWdlXG4gKiBcXHJldHVybiB0cnVlIGlmIHRoZSBtZXNzYWdlIGlzIGFscmVhZHkga25vd24sIGZhbHNlIG90aGVyd2lzZVxuICovXG5DYXVzYWxCcm9hZGNhc3QucHJvdG90eXBlLnN0b3BQcm9wYWdhdGlvbiA9IGZ1bmN0aW9uIChtZXNzYWdlKSB7XG4gICAgcmV0dXJuIHRoaXMuY2F1c2FsaXR5LmlzTG93ZXIobWVzc2FnZS5pZCkgfHxcbiAgICAgICAgdGhpcy5idWZmZXJJbmRleE9mKG1lc3NhZ2UuaWQpPj0wO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGdldCB0aGUgaW5kZXggaW4gdGhlIGJ1ZmZlciBvZiB0aGUgbWVzc2FnZSBpZGVudGlmaWVkIGJ5IGlkXG4gKiBcXHBhcmFtIGlkIHRoZSBpZGVudGlmaWVyIHRvIHNlYXJjaFxuICogXFxyZXR1cm4gdGhlIGluZGV4IG9mIHRoZSBtZXNzYWdlIGluIHRoZSBidWZmZXIsIC0xIGlmIG5vdCBmb3VuZFxuICovXG5DYXVzYWxCcm9hZGNhc3QucHJvdG90eXBlLmJ1ZmZlckluZGV4T2YgPSBmdW5jdGlvbihpZCl7XG4gICAgdmFyIGZvdW5kID0gZmFsc2UsXG4gICAgICAgIGluZGV4ID0gLTEsXG4gICAgICAgIGkgPSAwO1xuICAgIHdoaWxlICghZm91bmQgJiYgaTx0aGlzLmJ1ZmZlci5sZW5ndGgpe1xuICAgICAgICAvLyAoVE9ETykgZml4IHVnbHluZXNzXG4gICAgICAgIGlmIChKU09OLnN0cmluZ2lmeSh0aGlzLmJ1ZmZlcltpXS5pZCkgPT09IEpTT04uc3RyaW5naWZ5KGlkKSl7IFxuICAgICAgICAgICAgZm91bmQgPSB0cnVlOyBpbmRleCA9IGk7XG4gICAgICAgIH07XG4gICAgICAgICsraVxuICAgIH07XG4gICAgcmV0dXJuIGluZGV4O1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBDYXVzYWxCcm9hZGNhc3Q7XG4iLCJcbi8qIVxuICogXFxicmllZiBtZXNzYWdlIGNvbnRhaW5pbmcgZGF0YSB0byBicm9hZGNhc3RcbiAqIFxccGFyYW0gbmFtZSB0aGUgbmFtZSBvZiB0aGUgcHJvdG9jb2wsIGRlZmF1bHQgJ2NhdXNhbCdcbiAqIFxccGFyYW0gaWQgdGhlIGlkZW50aWZpZXIgb2YgdGhlIGJyb2FkY2FzdCBtZXNzYWdlXG4gKiBcXHBhcmFtIGlzUmVhZHkgdGhlIGlkZW50aWZpZXIocykgdGhhdCBtdXN0IGV4aXN0IHRvIGRlbGl2ZXIgdGhpcyBtZXNzYWdlXG4gKiBcXHBhcmFtIHBheWxvYWQgdGhlIGJyb2FkY2FzdGVkIGRhdGFcbiAqL1xuZnVuY3Rpb24gTUJyb2FkY2FzdChuYW1lLCBpZCwgaXNSZWFkeSwgcGF5bG9hZCl7XG4gICAgdGhpcy5wcm90b2NvbCA9IChuYW1lICYmIG5hbWUrJy1icm9hZGNhc3QnKSB8fCAnY2F1c2FsLWJyb2FkY2FzdCc7XG4gICAgdGhpcy5pZCA9IGlkO1xuICAgIHRoaXMuaXNSZWFkeSA9IGlzUmVhZHk7XG4gICAgdGhpcy5wYXlsb2FkID0gcGF5bG9hZDtcbn07XG5tb2R1bGUuZXhwb3J0cy5NQnJvYWRjYXN0ID0gTUJyb2FkY2FzdDtcblxuLyohXG4gKiBcXGJyaWVmIG1lc3NhZ2UgdGhhdCByZXF1ZXN0IGFuIEFudGlFbnRyb3B5IFxuICogXFxwYXJhbSBjYXVzYWxpdHkgdGhlIGNhdXNhbGl0eSBzdHJ1Y3R1cmVcbiAqL1xuZnVuY3Rpb24gTUFudGlFbnRyb3B5UmVxdWVzdChjYXVzYWxpdHkpe1xuICAgIHRoaXMudHlwZSA9ICdNQW50aUVudHJvcHlSZXF1ZXN0JztcbiAgICB0aGlzLmNhdXNhbGl0eSA9IGNhdXNhbGl0eTtcbn07XG5tb2R1bGUuZXhwb3J0cy5NQW50aUVudHJvcHlSZXF1ZXN0ID0gTUFudGlFbnRyb3B5UmVxdWVzdDtcblxuLyohXG4gKiBcXGJyaWVmIG1lc3NhZ2UgcmVzcG9uZGluZyB0byB0aGUgQW50aUVudHJvcHkgcmVxdWVzdFxuICogXFxwYXJhbSBuYW1lIHRoZSBuYW1lIG9mIHRoZSBwcm90b2NvbCwgZGVmYXVsdCAnY2F1c2FsJ1xuICogXFxwYXJhbSBjYXVzYWxpdHkgdGhlIGNhdXNhbGl0eSBzdHJ1Y3R1cmVcbiAqIFxccGFyYW0gZWxlbWVudHMgdGhlIGVsZW1lbnRzIHRvIHNlbmRcbiAqL1xuZnVuY3Rpb24gTUFudGlFbnRyb3B5UmVzcG9uc2UoY2F1c2FsaXR5LCBlbGVtZW50cyl7XG4gICAgdGhpcy50eXBlID0gJ01BbnRpRW50cm9weVJlc3BvbnNlJztcbiAgICB0aGlzLmNhdXNhbGl0eSA9IGNhdXNhbGl0eTtcbiAgICB0aGlzLmVsZW1lbnRzID0gZWxlbWVudHM7XG59O1xubW9kdWxlLmV4cG9ydHMuTUFudGlFbnRyb3B5UmVzcG9uc2UgPSBNQW50aUVudHJvcHlSZXNwb25zZTtcblxuIiwiXG4vKiFcbiAqIFxcYnJpZWYgbWVzc2FnZSBjb250YWluaW5nIGRhdGEgdG8gdW5pY2FzdFxuICogXFxwYXJhbSBuYW1lIHRoZSBwcm90b2NvbCBuYW1lXG4gKiBcXHBhcmFtIHBheWxvYWQgdGhlIHNlbnQgZGF0YVxuICovXG5mdW5jdGlvbiBNVW5pY2FzdChuYW1lLCBwYXlsb2FkKXtcbiAgICB0aGlzLnByb3RvY29sID0gbmFtZSB8fCAndW5pY2FzdCc7XG4gICAgdGhpcy5wYXlsb2FkID0gcGF5bG9hZDtcbn07XG5tb2R1bGUuZXhwb3J0cy5NVW5pY2FzdCA9IE1VbmljYXN0O1xuIiwidmFyIEV2ZW50RW1pdHRlciA9IHJlcXVpcmUoJ2V2ZW50cycpLkV2ZW50RW1pdHRlcjtcbnZhciB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuXG52YXIgTVVuaWNhc3QgPSByZXF1aXJlKCcuL21lc3NhZ2VzJykuTVVuaWNhc3Q7XG5cbnV0aWwuaW5oZXJpdHMoVW5pY2FzdCwgRXZlbnRFbWl0dGVyKTtcblxuLyohXG4gKiBVbmljYXN0IGNvbXBvbmVudCB0aGF0IHNpbXBseSBjaG9zZSBhIHJhbmRvbSBwZWVyIGFuZCBzZW5kIGEgbWVzc2FnZVxuICogXFxwYXJhbSBzb3VyY2UgdGhlIHByb3RvY29sIHJlY2VpdmluZyB0aGUgbWVzc2FnZXNcbiAqIFxccGFyYW0gbmFtZSB0aGUgbmFtZSBvZiB0aGUgcHJvdG9jb2wsIGRlZmF1bHQgaXMgJ3VuaWNhc3QnXG4gKi9cbmZ1bmN0aW9uIFVuaWNhc3Qoc291cmNlLCBtYXgsIG5hbWUpIHtcbiAgICBFdmVudEVtaXR0ZXIuY2FsbCh0aGlzKTtcbiAgICB0aGlzLm5hbWUgPSBuYW1lIHx8ICd1bmljYXN0JztcbiAgICB0aGlzLnNvdXJjZSA9IHNvdXJjZTtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgdGhpcy5zb3VyY2Uub24oc2VsZi5uYW1lKyctcmVjZWl2ZScsIGZ1bmN0aW9uKHNvY2tldCwgbWVzc2FnZSl7XG4gICAgICAgIHNlbGYuZW1pdCgncmVjZWl2ZScsIHNvY2tldCwgbWVzc2FnZS5wYXlsb2FkKTtcbiAgICB9KTtcbn07XG5cbi8qIVxuICogXFxicmllZiBzZW5kIHRoZSBtZXNzYWdlIHRvIG9uZSByYW5kb20gcGFydGljaXBhbnRcbiAqIFxccGFyYW0gbWVzc2FnZSB0aGUgbWVzc2FnZSB0byBzZW5kXG4gKiBcXHBhcmFtIHNvY2tldCBvcHRpb25hbCBrbm93biBzb2NrZXRcbiAqL1xuVW5pY2FzdC5wcm90b3R5cGUuc2VuZCA9IGZ1bmN0aW9uKG1lc3NhZ2UsIHNvY2tldCl7XG4gICAgLy8gIzEgZ2V0IHRoZSBuZWlnaGJvcmhvb2QgYW5kIGNyZWF0ZSB0aGUgbWVzc2FnZVxuICAgIHZhciBsaW5rcyA9IChzb2NrZXQgJiYgW3NvY2tldF0pIHx8IHRoaXMuc291cmNlLmdldFBlZXJzKDEpO1xuICAgIHZhciBtVW5pY2FzdCA9IG5ldyBNVW5pY2FzdCh0aGlzLm5hbWUsIG1lc3NhZ2UpO1xuICAgIC8vICMyIHNlbmQgdGhlIG1lc3NhZ2VcbiAgICBpZiAobGlua3MubGVuZ3RoPjAgJiYgbGlua3NbMF0uY29ubmVjdGVkKXtcbiAgICAgICAgbGlua3NbMF0uc2VuZChtVW5pY2FzdCk7XG4gICAgfTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gVW5pY2FzdDtcbiIsInZhciBCSSA9IHJlcXVpcmUoJ0JpZ0ludCcpO1xuXG4vKiFcbiAqIFxcY2xhc3MgQmFzZVxuICogXFxicmllZiBwcm92aWRlcyBiYXNpYyBmdW5jdGlvbiB0byBiaXQgbWFuaXB1bGF0aW9uXG4gKiBcXHBhcmFtIGIgdGhlIG51bWJlciBvZiBiaXRzIGF0IGxldmVsIDAgb2YgdGhlIGRlbnNlIHNwYWNlXG4gKi9cbmZ1bmN0aW9uIEJhc2UoYil7ICAgIFxuICAgIHZhciBERUZBVUxUX0JBU0UgPSAzO1xuICAgIHRoaXMuX2IgPSBiIHx8IERFRkFVTFRfQkFTRTtcbn07XG5cbi8qIVxuICogXFxicmllZiBQcm9jZXNzIHRoZSBudW1iZXIgb2YgYml0cyB1c2FnZSBhdCBhIGNlcnRhaW4gbGV2ZWwgb2YgZGVuc2Ugc3BhY2VcbiAqIFxccGFyYW0gbGV2ZWwgdGhlIGxldmVsIGluIGRlbnNlIHNwYWNlLCBpLmUuLCB0aGUgbnVtYmVyIG9mIGNvbmNhdGVuYXRpb25cbiAqL1xuQmFzZS5wcm90b3R5cGUuZ2V0Qml0QmFzZSA9IGZ1bmN0aW9uKGxldmVsKXtcbiAgICByZXR1cm4gdGhpcy5fYiArIGxldmVsO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIFByb2Nlc3MgdGhlIHRvdGFsIG51bWJlciBvZiBiaXRzIHVzYWdlIHRvIGdldCB0byBhIGNlcnRhaW4gbGV2ZWxcbiAqIFxccGFyYW0gbGV2ZWwgdGhlIGxldmVsIGluIGRlbnNlIHNwYWNlXG4gKi9cbkJhc2UucHJvdG90eXBlLmdldFN1bUJpdCA9IGZ1bmN0aW9uKGxldmVsKXtcbiAgICB2YXIgbiA9IHRoaXMuZ2V0Qml0QmFzZShsZXZlbCksXG4gICAgICAgIG0gPSB0aGlzLl9iLTE7XG4gICAgcmV0dXJuIChuICogKG4gKyAxKSkgLyAyIC0gKG0gKiAobSArIDEpIC8gMik7XG59O1xuXG4vKiFcbiAgXFxicmllZiBwcm9jZXNzIHRoZSBpbnRlcnZhbCBiZXR3ZWVuIHR3byBMU0VRTm9kZVxuICBcXHBhcmFtIHAgdGhlIHByZXZpb3VzIExTRVFOb2RlXG4gIFxccGFyYW0gcSB0aGUgbmV4dCBMU0VRTm9kZVxuICBcXHBhcmFtIGxldmVsIHRoZSBkZXB0aCBvZiB0aGUgdHJlZSB0byBwcm9jZXNzXG4gIFxccmV0dXJuIGFuIGludGVnZXIgd2hpY2ggaXMgdGhlIGludGVydmFsIGJldHdlZW4gdGhlIHR3byBub2RlIGF0IHRoZSBkZXB0aFxuKi9cbkJhc2UucHJvdG90eXBlLmdldEludGVydmFsID0gZnVuY3Rpb24ocCwgcSwgbGV2ZWwpe1xuICAgIHZhciBzdW0gPSAwLCBpID0gMCxcbiAgICAgICAgcElzR3JlYXRlciA9IGZhbHNlLCBjb21tb25Sb290ID0gdHJ1ZSxcbiAgICAgICAgcHJldlZhbHVlID0gMCwgbmV4dFZhbHVlID0gMDtcbiAgICBcbiAgICB3aGlsZSAoaTw9bGV2ZWwpe1xuXHRwcmV2VmFsdWUgPSAwOyBpZiAocCAhPT0gbnVsbCl7IHByZXZWYWx1ZSA9IHAudC5wOyB9XG4gICAgICAgIG5leHRWYWx1ZSA9IDA7IGlmIChxICE9PSBudWxsKXsgbmV4dFZhbHVlID0gcS50LnA7IH1cbiAgICAgICAgaWYgKGNvbW1vblJvb3QgJiYgcHJldlZhbHVlICE9PSBuZXh0VmFsdWUpe1xuICAgICAgICAgICAgY29tbW9uUm9vdCA9IGZhbHNlO1xuICAgICAgICAgICAgcElzR3JlYXRlciA9IHByZXZWYWx1ZSA+IG5leHRWYWx1ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocElzR3JlYXRlcil7IG5leHRWYWx1ZSA9IE1hdGgucG93KDIsdGhpcy5nZXRCaXRCYXNlKGkpKS0xOyB9XG4gICAgICAgIGlmIChjb21tb25Sb290IHx8IHBJc0dyZWF0ZXIgfHwgaSE9PWxldmVsKXtcbiAgICAgICAgICAgIHN1bSArPSBuZXh0VmFsdWUgLSBwcmV2VmFsdWU7IFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3VtICs9IG5leHRWYWx1ZSAtIHByZXZWYWx1ZSAtIDE7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGkhPT1sZXZlbCl7XG4gICAgICAgICAgICBzdW0gKj0gTWF0aC5wb3coMix0aGlzLmdldEJpdEJhc2UoaSsxKSk7XG4gICAgICAgIH07XG4gICAgICAgIGlmIChwIT09bnVsbCAmJiBwLmNoaWxkcmVuLmxlbmd0aCE9PTApe3A9cC5jaGlsZHJlblswXTt9IGVsc2V7cD1udWxsO307XG4gICAgICAgIGlmIChxIT09bnVsbCAmJiBxLmNoaWxkcmVuLmxlbmd0aCE9PTApe3E9cS5jaGlsZHJlblswXTt9IGVsc2V7cT1udWxsO307XG4gICAgICAgICsraTtcbiAgICB9XG4gICAgcmV0dXJuIHN1bTtcbn07XG5cbkJhc2UuaW5zdGFuY2UgPSBudWxsO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKGFyZ3Mpe1xuICAgIGlmIChhcmdzKXtcbiAgICAgICAgQmFzZS5pbnN0YW5jZSA9IG5ldyBCYXNlKGFyZ3MpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChCYXNlLmluc3RhbmNlID09PSBudWxsKXtcbiAgICAgICAgICAgIEJhc2UuaW5zdGFuY2UgPSBuZXcgQmFzZSgpO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgcmV0dXJuIEJhc2UuaW5zdGFuY2U7XG59O1xuIiwidmFyIEJJID0gcmVxdWlyZSgnQmlnSW50Jyk7XG52YXIgQmFzZSA9IHJlcXVpcmUoJy4vYmFzZS5qcycpKCk7XG52YXIgVHJpcGxlID0gcmVxdWlyZSgnLi90cmlwbGUuanMnKTtcbnZhciBMU0VRTm9kZSA9IHJlcXVpcmUoJy4vbHNlcW5vZGUuanMnKTtcblxuLyohXG4gKiBcXGNsYXNzIElkZW50aWZpZXJcbiAqIFxcYnJpZWYgVW5pcXVlIGFuZCBpbW11dGFibGUgaWRlbnRpZmllciBjb21wb3NlZCBvZiBkaWdpdCwgc291cmNlcywgY291bnRlcnNcbiAqIFxccGFyYW0gZCB0aGUgZGlnaXQgKHBvc2l0aW9uIGluIGRlbnNlIHNwYWNlKVxuICogXFxwYXJhbSBzIHRoZSBsaXN0IG9mIHNvdXJjZXNcbiAqIFxccGFyYW0gYyB0aGUgbGlzdCBvZiBjb3VudGVyc1xuICovXG5mdW5jdGlvbiBJZGVudGlmaWVyKGQsIHMsIGMpe1xuICAgIHRoaXMuX2QgPSBkO1xuICAgIHRoaXMuX3MgPSBzO1xuICAgIHRoaXMuX2MgPSBjO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHNldCB0aGUgZCxzLGMgdmFsdWVzIGFjY29yZGluZyB0byB0aGUgbm9kZSBpbiBhcmd1bWVudFxuICogXFxwYXJhbSBub2RlIHRoZSBsc2Vxbm9kZSBjb250YWluaW5nIHRoZSBwYXRoIGluIHRoZSB0cmVlIHN0cnVjdHVyZVxuICovXG5JZGVudGlmaWVyLnByb3RvdHlwZS5mcm9tTm9kZSA9IGZ1bmN0aW9uKG5vZGUpe1xuICAgIC8vICMxIHByb2Nlc3MgdGhlIGxlbmd0aCBvZiB0aGUgcGF0aFxuICAgIHZhciBsZW5ndGggPSAxLCB0ZW1wTm9kZSA9IG5vZGUsIGkgPSAwO1xuICAgIFxuICAgIHdoaWxlICh0ZW1wTm9kZS5jaGlsZHJlbi5sZW5ndGggIT09IDApe1xuXHQrK2xlbmd0aDtcbiAgICAgICAgdGVtcE5vZGUgPSB0ZW1wTm9kZS5jaGlsZHJlblswXTtcbiAgICB9O1xuICAgIC8vICMxIGNvcHkgdGhlIHZhbHVlcyBjb250YWluZWQgaW4gdGhlIHBhdGhcbiAgICB0aGlzLl9kID0gQkkuaW50MmJpZ0ludCgwLEJhc2UuZ2V0U3VtQml0KGxlbmd0aCAtIDEpKTtcbiAgICBcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aCA7ICsraSl7XG4gICAgICAgIC8vICMxYSBjb3B5IHRoZSBzaXRlIGlkXG4gICAgICAgIHRoaXMuX3MucHVzaChub2RlLnQucyk7XG4gICAgICAgIC8vICMxYiBjb3B5IHRoZSBjb3VudGVyXG4gICAgICAgIHRoaXMuX2MucHVzaChub2RlLnQuYyk7XG4gICAgICAgIC8vICMxYyBjb3B5IHRoZSBkaWdpdFxuICAgICAgICBCSS5hZGRJbnRfKHRoaXMuX2QsIG5vZGUudC5wKTtcbiAgICAgICAgaWYgKGkhPT0obGVuZ3RoLTEpKXtcbiAgICAgICAgICAgIEJJLmxlZnRTaGlmdF8odGhpcy5fZCwgQmFzZS5nZXRCaXRCYXNlKGkrMSkpO1xuICAgICAgICB9O1xuICAgICAgICBub2RlID0gbm9kZS5jaGlsZHJlblswXTtcbiAgICB9O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNvbnZlcnQgdGhlIGlkZW50aWZpZXIgaW50byBhIG5vZGUgd2l0aG91dCBlbGVtZW50XG4gKiBcXHBhcmFtIGUgdGhlIGVsZW1lbnQgYXNzb2NpYXRlZCB3aXRoIHRoZSBub2RlXG4gKi9cbklkZW50aWZpZXIucHJvdG90eXBlLnRvTm9kZSA9IGZ1bmN0aW9uKGUpe1xuICAgIHZhciByZXN1bHRQYXRoID0gW10sIGRCaXRMZW5ndGggPSBCYXNlLmdldFN1bUJpdCh0aGlzLl9jLmxlbmd0aCAtMSksIGkgPSAwLFxuICAgICAgICBtaW5lO1xuICAgIC8vICMxIGRlY29uc3RydWN0IHRoZSBkaWdpdCBcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMuX2MubGVuZ3RoOyArK2kpe1xuICAgICAgICAvLyAjMSB0cnVuY2F0ZSBtaW5lXG4gICAgICAgIG1pbmUgPSBCSS5kdXAodGhpcy5fZCk7XG4gICAgICAgIC8vICMxYSBzaGlmdCByaWdodCB0byBlcmFzZSB0aGUgdGFpbCBvZiB0aGUgcGF0aFxuICAgICAgICBCSS5yaWdodFNoaWZ0XyhtaW5lLCBkQml0TGVuZ3RoIC0gQmFzZS5nZXRTdW1CaXQoaSkpO1xuICAgICAgICAvLyAjMWIgY29weSB2YWx1ZSBpbiB0aGUgcmVzdWx0XG4gICAgICAgIHJlc3VsdFBhdGgucHVzaChuZXcgVHJpcGxlKEJJLm1vZEludChtaW5lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgTWF0aC5wb3coMixCYXNlLmdldEJpdEJhc2UoaSkpKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fc1tpXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fY1tpXSkpO1xuICAgIH07XG4gICAgcmV0dXJuIG5ldyBMU0VRTm9kZShyZXN1bHRQYXRoLCBlKTtcbn07XG5cbi8qIVxuICogXFxicmllZiBjb21wYXJlIHR3byBpZGVudGlmaWVyc1xuICogXFxwYXJhbSBvIHRoZSBvdGhlciBpZGVudGlmaWVyXG4gKiBcXHJldHVybiAtMSBpZiB0aGlzIGlzIGxvd2VyLCAwIGlmIHRoZXkgYXJlIGVxdWFsLCAxIGlmIHRoaXMgaXMgZ3JlYXRlclxuICovXG5JZGVudGlmaWVyLnByb3RvdHlwZS5jb21wYXJlID0gZnVuY3Rpb24obyl7XG4gICAgdmFyIGRCaXRMZW5ndGggPSBCYXNlLmdldFN1bUJpdCh0aGlzLl9jLmxlbmd0aCAtIDEpLFxuICAgICAgICBvZEJpdExlbmd0aCA9IEJhc2UuZ2V0U3VtQml0KG8uX2MubGVuZ3RoIC0gMSksXG4gICAgICAgIGNvbXBhcmluZyA9IHRydWUsXG4gICAgICAgIGNvbXAgPSAwLCBpID0gMCxcbiAgICAgICAgc3VtLCBtaW5lLCBvdGhlcjtcbiAgICBcbiAgICAvLyAjMSBDb21wYXJlIHRoZSBsaXN0IG9mIDxkLHMsYz5cbiAgICB3aGlsZSAoY29tcGFyaW5nICYmIGkgPCBNYXRoLm1pbih0aGlzLl9jLmxlbmd0aCwgby5fYy5sZW5ndGgpICkge1xuICAgICAgICAvLyBjYW4gc3RvcCBiZWZvcmUgdGhlIGVuZCBvZiBmb3IgbG9vcCB3aXogcmV0dXJuXG4gICAgICAgIHN1bSA9IEJhc2UuZ2V0U3VtQml0KGkpO1xuICAgICAgICAvLyAjMWEgdHJ1bmNhdGUgbWluZVxuICAgICAgICBtaW5lID0gQkkuZHVwKHRoaXMuX2QpO1xuICAgICAgICBCSS5yaWdodFNoaWZ0XyhtaW5lLCBkQml0TGVuZ3RoIC0gc3VtKTtcbiAgICAgICAgLy8gIzFiIHRydW5jYXRlIG90aGVyXG4gICAgICAgIG90aGVyID0gQkkuZHVwKG8uX2QpO1xuICAgICAgICBCSS5yaWdodFNoaWZ0XyhvdGhlciwgb2RCaXRMZW5ndGggLSBzdW0pO1xuICAgICAgICAvLyAjMiBDb21wYXJlIHRyaXBsZXNcbiAgICAgICAgaWYgKCFCSS5lcXVhbHMobWluZSxvdGhlcikpIHsgIC8vICMyYSBkaWdpdFxuICAgICAgICAgICAgaWYgKEJJLmdyZWF0ZXIobWluZSxvdGhlcikpe2NvbXAgPSAxO31lbHNle2NvbXAgPSAtMTt9O1xuICAgICAgICAgICAgY29tcGFyaW5nID0gZmFsc2U7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb21wID0gdGhpcy5fc1tpXSAtIG8uX3NbaV07IC8vICMyYiBzb3VyY2VcbiAgICAgICAgICAgIGlmIChjb21wICE9PSAwKSB7XG4gICAgICAgICAgICAgICAgY29tcGFyaW5nID0gZmFsc2U7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbXAgPSB0aGlzLl9jW2ldIC0gby5fY1tpXTsgLy8gMmMgY2xvY2tcbiAgICAgICAgICAgICAgICBpZiAoY29tcCAhPT0gMCkge1xuICAgICAgICAgICAgICAgICAgICBjb21wYXJpbmcgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfTtcbiAgICAgICAgKytpO1xuICAgIH07XG4gICAgXG4gICAgaWYgKGNvbXA9PT0wKXtcbiAgICAgICAgY29tcCA9IHRoaXMuX2MubGVuZ3RoIC0gby5fYy5sZW5ndGg7IC8vICMzIGNvbXBhcmUgbGlzdCBzaXplXG4gICAgfTtcbiAgICByZXR1cm4gY29tcDtcbn07XG5cblxubW9kdWxlLmV4cG9ydHMgPSBJZGVudGlmaWVyO1xuIiwidmFyIFRyaXBsZSA9IHJlcXVpcmUoJy4vdHJpcGxlLmpzJyk7XG5yZXF1aXJlKCcuL3V0aWwuanMnKTtcblxuLyohXG4gKiBcXGJyaWVmIGEgbm9kZSBvZiB0aGUgTFNFUSB0cmVlXG4gKiBcXHBhcmFtIHRyaXBsZUxpc3QgdGhlIGxpc3Qgb2YgdHJpcGxlIGNvbXBvc2luZyB0aGUgcGF0aCB0byB0aGUgZWxlbWVudFxuICogXFxwYXJhbSBlbGVtZW50IHRoZSBlbGVtZW50IHRvIGluc2VydCBpbiB0aGUgc3RydWN0dXJlXG4gKi9cbmZ1bmN0aW9uIExTRVFOb2RlKHRyaXBsZUxpc3QsIGVsZW1lbnQpe1xuICAgIHRoaXMudCA9IHRyaXBsZUxpc3Quc2hpZnQoKTtcbiAgICBpZiAodHJpcGxlTGlzdC5sZW5ndGggPT09IDApe1xuICAgICAgICB0aGlzLmUgPSBlbGVtZW50O1xuICAgICAgICB0aGlzLnN1YkNvdW50ZXIgPSAwOyAvLyBjb3VudCB0aGUgbnVtYmVyIG9mIGNoaWxkcmVuIGFuZCBzdWJjaGlsZHJlblxuICAgICAgICB0aGlzLmNoaWxkcmVuID0gW107XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5lID0gbnVsbDtcbiAgICAgICAgdGhpcy5zdWJDb3VudGVyID0gMTtcbiAgICAgICAgdGhpcy5jaGlsZHJlbiA9IFtdO1xuICAgICAgICB0aGlzLmNoaWxkcmVuLnB1c2gobmV3IExTRVFOb2RlKHRyaXBsZUxpc3QsIGVsZW1lbnQpKTtcbiAgICB9O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGFkZCBhIHBhdGggZWxlbWVudCB0byB0aGUgY3VycmVudCBub2RlXG4gKiBcXHBhcmFtIG5vZGUgdGhlIG5vZGUgdG8gYWRkIGFzIGEgY2hpbGRyZW4gb2YgdGhpcyBub2RlXG4gKiBcXHJldHVybiAtMSBpZiB0aGUgZWxlbWVudCBhbHJlYWR5IGV4aXN0c1xuICovXG5MU0VRTm9kZS5wcm90b3R5cGUuYWRkID0gZnVuY3Rpb24obm9kZSl7XG4gICAgdmFyIGluZGV4ID0gdGhpcy5jaGlsZHJlbi5iaW5hcnlJbmRleE9mKG5vZGUpO1xuICAgIFxuICAgIC8vICMxIGlmIHRoZSBwYXRoIGRvIG5vIGV4aXN0LCBjcmVhdGUgaXRcbiAgICBpZiAoaW5kZXggPCAwIHx8IHRoaXMuY2hpbGRyZW4ubGVuZ3RoID09PSAwICB8fFxuICAgICAgICAoaW5kZXggPT09IDAgJiYgdGhpcy5jaGlsZHJlbi5sZW5ndGggPiAwICYmIFxuICAgICAgICAgdGhpcy5jaGlsZHJlblswXS5jb21wYXJlKG5vZGUpIT09MCkpe1xuICAgICAgICB0aGlzLmNoaWxkcmVuLnNwbGljZSgtaW5kZXgsIDAsIG5vZGUpO1xuICAgICAgICB0aGlzLnN1YkNvdW50ZXIrPTE7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgLy8gIzIgb3RoZXJ3aXNlLCBjb250aW51ZSB0byBleHBsb3JlIHRoZSBzdWJ0cmVlc1xuICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGggPT09IDApe1xuICAgICAgICAgICAgLy8gIzJhIGNoZWNrIGlmIHRoZSBlbGVtZW50IGFscmVhZHkgZXhpc3RzXG4gICAgICAgICAgICBpZiAodGhpcy5jaGlsZHJlbltpbmRleF0uZSAhPT0gbnVsbCl7XG4gICAgICAgICAgICAgICAgcmV0dXJuIC0xO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLmNoaWxkcmVuW2luZGV4XS5lID0gbm9kZS5lO1xuICAgICAgICAgICAgICAgIHRoaXMuc3ViQ291bnRlcis9MTtcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyAjMyBpZiBkaWRub3QgZXhpc3QsIGluY3JlbWVudCB0aGUgY291bnRlclxuICAgICAgICAgICAgaWYgKHRoaXMuY2hpbGRyZW5baW5kZXhdLmFkZChub2RlLmNoaWxkcmVuWzBdKSE9PS0xKXtcbiAgICAgICAgICAgICAgICB0aGlzLnN1YkNvdW50ZXIrPTE7XG4gICAgICAgICAgICB9O1xuICAgICAgICB9O1xuICAgIH07XG59O1xuXG4vKiEgXG4gKiBcXGJyaWVmIHJlbW92ZSB0aGUgbm9kZSBvZiB0aGUgdHJlZSBhbmQgYWxsIG5vZGUgd2l0aGluIHBhdGggYmVpbmcgdXNlbGVzc1xuICogXFxwYXJhbSBub2RlIHRoZSBub2RlIGNvbnRhaW5pbmcgdGhlIHBhdGggdG8gcmVtb3ZlXG4gKiBcXHJldHVybiAtMSBpZiB0aGUgbm9kZSBkb2VzIG5vdCBleGlzdFxuICovXG5MU0VRTm9kZS5wcm90b3R5cGUuZGVsID0gZnVuY3Rpb24obm9kZSl7XG4gICAgdmFyIGluZGV4ZXMgPSB0aGlzLmdldEluZGV4ZXMobm9kZSksXG4gICAgICAgIGN1cnJlbnRUcmVlID0gdGhpcywgaSA9IDAsIGlzU3BsaXR0ZWQgPSBmYWxzZTtcblxuICAgIGlmIChpbmRleGVzID09PSAtMSkgeyByZXR1cm4gLTE7IH07IC8vIGl0IGRvZXMgbm90IGV4aXN0c1xuICAgIHRoaXMuc3ViQ291bnRlciAtPSAxO1xuICAgIHdoaWxlIChpIDwgaW5kZXhlcy5sZW5ndGggJiYgIShpc1NwbGl0dGVkKSl7XG4gICAgICAgIGlmICghKGN1cnJlbnRUcmVlLmNoaWxkcmVuW2luZGV4ZXNbaV1dLmUgIT09IG51bGwgJiZcbiAgICAgICAgICAgICAgaT09PShpbmRleGVzLmxlbmd0aCAtIDEpKSl7XG4gICAgICAgICAgICBjdXJyZW50VHJlZS5jaGlsZHJlbltpbmRleGVzW2ldXS5zdWJDb3VudGVyIC09IDE7ICAgICBcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKGN1cnJlbnRUcmVlLmNoaWxkcmVuW2luZGV4ZXNbaV1dLnN1YkNvdW50ZXIgPD0gMFxuICAgICAgICAgICAgJiYgKGN1cnJlbnRUcmVlLmNoaWxkcmVuW2luZGV4ZXNbaV1dLmUgPT09IG51bGwgfHxcbiAgICAgICAgICAgICAgICAoY3VycmVudFRyZWUuY2hpbGRyZW5baW5kZXhlc1tpXV0uZSAhPT0gbnVsbCAmJlxuICAgICAgICAgICAgICAgICBpPT09KGluZGV4ZXMubGVuZ3RoIC0gMSkpKSl7XG4gICAgICAgICAgICBjdXJyZW50VHJlZS5jaGlsZHJlbi5zcGxpY2UoaW5kZXhlc1tpXSwxKTtcbiAgICAgICAgICAgIGlzU3BsaXR0ZWQgPSB0cnVlO1xuICAgICAgICB9O1xuICAgICAgICBjdXJyZW50VHJlZSA9IGN1cnJlbnRUcmVlLmNoaWxkcmVuW2luZGV4ZXNbaV1dO1xuICAgICAgICArK2k7XG4gICAgfTtcbiAgICBpZiAoIWlzU3BsaXR0ZWQpeyBjdXJyZW50VHJlZS5lID0gbnVsbDt9O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNvbXBhcmlzb24gZnVuY3Rpb24gdXNlZCB0byBvcmRlciB0aGUgbGlzdCBvZiBjaGlsZHJlbiBhdCBlYWNoIG5vZGVcbiAqIFxccGFyYW0gbyB0aGUgb3RoZXIgbm9kZSB0byBjb21wYXJlIHdpdGhcbiAqL1xuTFNFUU5vZGUucHJvdG90eXBlLmNvbXBhcmUgPSBmdW5jdGlvbihvKXtcbiAgICByZXR1cm4gdGhpcy50LmNvbXBhcmUoby50KTtcbn07XG5cbi8qIVxuICogXFxicmllZiB0aGUgb3JkZXJlZCB0cmVlIGNhbiBiZSBsaW5lYXJpemVkIGludG8gYSBzZXF1ZW5jZS4gVGhpcyBmdW5jdGlvbiBnZXRcbiAqIHRoZSBpbmRleCBvZiB0aGUgcGF0aCByZXByZXNlbnRlZCBieSB0aGUgbGlzdCBvZiB0cmlwbGVzXG4gKiBcXHBhcmFtIG5vZGUgdGhlIG5vZGUgY29udGFpbmluZyB0aGUgcGF0aFxuICogXFxyZXR1cm4gdGhlIGluZGV4IG9mIHRoZSBwYXRoIGluIHRoZSBub2RlXG4gKi9cbkxTRVFOb2RlLnByb3RvdHlwZS5pbmRleE9mID0gZnVuY3Rpb24obm9kZSl7XG4gICAgdmFyIGluZGV4ZXMgPSB0aGlzLmdldEluZGV4ZXMobm9kZSksXG4gICAgICAgIHN1bSA9IDAsIGN1cnJlbnRUcmVlID0gdGhpcyxcbiAgICAgICAgaiA9IDA7XG4gICAgaWYgKGluZGV4ZXMgPT09IC0xKXtyZXR1cm4gLTE7fTsgLy8gbm9kZSBkb2VzIG5vdCBleGlzdFxuICAgIGlmICh0aGlzLmUgIT09IG51bGwpeyBzdW0gKz0xOyB9O1xuICAgIFxuICAgIGZvciAodmFyIGkgPSAwOyBpPGluZGV4ZXMubGVuZ3RoOyArK2kpe1xuICAgICAgICBpZiAoaW5kZXhlc1tpXSA8IChjdXJyZW50VHJlZS5jaGlsZHJlbi5sZW5ndGgvMikpe1xuICAgICAgICAgICAgLy8gI0Egc3RhcnQgZnJvbSB0aGUgYmVnaW5uaW5nXG4gICAgICAgICAgICBmb3IgKHZhciBqID0gMDsgajxpbmRleGVzW2ldOyArK2ope1xuICAgICAgICAgICAgICAgIGlmIChjdXJyZW50VHJlZS5jaGlsZHJlbltqXS5lICE9PSBudWxsKXsgc3VtKz0xOyB9O1xuICAgICAgICAgICAgICAgIHN1bSArPSBjdXJyZW50VHJlZS5jaGlsZHJlbltqXS5zdWJDb3VudGVyO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vICNCIHN0YXJ0IGZyb20gdGhlIGVuZFxuICAgICAgICAgICAgc3VtICs9IGN1cnJlbnRUcmVlLnN1YkNvdW50ZXI7XG4gICAgICAgICAgICBmb3IgKHZhciBqID0gY3VycmVudFRyZWUuY2hpbGRyZW4ubGVuZ3RoLTE7IGo+PWluZGV4ZXNbaV07LS1qKXtcbiAgICAgICAgICAgICAgICBpZiAoY3VycmVudFRyZWUuY2hpbGRyZW5bal0uZSAhPT0gbnVsbCl7IHN1bS09MTsgfTtcbiAgICAgICAgICAgICAgICBzdW0gLT0gY3VycmVudFRyZWUuY2hpbGRyZW5bal0uc3ViQ291bnRlcjsgIFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGogKz0gMTtcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKGN1cnJlbnRUcmVlLmNoaWxkcmVuW2pdLmUgIT09IG51bGwpeyBzdW0rPTE7IH07XG4gICAgICAgIGN1cnJlbnRUcmVlID0gY3VycmVudFRyZWUuY2hpbGRyZW5bal07XG4gICAgfTtcbiAgICByZXR1cm4gc3VtLTE7IC8vIC0xIGJlY2F1c2UgYWxnb3JpdGhtIGNvdW50ZWQgdGhlIGVsZW1lbnQgaXRzZWxmXG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0IHRoZSBsaXN0IG9mIGluZGV4ZXMgb2YgdGhlIGFycmF5cyByZXByZXNlbnRpbmcgdGhlIGNoaWxkcmVuIGluXG4gKiB0aGUgdHJlZVxuICogXFxwYXJhbSBub2RlIHRoZSBub2RlIGNvbnRhaW5pbmcgdGhlIHBhdGhcbiAqIFxccmV0dXJuIGEgbGlzdCBvZiBpbnRlZ2VyXG4gKi9cbkxTRVFOb2RlLnByb3RvdHlwZS5nZXRJbmRleGVzID0gZnVuY3Rpb24obm9kZSl7XG4gICAgZnVuY3Rpb24gX2dldEluZGV4ZXMoaW5kZXhlcywgY3VycmVudFRyZWUsIGN1cnJlbnROb2RlKXtcbiAgICAgICAgdmFyIGluZGV4ID0gY3VycmVudFRyZWUuY2hpbGRyZW4uYmluYXJ5SW5kZXhPZihjdXJyZW50Tm9kZSk7XG4gICAgICAgIGlmIChpbmRleCA8IDAgfHxcbiAgICAgICAgICAgIChpbmRleD09PTAgJiYgY3VycmVudFRyZWUuY2hpbGRyZW4ubGVuZ3RoPT09MCkpeyByZXR1cm4gLTE7IH1cbiAgICAgICAgaW5kZXhlcy5wdXNoKGluZGV4KTtcbiAgICAgICAgaWYgKGN1cnJlbnROb2RlLmNoaWxkcmVuLmxlbmd0aD09PTAgfHxcbiAgICAgICAgICAgIGN1cnJlbnRUcmVlLmNoaWxkcmVuLmxlbmd0aD09PTApe1xuICAgICAgICAgICAgcmV0dXJuIGluZGV4ZXM7XG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiBfZ2V0SW5kZXhlcyhpbmRleGVzLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudFRyZWUuY2hpbGRyZW5baW5kZXhdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudE5vZGUuY2hpbGRyZW5bMF0pO1xuICAgICAgICBcbiAgICB9O1xuICAgIHJldHVybiBfZ2V0SW5kZXhlcyhbXSwgdGhpcywgbm9kZSk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgdGhlIG9yZGVyZWQgdHJlZSBjYW4gYmUgbGluZWFyaXplZC4gVGhpcyBmdW5jdGlvbiBnZXRzIHRoZSBub2RlIGF0XG4gKiB0aGUgaW5kZXggaW4gdGhlIHByb2plY3RlZCBzZXF1ZW5jZS5cbiAqIFxccGFyYW0gaW5kZXggdGhlIGluZGV4IGluIHRoZSBzZXF1ZW5jZVxuICogXFxyZXR1cm5zIHRoZSBub2RlIGF0IHRoZSBpbmRleFxuICovXG5MU0VRTm9kZS5wcm90b3R5cGUuZ2V0ID0gZnVuY3Rpb24oaW5kZXgpe1xuICAgIGZ1bmN0aW9uIF9nZXQobGVmdFN1bSwgYnVpbGRpbmdOb2RlLCBxdWV1ZSwgY3VycmVudE5vZGUpe1xuICAgICAgICB2YXIgc3RhcnRCZWdpbm5pbmcgPSB0cnVlLCB1c2VGdW5jdGlvbiwgaSA9IDAsXG4gICAgICAgICAgICBwLCB0ZW1wO1xuICAgICAgICAvLyAjMCB0aGUgbm9kZSBpcyBmb3VuZCwgcmV0dXJuIHRoZSBpbmNyZW1lbnRhbGx5IGJ1aWx0IG5vZGUgYW5kIHByYWlzZVxuICAgICAgICAvLyAjdGhlIHN1biAhXG4gICAgICAgIGlmIChsZWZ0U3VtID09PSBpbmRleCAmJiBjdXJyZW50Tm9kZS5lICE9PSBudWxsKXtcbiAgICAgICAgICAgIC8vIDFhIGNvcHkgdGhlIHZhbHVlIG9mIHRoZSBlbGVtZW50IGluIHRoZSBwYXRoXG4gICAgICAgICAgICBxdWV1ZS5lID0gY3VycmVudE5vZGUuZTtcbiAgICAgICAgICAgIHJldHVybiBidWlsZGluZ05vZGU7XG4gICAgICAgIH07XG4gICAgICAgIGlmIChjdXJyZW50Tm9kZS5lICE9PSBudWxsKXsgbGVmdFN1bSArPSAxOyB9O1xuXG4gICAgICAgIC8vICMxIHNlYXJjaDogZG8gSSBzdGFydCBmcm9tIHRoZSBiZWdpbm5pbmcgb3IgdGhlIGVuZFxuICAgICAgICBzdGFydEJlZ2lubmluZyA9ICgoaW5kZXgtbGVmdFN1bSk8KGN1cnJlbnROb2RlLnN1YkNvdW50ZXIvMikpO1xuICAgICAgICBpZiAoc3RhcnRCZWdpbm5pbmcpe1xuICAgICAgICAgICAgdXNlRnVuY3Rpb24gPSBmdW5jdGlvbihhLGIpe3JldHVybiBhK2I7fTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxlZnRTdW0gKz0gY3VycmVudE5vZGUuc3ViQ291bnRlcjtcbiAgICAgICAgICAgIHVzZUZ1bmN0aW9uID0gZnVuY3Rpb24oYSxiKXtyZXR1cm4gYS1iO307XG4gICAgICAgIH1cblxuICAgICAgICAvLyAjMmEgY291bnRpbmcgdGhlIGVsZW1lbnQgZnJvbSBsZWZ0IHRvIHJpZ2h0XG4gICAgICAgIGlmICghc3RhcnRCZWdpbm5pbmcpIHsgaSA9IGN1cnJlbnROb2RlLmNoaWxkcmVuLmxlbmd0aC0xOyB9O1xuICAgICAgICB3aGlsZSAoKHN0YXJ0QmVnaW5uaW5nICYmIGxlZnRTdW0gPD0gaW5kZXgpIHx8XG4gICAgICAgICAgICAgICAoIXN0YXJ0QmVnaW5uaW5nICYmIGxlZnRTdW0gPiBpbmRleCkpe1xuICAgICAgICAgICAgaWYgKGN1cnJlbnROb2RlLmNoaWxkcmVuW2ldLmUhPT1udWxsKXtcbiAgICAgICAgICAgICAgICBsZWZ0U3VtID0gdXNlRnVuY3Rpb24obGVmdFN1bSwgMSk7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgbGVmdFN1bSA9IHVzZUZ1bmN0aW9uKGxlZnRTdW0sY3VycmVudE5vZGUuY2hpbGRyZW5baV0uc3ViQ291bnRlcik7XG4gICAgICAgICAgICBpID0gdXNlRnVuY3Rpb24oaSwgMSk7XG4gICAgICAgIH07XG5cbiAgICAgICAgLy8gIzJiIGRlY3JlYXNpbmcgdGhlIGluY3JlbWVudGF0aW9uXG4gICAgICAgIGkgPSB1c2VGdW5jdGlvbihpLC0xKTtcbiAgICAgICAgaWYgKHN0YXJ0QmVnaW5uaW5nKXtcbiAgICAgICAgICAgIGlmIChjdXJyZW50Tm9kZS5jaGlsZHJlbltpXS5lIT09bnVsbCl7XG4gICAgICAgICAgICAgICAgbGVmdFN1bSA9IHVzZUZ1bmN0aW9uKGxlZnRTdW0sIC0xKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBsZWZ0U3VtID0gdXNlRnVuY3Rpb24obGVmdFN1bSwtY3VycmVudE5vZGUuY2hpbGRyZW5baV0uc3ViQ291bnRlcik7XG4gICAgICAgIH07XG4gICAgICAgIFxuICAgICAgICAvLyAjMyBidWlsZCBwYXRoXG4gICAgICAgIHAgPSBbXTsgcC5wdXNoKGN1cnJlbnROb2RlLmNoaWxkcmVuW2ldLnQpO1xuICAgICAgICBpZiAoYnVpbGRpbmdOb2RlID09PSBudWxsKXtcbiAgICAgICAgICAgIGJ1aWxkaW5nTm9kZSA9IG5ldyBMU0VRTm9kZShwLG51bGwpO1xuICAgICAgICAgICAgcXVldWUgPSBidWlsZGluZ05vZGU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0ZW1wID0gbmV3IExTRVFOb2RlKHAsbnVsbCk7XG4gICAgICAgICAgICBxdWV1ZS5hZGQodGVtcCk7XG4gICAgICAgICAgICBxdWV1ZSA9IHRlbXA7XG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiBfZ2V0KGxlZnRTdW0sIGJ1aWxkaW5nTm9kZSwgcXVldWUsXG4gICAgICAgICAgICAgICAgICAgIGN1cnJlbnROb2RlLmNoaWxkcmVuW2ldKTtcbiAgICB9O1xuICAgIHJldHVybiBfZ2V0KDAsIG51bGwsIG51bGwsIHRoaXMpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNhc3QgdGhlIEpTT04gb2JqZWN0IHRvIGEgTFNFUU5vZGVcbiAqIFxccGFyYW0gb2JqZWN0IHRoZSBKU09OIG9iamVjdFxuICogXFxyZXR1cm4gYSBzZWxmIHJlZmVyZW5jZVxuICovXG5MU0VRTm9kZS5wcm90b3R5cGUuZnJvbUpTT04gPSBmdW5jdGlvbihvYmplY3Qpe1xuICAgIHRoaXMudCA9IG5ldyBUcmlwbGUob2JqZWN0LnQucCwgb2JqZWN0LnQucywgb2JqZWN0LnQuYyk7XG4gICAgaWYgKG9iamVjdC5jaGlsZHJlbi5sZW5ndGggPT09IDApe1xuICAgICAgICB0aGlzLmUgPSBvYmplY3QuZTtcbiAgICAgICAgdGhpcy5zdWJDb3VudGVyID0gMDtcbiAgICAgICAgdGhpcy5jaGlsZHJlbiA9IFtdO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuZSA9IG51bGw7XG4gICAgICAgIHRoaXMuc3ViQ291bnRlciA9IDE7XG4gICAgICAgIHRoaXMuY2hpbGRyZW4gPSBbXTtcbiAgICAgICAgdGhpcy5jaGlsZHJlbi5wdXNoKFxuICAgICAgICAgICAgKG5ldyBMU0VRTm9kZShbXSwgbnVsbCkuZnJvbUpTT04ob2JqZWN0LmNoaWxkcmVuWzBdKSkpO1xuICAgIH07XG4gICAgcmV0dXJuIHRoaXM7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IExTRVFOb2RlO1xuIiwidmFyIEJJID0gcmVxdWlyZSgnQmlnSW50Jyk7XG52YXIgQmFzZSA9IHJlcXVpcmUoJy4vYmFzZS5qcycpKDE1KTtcbnZhciBTID0gcmVxdWlyZSgnLi9zdHJhdGVneS5qcycpKDEwKTtcbnZhciBJRCA9IHJlcXVpcmUoJy4vaWRlbnRpZmllci5qcycpO1xudmFyIFRyaXBsZSA9IHJlcXVpcmUoJy4vdHJpcGxlLmpzJyk7XG52YXIgTFNFUU5vZGUgPSByZXF1aXJlKCcuL2xzZXFub2RlLmpzJyk7XG5cbi8qIVxuICogXFxjbGFzcyBMU0VRVHJlZVxuICpcbiAqIFxcYnJpZWYgRGlzdHJpYnV0ZWQgYXJyYXkgdXNpbmcgTFNFUSBhbGxvY2F0aW9uIHN0cmF0ZWd5IHdpdGggYW4gdW5kZXJseWluZ1xuICogZXhwb25lbnRpYWwgdHJlZSBtb2RlbFxuICovXG5mdW5jdGlvbiBMU0VRVHJlZShzKXtcbiAgICB2YXIgbGlzdFRyaXBsZTtcbiAgICBcbiAgICB0aGlzLl9zID0gcztcbiAgICB0aGlzLl9jID0gMDtcbiAgICB0aGlzLl9oYXNoID0gZnVuY3Rpb24oZGVwdGgpIHsgcmV0dXJuIGRlcHRoJTI7IH07XG4gICAgdGhpcy5sZW5ndGggPSAwO1xuXG4gICAgdGhpcy5yb290ID0gbmV3IExTRVFOb2RlKFtdLG51bGwpO1xuICAgIGxpc3RUcmlwbGUgPSBbXTsgbGlzdFRyaXBsZS5wdXNoKG5ldyBUcmlwbGUoMCwwLDApKTsgIC8vIG1pbiBib3VuZFxuICAgIHRoaXMucm9vdC5hZGQobmV3IExTRVFOb2RlKGxpc3RUcmlwbGUsIFwiXCIpKTtcbiAgICBsaXN0VHJpcGxlID0gW107XG4gICAgbGlzdFRyaXBsZS5wdXNoKG5ldyBUcmlwbGUoTWF0aC5wb3coMixCYXNlLmdldEJpdEJhc2UoMCkpLTEsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgTnVtYmVyLk1BWF9WQUxVRSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBOdW1iZXIuTUFYX1ZBTFVFKSk7IC8vIG1heCBib3VuZFxuICAgIHRoaXMucm9vdC5hZGQobmV3IExTRVFOb2RlKGxpc3RUcmlwbGUsIFwiXCIpKTtcbn07XG5cbi8qIVxuICogXFxicmllZiByZXR1cm4gdGhlIExTRVFOb2RlIG9mIHRoZSBlbGVtZW50IGF0ICB0YXJnZXRlZCBpbmRleFxuICogXFxwYXJhbSBpbmRleCB0aGUgaW5kZXggb2YgdGhlIGVsZW1lbnQgaW4gdGhlIGZsYXR0ZW5lZCBhcnJheVxuICogXFxyZXR1cm4gdGhlIExTRVFOb2RlIHRhcmdldGluZyB0aGUgZWxlbWVudCBhdCBpbmRleFxuICovXG5MU0VRVHJlZS5wcm90b3R5cGUuZ2V0ID0gZnVuY3Rpb24oaW5kZXgpe1xuICAgIC8vICMxIHNlYXJjaCBpbiB0aGUgdHJlZSB0byBnZXQgdGhlIHZhbHVlXG4gICAgcmV0dXJuIHRoaXMucm9vdC5nZXQoaW5kZXgpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGluc2VydCBhIHZhbHVlIGF0IHRoZSB0YXJnZXRlZCBpbmRleFxuICogXFxwYXJhbSBlbGVtZW50IHRoZSBlbGVtZW50IHRvIGluc2VydFxuICogXFxwYXJhbSBpbmRleCB0aGUgcG9zaXRpb24gaW4gdGhlIGFycmF5XG4gKiBcXHJldHVybiBhIHBhaXIge19lOiBlbGVtZW50ICwgX2k6IGlkZW50aWZpZXJ9XG4gKi9cbkxTRVFUcmVlLnByb3RvdHlwZS5pbnNlcnQgPSBmdW5jdGlvbihlbGVtZW50LCBpbmRleCl7XG4gICAgdmFyIHBlaSA9IHRoaXMuZ2V0KGluZGV4KSwgLy8gIzFhIHByZXZpb3VzIGJvdW5kXG4gICAgICAgIHFlaSA9IHRoaXMuZ2V0KGluZGV4KzEpLCAvLyAjMWIgbmV4dCBib3VuZFxuICAgICAgICBpZCwgY291cGxlO1xuICAgIHRoaXMuX2MgKz0gMTsgLy8gIzJhIGluY3JlbWVudGluZyB0aGUgbG9jYWwgY291bnRlclxuICAgIGlkID0gdGhpcy5hbGxvYyhwZWksIHFlaSk7IC8vICMyYiBnZW5lcmF0aW5nIHRoZSBpZCBpbmJldHdlZW4gdGhlIGJvdW5kc1xuICAgIC8vICMzIGFkZCBpdCB0byB0aGUgc3RydWN0dXJlIGFuZCByZXR1cm4gdmFsdWVcbiAgICBjb3VwbGUgPSB7X2U6IGVsZW1lbnQsIF9pOiBpZH1cbiAgICB0aGlzLmFwcGx5SW5zZXJ0KGVsZW1lbnQsIGlkLCB0cnVlKTtcbiAgICByZXR1cm4gY291cGxlO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGRlbGV0ZSB0aGUgZWxlbWVudCBhdCB0aGUgaW5kZXhcbiAqIFxccGFyYW0gaW5kZXggdGhlIGluZGV4IG9mIHRoZSBlbGVtZW50IHRvIGRlbGV0ZSBpbiB0aGUgYXJyYXlcbiAqIFxccmV0dXJuIHRoZSBpZGVudGlmaWVyIG9mIHRoZSBlbGVtZW50IGF0IHRoZSBpbmRleFxuICovXG5MU0VRVHJlZS5wcm90b3R5cGUucmVtb3ZlID0gZnVuY3Rpb24oaW5kZXgpe1xuICAgIHZhciBlaSA9IHRoaXMuZ2V0KGluZGV4KzEpLFxuICAgICAgICBpID0gbmV3IElEKG51bGwsIFtdLCBbXSk7XG4gICAgaS5mcm9tTm9kZShlaSk7IC8vIGZyb20gbm9kZSAtPiBpZFxuICAgIHRoaXMuYXBwbHlSZW1vdmUoZWkpOyBcbiAgICByZXR1cm4gaTtcbn07XG5cbi8qIVxuICogXFxicmllZiBnZW5lcmF0ZSB0aGUgZGlnaXQgcGFydCBvZiB0aGUgaWRlbnRpZmllcnMgIGJldHdlZW4gcCBhbmQgcVxuICogXFxwYXJhbSBwIHRoZSBkaWdpdCBwYXJ0IG9mIHRoZSBwcmV2aW91cyBpZGVudGlmaWVyXG4gKiBcXHBhcmFtIHEgdGhlIGRpZ2l0IHBhcnQgb2YgdGhlIG5leHQgaWRlbnRpZmllclxuICogXFxyZXR1cm4gdGhlIGRpZ2l0IHBhcnQgbG9jYXRlZCBiZXR3ZWVuIHAgYW5kIHFcbiAqL1xuTFNFUVRyZWUucHJvdG90eXBlLmFsbG9jID0gZnVuY3Rpb24gKHAscSl7XG4gICAgdmFyIGludGVydmFsID0gMCwgbGV2ZWwgPSAwO1xuICAgIC8vICMxIHByb2Nlc3MgdGhlIGxldmVsIG9mIHRoZSBuZXcgaWRlbnRpZmllclxuICAgIHdoaWxlIChpbnRlcnZhbDw9MCl7IC8vIG5vIHJvb20gZm9yIGluc2VydGlvblxuICAgICAgICBpbnRlcnZhbCA9IEJhc2UuZ2V0SW50ZXJ2YWwocCwgcSwgbGV2ZWwpOyAvLyAoVE9ETykgb3B0aW1pemVcbiAgICAgICAgKytsZXZlbDtcbiAgICB9O1xuICAgIGxldmVsIC09IDE7XG4gICAgaWYgKHRoaXMuX2hhc2gobGV2ZWwpID09PSAwKXtcbiAgICAgICAgcmV0dXJuIFMuYlBsdXMocCwgcSwgbGV2ZWwsIGludGVydmFsLCB0aGlzLl9zLCB0aGlzLl9jKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gUy5iTWludXMocCwgcSwgbGV2ZWwsIGludGVydmFsLCB0aGlzLl9zLCB0aGlzLl9jKTtcbiAgICB9O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGluc2VydCBhbiBlbGVtZW50IGNyZWF0ZWQgZnJvbSBhIHJlbW90ZSBzaXRlIGludG8gdGhlIGFycmF5XG4gKiBcXHBhcmFtIGUgdGhlIGVsZW1lbnQgdG8gaW5zZXJ0XG4gKiBcXHBhcmFtIGkgdGhlIGlkZW50aWZpZXIgb2YgdGhlIGVsZW1lbnRcbiAqIFxccGFyYW0gbm9JbmRleCB3aGV0aGVyIG9yIG5vdCBpdCBzaG91bGQgcmV0dXJuIHRoZSBpbmRleCBvZiB0aGUgaW5zZXJ0XG4gKiBcXHJldHVybiB0aGUgaW5kZXggb2YgdGhlIG5ld2x5IGluc2VydGVkIGVsZW1lbnQgaW4gdGhlIGFycmF5XG4gKi9cbkxTRVFUcmVlLnByb3RvdHlwZS5hcHBseUluc2VydCA9IGZ1bmN0aW9uKGUsIGksIG5vSW5kZXgpe1xuICAgIHZhciBub2RlLCByZXN1bHQ7XG4gICAgLy8gIzAgY2FzdCBmcm9tIHRoZSBwcm9wZXIgdHlwZVxuICAgIC8vICMwQSB0aGUgaWRlbnRpZmllciBpcyBhbiBJRFxuICAgIGlmIChpICYmIGkuX2QgJiYgaS5fcyAmJiBpLl9jKXtcbiAgICAgICAgbm9kZSA9IChuZXcgSUQoaS5fZCwgaS5fcywgaS5fYykudG9Ob2RlKGUpKTtcbiAgICB9O1xuICAgIC8vICMwQiB0aGUgaWRlbnRpZmllciBpcyBhIExTRVFOb2RlXG4gICAgaWYgKGkgJiYgaS50ICYmIGkuY2hpbGRyZW4pe1xuICAgICAgICBub2RlID0gKG5ldyBMU0VRTm9kZShbXSxudWxsKSkuZnJvbUpTT04oaSk7XG4gICAgfTtcbiAgICAvLyAjMiBpbnRlZ3JhdGVzIHRoZSBuZXcgZWxlbWVudCB0byB0aGUgZGF0YSBzdHJ1Y3R1cmVcbiAgICByZXN1bHQgPSB0aGlzLnJvb3QuYWRkKG5vZGUpO1xuICAgIGlmIChyZXN1bHQgIT09IC0xKXtcbiAgICAgICAgLy8gIzMgaWYgdGhlIGVsZW1lbnQgYXMgYmVlbiBhZGRlZFxuICAgICAgICB0aGlzLmxlbmd0aCArPSAxO1xuICAgIH07XG4gICAgcmV0dXJuIHJlc3VsdCB8fCAoIW5vSW5kZXggJiYgdGhpcy5yb290LmluZGV4T2Yobm9kZSkpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGRlbGV0ZSB0aGUgZWxlbWVudCB3aXRoIHRoZSB0YXJnZXRlZCBpZGVudGlmaWVyXG4gKiBcXHBhcmFtIGkgdGhlIGlkZW50aWZpZXIgb2YgdGhlIGVsZW1lbnRcbiAqIFxccmV0dXJuIHRoZSBpbmRleCBvZiB0aGUgZWxlbWVudCBmZXNobHkgZGVsZXRlZCwgLTEgaWYgbm8gcmVtb3ZhbFxuICovXG5MU0VRVHJlZS5wcm90b3R5cGUuYXBwbHlSZW1vdmUgPSBmdW5jdGlvbihpKXtcbiAgICB2YXIgbm9kZSwgcG9zaXRpb247XG4gICAgLy8gIzAgY2FzdCBmcm9tIHRoZSBwcm9wZXIgdHlwZVxuICAgIGlmIChpICYmIGkuX2QgJiYgaS5fcyAmJiBpLl9jKXtcbiAgICAgICAgbm9kZSA9IChuZXcgSUQoaS5fZCwgaS5fcywgaS5fYykpLnRvTm9kZShudWxsKTtcbiAgICB9O1xuICAgIC8vICMwQiB0aGUgaWRlbnRpZmllciBpcyBhIExTRVFOb2RlXG4gICAgaWYgKGkgJiYgaS50ICYmIGkuY2hpbGRyZW4pe1xuICAgICAgICBub2RlID0gKG5ldyBMU0VRTm9kZShbXSxudWxsKSkuZnJvbUpTT04oaSk7XG4gICAgfTtcbiAgICAvLyAjMSBnZXQgdGhlIGluZGV4IG9mIHRoZSBlbGVtZW50IHRvIHJlbW92ZVxuICAgIHBvc2l0aW9uID0gdGhpcy5yb290LmluZGV4T2Yobm9kZSk7XG4gICAgaWYgKHBvc2l0aW9uICE9PSAtMSl7XG4gICAgICAgIC8vICMyIGlmIGl0IGV4aXN0cyByZW1vdmUgaXRcbiAgICAgICAgdGhpcy5yb290LmRlbChub2RlKTtcbiAgICAgICAgdGhpcy5sZW5ndGggLT0gMTtcbiAgICB9O1xuICAgIHJldHVybiBwb3NpdGlvbjtcbn07XG5cblxuLyohXG4gKiBcXGJyaWVmIGNhc3QgdGhlIEpTT04gb2JqZWN0IGludG8gYSBwcm9wZXIgTFNFUVRyZWUuXG4gKiBcXHBhcmFtIG9iamVjdCB0aGUgSlNPTiBvYmplY3QgdG8gY2FzdFxuICogXFxyZXR1cm4gYSBzZWxmIHJlZmVyZW5jZVxuICovXG5MU0VRVHJlZS5wcm90b3R5cGUuZnJvbUpTT04gPSBmdW5jdGlvbihvYmplY3Qpe1xuICAgIC8vICMxIGNvcHkgdGhlIHNvdXJjZSwgY291bnRlciwgYW5kIGxlbmd0aCBvZiB0aGUgb2JqZWN0XG4gICAgdGhpcy5fcyA9IG9iamVjdC5fcztcbiAgICB0aGlzLl9jID0gb2JqZWN0Ll9jO1xuICAgIHRoaXMubGVuZ3RoID0gb2JqZWN0Lmxlbmd0aDtcbiAgICAvLyAjMiBkZXB0aCBmaXJzdCBhZGRpbmdcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgZnVuY3Rpb24gZGVwdGhGaXJzdChjdXJyZW50Tm9kZSwgY3VycmVudFBhdGgpe1xuICAgICAgICB2YXIgdHJpcGxlID0gbmV3IFRyaXBsZShjdXJyZW50Tm9kZS50LnAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnROb2RlLnQucyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudE5vZGUudC5jKTtcbiAgICAgICAgY3VycmVudFBhdGgucHVzaCh0cmlwbGUpO1xuICAgICAgICBpZiAoY3VycmVudE5vZGUuZSE9PW51bGwpe1xuICAgICAgICAgICAgc2VsZi5yb290LmFkZChuZXcgTFNFUU5vZGUoY3VycmVudFBhdGgsIGN1cnJlbnROb2RlLmUpKTtcbiAgICAgICAgfTtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGk8Y3VycmVudE5vZGUuY2hpbGRyZW4ubGVuZ3RoOyArK2kpe1xuICAgICAgICAgICAgZGVwdGhGaXJzdChjdXJyZW50Tm9kZS5jaGlsZHJlbltpXSwgY3VycmVudFBhdGgpO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgZm9yICh2YXIgaSA9IDA7IGk8b2JqZWN0LnJvb3QuY2hpbGRyZW4ubGVuZ3RoOyArK2kpe1xuICAgICAgICBkZXB0aEZpcnN0KG9iamVjdC5yb290LCBbXSk7XG4gICAgfTtcbiAgICByZXR1cm4gdGhpcztcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gTFNFUVRyZWU7XG4iLCJ2YXIgQkkgPSByZXF1aXJlKCdCaWdJbnQnKTtcbnZhciBCYXNlID0gcmVxdWlyZSgnLi9iYXNlLmpzJykoKTtcbnZhciBJRCA9IHJlcXVpcmUoJy4vaWRlbnRpZmllci5qcycpO1xuXG4vKiFcbiAqIFxcY2xhc3MgU3RyYXRlZ3lcbiAqIFxcYnJpZWYgRW51bWVyYXRlIHRoZSBhdmFpbGFibGUgc3ViLWFsbG9jYXRpb24gc3RyYXRlZ2llcy4gVGhlIHNpZ25hdHVyZSBvZlxuICogdGhlc2UgZnVuY3Rpb25zIGlzIGYoSWQsIElkLCBOKywgTissIE4sIE4pOiBJZC5cbiAqIFxccGFyYW0gYm91bmRhcnkgdGhlIHZhbHVlIHVzZWQgYXMgdGhlIGRlZmF1bHQgbWF4aW11bSBzcGFjaW5nIGJldHdlZW4gaWRzXG4gKi9cbmZ1bmN0aW9uIFN0cmF0ZWd5KGJvdW5kYXJ5KXtcbiAgICB2YXIgREVGQVVMVF9CT1VOREFSWSA9IDEwO1xuICAgIHRoaXMuX2JvdW5kYXJ5ID0gYm91bmRhcnkgfHwgREVGQVVMVF9CT1VOREFSWTtcbn07XG5cbi8qIVxuICogXFxicmllZiBDaG9vc2UgYW4gaWQgc3RhcnRpbmcgZnJvbSBwcmV2aW91cyBib3VuZCBhbmQgYWRkaW5nIHJhbmRvbSBudW1iZXJcbiAqIFxccGFyYW0gcCB0aGUgcHJldmlvdXMgaWRlbnRpZmllclxuICogXFxwYXJhbSBxIHRoZSBuZXh0IGlkZW50aWZpZXJcbiAqIFxccGFyYW0gbGV2ZWwgdGhlIG51bWJlciBvZiBjb25jYXRlbmF0aW9uIGNvbXBvc2luZyB0aGUgbmV3IGlkZW50aWZpZXJcbiAqIFxccGFyYW0gaW50ZXJ2YWwgdGhlIGludGVydmFsIGJldHdlZW4gcCBhbmQgcVxuICogXFxwYXJhbSBzIHRoZSBzb3VyY2UgdGhhdCBjcmVhdGVzIHRoZSBuZXcgaWRlbnRpZmllclxuICogXFxwYXJhbSBjIHRoZSBjb3VudGVyIG9mIHRoYXQgc291cmNlXG4gKi9cblN0cmF0ZWd5LnByb3RvdHlwZS5iUGx1cyA9IGZ1bmN0aW9uIChwLCBxLCBsZXZlbCwgaW50ZXJ2YWwsIHMsIGMpe1xuICAgIHZhciBjb3B5UCA9IHAsIGNvcHlRID0gcSxcbiAgICAgICAgc3RlcCA9IE1hdGgubWluKHRoaXMuX2JvdW5kYXJ5LCBpbnRlcnZhbCksIC8vIzAgdGhlIG1pbiBpbnRlcnZhbFxuICAgICAgICBkaWdpdCA9IEJJLmludDJiaWdJbnQoMCxCYXNlLmdldFN1bUJpdChsZXZlbCkpLFxuICAgICAgICB2YWx1ZTtcbiAgICBcbiAgICAvLyAjMSBjb3B5IHRoZSBwcmV2aW91cyBpZGVudGlmaWVyXG4gICAgZm9yICh2YXIgaSA9IDA7IGk8PWxldmVsOysraSl7XG5cdCAgICAgIHZhbHVlID0gMDtcbiAgICAgICAgaWYgKHAhPT1udWxsKXsgdmFsdWUgPSBwLnQucDsgfTtcbiAgICAgICAgQkkuYWRkSW50XyhkaWdpdCx2YWx1ZSk7XG4gICAgICAgIGlmIChpIT09bGV2ZWwpeyBCSS5sZWZ0U2hpZnRfKGRpZ2l0LEJhc2UuZ2V0Qml0QmFzZShpKzEpKTsgfTtcbiAgICAgICAgaWYgKHAhPT1udWxsICYmIHAuY2hpbGRyZW4ubGVuZ3RoIT09MCl7XG4gICAgICAgICAgICBwID0gcC5jaGlsZHJlblswXTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHAgPSBudWxsO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgLy8gIzIgY3JlYXRlIGEgZGlnaXQgZm9yIGFuIGlkZW50aWZpZXIgYnkgYWRkaW5nIGEgcmFuZG9tIHZhbHVlXG4gICAgLy8gIzJhIERpZ2l0XG4gICAgQkkuYWRkSW50XyhkaWdpdCwgTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKnN0ZXArMSkpO1xuICAgIC8vICMyYiBTb3VyY2UgJiBjb3VudGVyXG4gICAgcmV0dXJuIGdldFNDKGRpZ2l0LCBjb3B5UCwgY29weVEsIGxldmVsLCBzLCBjKTtcbn07XG5cblxuLyohXG4gKiBcXGJyaWVmIENob29zZSBhbiBpZCBzdGFydGluZyBmcm9tIG5leHQgYm91bmQgYW5kIHN1YnN0cmFjdCBhIHJhbmRvbSBudW1iZXJcbiAqIFxccGFyYW0gcCB0aGUgcHJldmlvdXMgaWRlbnRpZmllclxuICogXFxwYXJhbSBxIHRoZSBuZXh0IGlkZW50aWZpZXJcbiAqIFxccGFyYW0gbGV2ZWwgdGhlIG51bWJlciBvZiBjb25jYXRlbmF0aW9uIGNvbXBvc2luZyB0aGUgbmV3IGlkZW50aWZpZXJcbiAqIFxccGFyYW0gaW50ZXJ2YWwgdGhlIGludGVydmFsIGJldHdlZW4gcCBhbmQgcVxuICogXFxwYXJhbSBzIHRoZSBzb3VyY2UgdGhhdCBjcmVhdGVzIHRoZSBuZXcgaWRlbnRpZmllclxuICogXFxwYXJhbSBjIHRoZSBjb3VudGVyIG9mIHRoYXQgc291cmNlXG4gKi9cblN0cmF0ZWd5LnByb3RvdHlwZS5iTWludXMgPSBmdW5jdGlvbiAocCwgcSwgbGV2ZWwsIGludGVydmFsLCBzLCBjKXtcbiAgICB2YXIgY29weVAgPSBwLCBjb3B5USA9IHEsXG4gICAgICAgIHN0ZXAgPSBNYXRoLm1pbih0aGlzLl9ib3VuZGFyeSwgaW50ZXJ2YWwpLCAvLyAjMCBwcm9jZXNzIG1pbiBpbnRlcnZhbFxuICAgICAgICBkaWdpdCA9IEJJLmludDJiaWdJbnQoMCxCYXNlLmdldFN1bUJpdChsZXZlbCkpLFxuICAgICAgICBwSXNHcmVhdGVyID0gZmFsc2UsIGNvbW1vblJvb3QgPSB0cnVlLFxuICAgICAgICBwcmV2VmFsdWUsIG5leHRWYWx1ZTtcbiAgICBcbiAgICAvLyAjMSBjb3B5IG5leHQsIGlmIHByZXZpb3VzIGlzIGdyZWF0ZXIsIGNvcHkgbWF4VmFsdWUgQCBkZXB0aFxuICAgIGZvciAodmFyIGkgPSAwOyBpPD1sZXZlbDsrK2kpe1xuICAgICAgICBwcmV2VmFsdWUgPSAwOyBpZiAocCAhPT0gbnVsbCl7IHByZXZWYWx1ZSA9IHAudC5wOyB9XG4gICAgICAgIG5leHRWYWx1ZSA9IDA7IGlmIChxICE9PSBudWxsKXsgbmV4dFZhbHVlID0gcS50LnA7IH1cbiAgICAgICAgaWYgKGNvbW1vblJvb3QgJiYgcHJldlZhbHVlICE9PSBuZXh0VmFsdWUpe1xuICAgICAgICAgICAgY29tbW9uUm9vdCA9IGZhbHNlO1xuICAgICAgICAgICAgcElzR3JlYXRlciA9IHByZXZWYWx1ZSA+IG5leHRWYWx1ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocElzR3JlYXRlcil7IG5leHRWYWx1ZSA9IE1hdGgucG93KDIsQmFzZS5nZXRCaXRCYXNlKGkpKS0xOyB9XG4gICAgICAgIEJJLmFkZEludF8oZGlnaXQsIG5leHRWYWx1ZSk7XG4gICAgICAgIGlmIChpIT09bGV2ZWwpeyBCSS5sZWZ0U2hpZnRfKGRpZ2l0LEJhc2UuZ2V0Qml0QmFzZShpKzEpKTsgfVxuICAgICAgICBpZiAocSE9PW51bGwgJiYgcS5jaGlsZHJlbi5sZW5ndGghPT0wKXtcbiAgICAgICAgICAgIHEgPSBxLmNoaWxkcmVuWzBdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcSA9IG51bGw7XG4gICAgICAgIH07XG4gICAgICAgIGlmIChwIT09bnVsbCAmJiBwLmNoaWxkcmVuLmxlbmd0aCE9PTApe1xuICAgICAgICAgICAgcCA9IHAuY2hpbGRyZW5bMF07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBwID0gbnVsbDtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIC8vICMzIGNyZWF0ZSBhIGRpZ2l0IGZvciBhbiBpZGVudGlmaWVyIGJ5IHN1YmluZyBhIHJhbmRvbSB2YWx1ZVxuICAgIC8vICMzYSBEaWdpdFxuICAgIGlmIChwSXNHcmVhdGVyKXtcbiAgICAgICAgQkkuYWRkSW50XyhkaWdpdCwgLU1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSpzdGVwKSApO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIEJJLmFkZEludF8oZGlnaXQsIC1NYXRoLmZsb29yKE1hdGgucmFuZG9tKCkqc3RlcCktMSApO1xuICAgIH07XG4gICAgXG4gICAgLy8gIzNiIFNvdXJjZSAmIGNvdW50ZXJcbiAgICByZXR1cm4gZ2V0U0MoZGlnaXQsIGNvcHlQLCBjb3B5USwgbGV2ZWwsIHMsIGMpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNvcGllcyB0aGUgYXBwcm9wcmlhdGVzIHNvdXJjZSBhbmQgY291bnRlciBmcm9tIHRoZSBhZGphY2VudCBcbiAqIGlkZW50aWZpZXJzIGF0IHRoZSBpbnNlcnRpb24gcG9zaXRpb24uXG4gKiBcXHBhcmFtIGQgdGhlIGRpZ2l0IHBhcnQgb2YgdGhlIG5ldyBpZGVudGlmaWVyXG4gKiBcXHBhcmFtIHAgdGhlIHByZXZpb3VzIGlkZW50aWZpZXJcbiAqIFxccGFyYW0gcSB0aGUgbmV4dCBpZGVudGlmaWVyXG4gKiBcXHBhcmFtIGxldmVsIHRoZSBzaXplIG9mIHRoZSBuZXcgaWRlbnRpZmllclxuICogXFxwYXJhbSBzIHRoZSBsb2NhbCBzaXRlIGlkZW50aWZpZXIgXG4gKiBcXHBhcmFtIGMgdGhlIGxvY2FsIG1vbm90b25pYyBjb3VudGVyXG4gKi9cbmZ1bmN0aW9uIGdldFNDKGQsIHAsIHEsIGxldmVsLCBzLCBjKXtcbiAgICB2YXIgc291cmNlcyA9IFtdLCBjb3VudGVycyA9IFtdLFxuICAgICAgICBpID0gMCxcbiAgICAgICAgc3VtQml0ID0gQmFzZS5nZXRTdW1CaXQobGV2ZWwpLFxuICAgICAgICB0ZW1wRGlnaXQsIHZhbHVlO1xuICAgIFxuICAgIHdoaWxlIChpPD1sZXZlbCl7XG4gICAgICAgIHRlbXBEaWdpdCA9IEJJLmR1cChkKTtcbiAgICAgICAgQkkucmlnaHRTaGlmdF8odGVtcERpZ2l0LCBzdW1CaXQgLSBCYXNlLmdldFN1bUJpdChpKSk7XG4gICAgICAgIHZhbHVlID0gQkkubW9kSW50KHRlbXBEaWdpdCxNYXRoLnBvdygyLEJhc2UuZ2V0Qml0QmFzZShpKSkpO1xuICAgICAgICBzb3VyY2VzW2ldPXM7XG4gICAgICAgIGNvdW50ZXJzW2ldPWNcbiAgICAgICAgaWYgKHEhPT1udWxsICYmIHEudC5wPT09dmFsdWUpeyBzb3VyY2VzW2ldPXEudC5zOyBjb3VudGVyc1tpXT1xLnQuY307XG4gICAgICAgIGlmIChwIT09bnVsbCAmJiBwLnQucD09PXZhbHVlKXsgc291cmNlc1tpXT1wLnQuczsgY291bnRlcnNbaV09cC50LmN9O1xuICAgICAgICBpZiAocSE9PW51bGwgJiYgcS5jaGlsZHJlbi5sZW5ndGghPT0wKXtcbiAgICAgICAgICAgIHEgPSBxLmNoaWxkcmVuWzBdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcSA9IG51bGw7XG4gICAgICAgIH07XG4gICAgICAgIGlmIChwIT09bnVsbCAmJiBwLmNoaWxkcmVuLmxlbmd0aCE9PTApe1xuICAgICAgICAgICAgcCA9IHAuY2hpbGRyZW5bMF07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBwID0gbnVsbDtcbiAgICAgICAgfTtcbiAgICAgICAgKytpO1xuICAgIH07XG4gICAgXG4gICAgcmV0dXJuIG5ldyBJRChkLCBzb3VyY2VzLCBjb3VudGVycyk7XG59O1xuXG5TdHJhdGVneS5pbnN0YW5jZSA9IG51bGw7XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oYXJncyl7XG4gICAgaWYgKGFyZ3Mpe1xuICAgICAgICBTdHJhdGVneS5pbnN0YW5jZSA9IG5ldyBTdHJhdGVneShhcmdzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoU3RyYXRlZ3kuaW5zdGFuY2UgPT09IG51bGwpe1xuICAgICAgICAgICAgU3RyYXRlZ3kuaW5zdGFuY2UgPSBuZXcgU3RyYXRlZ3koKTtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIHJldHVybiBTdHJhdGVneS5pbnN0YW5jZTtcbn07XG4iLCJcbi8qIVxuICogXFxicmllZiB0cmlwbGUgdGhhdCBjb250YWlucyBhIDxwYXRoIHNpdGUgY291bnRlcj5cbiAqIFxccGFyYW0gcGF0aCB0aGUgcGFydCBvZiB0aGUgcGF0aCBpbiB0aGUgdHJlZVxuICogXFxwYXJhbSBzaXRlIHRoZSB1bmlxdWUgc2l0ZSBpZGVudGlmaWVyIHRoYXQgY3JlYXRlZCB0aGUgdHJpcGxlXG4gKiBcXHBhcmFtIGNvdW50ZXIgdGhlIGNvdW50ZXIgb2YgdGhlIHNpdGUgd2hlbiBpdCBjcmVhdGVkIHRoZSB0cmlwbGVcbiAqL1xuZnVuY3Rpb24gVHJpcGxlKHBhdGgsIHNpdGUsIGNvdW50ZXIpe1xuICAgIHRoaXMucCA9IHBhdGg7XG4gICAgdGhpcy5zID0gc2l0ZTtcbiAgICB0aGlzLmMgPSBjb3VudGVyO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNvbXBhcmUgdHdvIHRyaXBsZXMgcHJpb3JpdGl6aW5nIHRoZSBwYXRoLCB0aGVuIHNpdGUsIHRoZW4gY291bnRlclxuICogXFxwYXJhbSBvIHRoZSBvdGhlciB0cmlwbGUgdG8gY29tcGFyZVxuICogXFxyZXR1cm4gLTEgaWYgdGhpcyBpcyBsb3dlciB0aGFuIG8sIDEgaWYgdGhpcyBpcyBncmVhdGVyIHRoYW4gbywgMCBvdGhlcndpc2VcbiAqL1xuVHJpcGxlLnByb3RvdHlwZS5jb21wYXJlID0gZnVuY3Rpb24obyl7XG4gICAgaWYgKHRoaXMucCA8IG8ucCkgeyByZXR1cm4gLTE7fTtcbiAgICBpZiAodGhpcy5wID4gby5wKSB7IHJldHVybiAxIDt9O1xuICAgIGlmICh0aGlzLnMgPCBvLnMpIHsgcmV0dXJuIC0xO307XG4gICAgaWYgKHRoaXMucyA+IG8ucykgeyByZXR1cm4gMSA7fTtcbiAgICBpZiAodGhpcy5jIDwgby5jKSB7IHJldHVybiAtMTt9O1xuICAgIGlmICh0aGlzLmMgPiBvLmMpIHsgcmV0dXJuIDEgO307XG4gICAgcmV0dXJuIDA7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IFRyaXBsZTsiLCJcbmZ1bmN0aW9uIGJpbmFyeUluZGV4T2YoKXtcblxuLyoqXG4gKiBcXGZyb206IFtodHRwczovL2dpc3QuZ2l0aHViLmNvbS9Xb2xmeTg3LzU3MzQ1MzBdXG4gKiBQZXJmb3JtcyBhIGJpbmFyeSBzZWFyY2ggb24gdGhlIGhvc3QgYXJyYXkuIFRoaXMgbWV0aG9kIGNhbiBlaXRoZXIgYmVcbiAqIGluamVjdGVkIGludG8gQXJyYXkucHJvdG90eXBlIG9yIGNhbGxlZCB3aXRoIGEgc3BlY2lmaWVkIHNjb3BlIGxpa2UgdGhpczpcbiAqIGJpbmFyeUluZGV4T2YuY2FsbChzb21lQXJyYXksIHNlYXJjaEVsZW1lbnQpO1xuICpcbiAqXG4gKiBAcGFyYW0geyp9IHNlYXJjaEVsZW1lbnQgVGhlIGl0ZW0gdG8gc2VhcmNoIGZvciB3aXRoaW4gdGhlIGFycmF5LlxuICogQHJldHVybiB7TnVtYmVyfSBUaGUgaW5kZXggb2YgdGhlIGVsZW1lbnQgd2hpY2ggZGVmYXVsdHMgdG8gLTEgd2hlbiBub3RcbiAqIGZvdW5kLlxuICovXG5BcnJheS5wcm90b3R5cGUuYmluYXJ5SW5kZXhPZiA9IGZ1bmN0aW9uKHNlYXJjaEVsZW1lbnQpIHtcbiAgICB2YXIgbWluSW5kZXggPSAwO1xuICAgIHZhciBtYXhJbmRleCA9IHRoaXMubGVuZ3RoIC0gMTtcbiAgICB2YXIgY3VycmVudEluZGV4O1xuICAgIHZhciBjdXJyZW50RWxlbWVudDtcblxuICAgIHdoaWxlIChtaW5JbmRleCA8PSBtYXhJbmRleCkge1xuICAgICAgICBjdXJyZW50SW5kZXggPSBNYXRoLmZsb29yKChtaW5JbmRleCArIG1heEluZGV4KSAvIDIpO1xuICAgICAgICBjdXJyZW50RWxlbWVudCA9IHRoaXNbY3VycmVudEluZGV4XTtcbiAgICAgICAgaWYgKGN1cnJlbnRFbGVtZW50LmNvbXBhcmUoc2VhcmNoRWxlbWVudCkgPCAwKSB7XG4gICAgICAgICAgICBtaW5JbmRleCA9IGN1cnJlbnRJbmRleCArIDE7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSBpZiAoY3VycmVudEVsZW1lbnQuY29tcGFyZShzZWFyY2hFbGVtZW50KSA+IDApIHtcbiAgICAgICAgICAgIG1heEluZGV4ID0gY3VycmVudEluZGV4IC0gMTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiBjdXJyZW50SW5kZXg7XG4gICAgICAgIH1cbiAgICB9O1xuICAgIHJldHVybiB+bWF4SW5kZXg7XG59O1xuXG59XG5cbm1vZHVsZS5leHBvcnRzID0gYmluYXJ5SW5kZXhPZigpOyIsIi8vIFZqZXV4OiBDdXN0b21pemVkIGJpZ0ludDJzdHIgYW5kIHN0cjJiaWdJbnQgaW4gb3JkZXIgdG8gYWNjZXB0IGN1c3RvbSBiYXNlLlxuXG4vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4vLyBCaWcgSW50ZWdlciBMaWJyYXJ5IHYuIDUuNFxuLy8gQ3JlYXRlZCAyMDAwLCBsYXN0IG1vZGlmaWVkIDIwMDlcbi8vIExlZW1vbiBCYWlyZFxuLy8gd3d3LmxlZW1vbi5jb21cbi8vXG4vLyBWZXJzaW9uIGhpc3Rvcnk6XG4vLyB2IDUuNCAgMyBPY3QgMjAwOVxuLy8gICAtIGFkZGVkIFwidmFyIGlcIiB0byBncmVhdGVyU2hpZnQoKSBzbyBpIGlzIG5vdCBnbG9iYWwuIChUaGFua3MgdG8gUO+/vXRlciBTemFi77+9IGZvciBmaW5kaW5nIHRoYXQgYnVnKVxuLy9cbi8vIHYgNS4zICAyMSBTZXAgMjAwOVxuLy8gICAtIGFkZGVkIHJhbmRQcm9iUHJpbWUoaykgZm9yIHByb2JhYmxlIHByaW1lc1xuLy8gICAtIHVucm9sbGVkIGxvb3AgaW4gbW9udF8gKHNsaWdodGx5IGZhc3Rlcilcbi8vICAgLSBtaWxsZXJSYWJpbiBub3cgdGFrZXMgYSBiaWdJbnQgcGFyYW1ldGVyIHJhdGhlciB0aGFuIGFuIGludFxuLy9cbi8vIHYgNS4yICAxNSBTZXAgMjAwOVxuLy8gICAtIGZpeGVkIGNhcGl0YWxpemF0aW9uIGluIGNhbGwgdG8gaW50MmJpZ0ludCBpbiByYW5kQmlnSW50XG4vLyAgICAgKHRoYW5rcyB0byBFbWlsaSBFdnJpcGlkb3UsIFJlaW5ob2xkIEJlaHJpbmdlciwgYW5kIFNhbXVlbCBNYWNhbGVlc2UgZm9yIGZpbmRpbmcgdGhhdCBidWcpXG4vL1xuLy8gdiA1LjEgIDggT2N0IDIwMDdcbi8vICAgLSByZW5hbWVkIGludmVyc2VNb2RJbnRfIHRvIGludmVyc2VNb2RJbnQgc2luY2UgaXQgZG9lc24ndCBjaGFuZ2UgaXRzIHBhcmFtZXRlcnNcbi8vICAgLSBhZGRlZCBmdW5jdGlvbnMgR0NEIGFuZCByYW5kQmlnSW50LCB3aGljaCBjYWxsIEdDRF8gYW5kIHJhbmRCaWdJbnRfXG4vLyAgIC0gZml4ZWQgYSBidWcgZm91bmQgYnkgUm9iIFZpc3NlciAoc2VlIGNvbW1lbnQgd2l0aCBoaXMgbmFtZSBiZWxvdylcbi8vICAgLSBpbXByb3ZlZCBjb21tZW50c1xuLy9cbi8vIFRoaXMgZmlsZSBpcyBwdWJsaWMgZG9tYWluLiAgIFlvdSBjYW4gdXNlIGl0IGZvciBhbnkgcHVycG9zZSB3aXRob3V0IHJlc3RyaWN0aW9uLlxuLy8gSSBkbyBub3QgZ3VhcmFudGVlIHRoYXQgaXQgaXMgY29ycmVjdCwgc28gdXNlIGl0IGF0IHlvdXIgb3duIHJpc2suICBJZiB5b3UgdXNlXG4vLyBpdCBmb3Igc29tZXRoaW5nIGludGVyZXN0aW5nLCBJJ2QgYXBwcmVjaWF0ZSBoZWFyaW5nIGFib3V0IGl0LiAgSWYgeW91IGZpbmRcbi8vIGFueSBidWdzIG9yIG1ha2UgYW55IGltcHJvdmVtZW50cywgSSdkIGFwcHJlY2lhdGUgaGVhcmluZyBhYm91dCB0aG9zZSB0b28uXG4vLyBJdCB3b3VsZCBhbHNvIGJlIG5pY2UgaWYgbXkgbmFtZSBhbmQgVVJMIHdlcmUgbGVmdCBpbiB0aGUgY29tbWVudHMuICBCdXQgbm9uZVxuLy8gb2YgdGhhdCBpcyByZXF1aXJlZC5cbi8vXG4vLyBUaGlzIGNvZGUgZGVmaW5lcyBhIGJpZ0ludCBsaWJyYXJ5IGZvciBhcmJpdHJhcnktcHJlY2lzaW9uIGludGVnZXJzLlxuLy8gQSBiaWdJbnQgaXMgYW4gYXJyYXkgb2YgaW50ZWdlcnMgc3RvcmluZyB0aGUgdmFsdWUgaW4gY2h1bmtzIG9mIGJwZSBiaXRzLFxuLy8gbGl0dGxlIGVuZGlhbiAoYnVmZlswXSBpcyB0aGUgbGVhc3Qgc2lnbmlmaWNhbnQgd29yZCkuXG4vLyBOZWdhdGl2ZSBiaWdJbnRzIGFyZSBzdG9yZWQgdHdvJ3MgY29tcGxlbWVudC4gIEFsbW9zdCBhbGwgdGhlIGZ1bmN0aW9ucyB0cmVhdFxuLy8gYmlnSW50cyBhcyBub25uZWdhdGl2ZS4gIFRoZSBmZXcgdGhhdCB2aWV3IHRoZW0gYXMgdHdvJ3MgY29tcGxlbWVudCBzYXkgc29cbi8vIGluIHRoZWlyIGNvbW1lbnRzLiAgU29tZSBmdW5jdGlvbnMgYXNzdW1lIHRoZWlyIHBhcmFtZXRlcnMgaGF2ZSBhdCBsZWFzdCBvbmVcbi8vIGxlYWRpbmcgemVybyBlbGVtZW50LiBGdW5jdGlvbnMgd2l0aCBhbiB1bmRlcnNjb3JlIGF0IHRoZSBlbmQgb2YgdGhlIG5hbWUgcHV0XG4vLyB0aGVpciBhbnN3ZXIgaW50byBvbmUgb2YgdGhlIGFycmF5cyBwYXNzZWQgaW4sIGFuZCBoYXZlIHVucHJlZGljdGFibGUgYmVoYXZpb3Jcbi8vIGluIGNhc2Ugb2Ygb3ZlcmZsb3csIHNvIHRoZSBjYWxsZXIgbXVzdCBtYWtlIHN1cmUgdGhlIGFycmF5cyBhcmUgYmlnIGVub3VnaCB0b1xuLy8gaG9sZCB0aGUgYW5zd2VyLiAgQnV0IHRoZSBhdmVyYWdlIHVzZXIgc2hvdWxkIG5ldmVyIGhhdmUgdG8gY2FsbCBhbnkgb2YgdGhlXG4vLyB1bmRlcnNjb3JlZCBmdW5jdGlvbnMuICBFYWNoIGltcG9ydGFudCB1bmRlcnNjb3JlZCBmdW5jdGlvbiBoYXMgYSB3cmFwcGVyIGZ1bmN0aW9uXG4vLyBvZiB0aGUgc2FtZSBuYW1lIHdpdGhvdXQgdGhlIHVuZGVyc2NvcmUgdGhhdCB0YWtlcyBjYXJlIG9mIHRoZSBkZXRhaWxzIGZvciB5b3UuXG4vLyBGb3IgZWFjaCB1bmRlcnNjb3JlZCBmdW5jdGlvbiB3aGVyZSBhIHBhcmFtZXRlciBpcyBtb2RpZmllZCwgdGhhdCBzYW1lIHZhcmlhYmxlXG4vLyBtdXN0IG5vdCBiZSB1c2VkIGFzIGFub3RoZXIgYXJndW1lbnQgdG9vLiAgU28sIHlvdSBjYW5ub3Qgc3F1YXJlIHggYnkgZG9pbmdcbi8vIG11bHRNb2RfKHgseCxuKS4gIFlvdSBtdXN0IHVzZSBzcXVhcmVNb2RfKHgsbikgaW5zdGVhZCwgb3IgZG8geT1kdXAoeCk7IG11bHRNb2RfKHgseSxuKS5cbi8vIE9yIHNpbXBseSB1c2UgdGhlIG11bHRNb2QoeCx4LG4pIGZ1bmN0aW9uIHdpdGhvdXQgdGhlIHVuZGVyc2NvcmUsIHdoZXJlXG4vLyBzdWNoIGlzc3VlcyBuZXZlciBhcmlzZSwgYmVjYXVzZSBub24tdW5kZXJzY29yZWQgZnVuY3Rpb25zIG5ldmVyIGNoYW5nZVxuLy8gdGhlaXIgcGFyYW1ldGVyczsgdGhleSBhbHdheXMgYWxsb2NhdGUgbmV3IG1lbW9yeSBmb3IgdGhlIGFuc3dlciB0aGF0IGlzIHJldHVybmVkLlxuLy9cbi8vIFRoZXNlIGZ1bmN0aW9ucyBhcmUgZGVzaWduZWQgdG8gYXZvaWQgZnJlcXVlbnQgZHluYW1pYyBtZW1vcnkgYWxsb2NhdGlvbiBpbiB0aGUgaW5uZXIgbG9vcC5cbi8vIEZvciBtb3N0IGZ1bmN0aW9ucywgaWYgaXQgbmVlZHMgYSBCaWdJbnQgYXMgYSBsb2NhbCB2YXJpYWJsZSBpdCB3aWxsIGFjdHVhbGx5IHVzZVxuLy8gYSBnbG9iYWwsIGFuZCB3aWxsIG9ubHkgYWxsb2NhdGUgdG8gaXQgb25seSB3aGVuIGl0J3Mgbm90IHRoZSByaWdodCBzaXplLiAgVGhpcyBlbnN1cmVzXG4vLyB0aGF0IHdoZW4gYSBmdW5jdGlvbiBpcyBjYWxsZWQgcmVwZWF0ZWRseSB3aXRoIHNhbWUtc2l6ZWQgcGFyYW1ldGVycywgaXQgb25seSBhbGxvY2F0ZXNcbi8vIG1lbW9yeSBvbiB0aGUgZmlyc3QgY2FsbC5cbi8vXG4vLyBOb3RlIHRoYXQgZm9yIGNyeXB0b2dyYXBoaWMgcHVycG9zZXMsIHRoZSBjYWxscyB0byBNYXRoLnJhbmRvbSgpIG11c3Rcbi8vIGJlIHJlcGxhY2VkIHdpdGggY2FsbHMgdG8gYSBiZXR0ZXIgcHNldWRvcmFuZG9tIG51bWJlciBnZW5lcmF0b3IuXG4vL1xuLy8gSW4gdGhlIGZvbGxvd2luZywgXCJiaWdJbnRcIiBtZWFucyBhIGJpZ0ludCB3aXRoIGF0IGxlYXN0IG9uZSBsZWFkaW5nIHplcm8gZWxlbWVudCxcbi8vIGFuZCBcImludGVnZXJcIiBtZWFucyBhIG5vbm5lZ2F0aXZlIGludGVnZXIgbGVzcyB0aGFuIHJhZGl4LiAgSW4gc29tZSBjYXNlcywgaW50ZWdlclxuLy8gY2FuIGJlIG5lZ2F0aXZlLiAgTmVnYXRpdmUgYmlnSW50cyBhcmUgMnMgY29tcGxlbWVudC5cbi8vXG4vLyBUaGUgZm9sbG93aW5nIGZ1bmN0aW9ucyBkbyBub3QgbW9kaWZ5IHRoZWlyIGlucHV0cy5cbi8vIFRob3NlIHJldHVybmluZyBhIGJpZ0ludCwgc3RyaW5nLCBvciBBcnJheSB3aWxsIGR5bmFtaWNhbGx5IGFsbG9jYXRlIG1lbW9yeSBmb3IgdGhhdCB2YWx1ZS5cbi8vIFRob3NlIHJldHVybmluZyBhIGJvb2xlYW4gd2lsbCByZXR1cm4gdGhlIGludGVnZXIgMCAoZmFsc2UpIG9yIDEgKHRydWUpLlxuLy8gVGhvc2UgcmV0dXJuaW5nIGJvb2xlYW4gb3IgaW50IHdpbGwgbm90IGFsbG9jYXRlIG1lbW9yeSBleGNlcHQgcG9zc2libHkgb24gdGhlIGZpcnN0XG4vLyB0aW1lIHRoZXkncmUgY2FsbGVkIHdpdGggYSBnaXZlbiBwYXJhbWV0ZXIgc2l6ZS5cbi8vXG4vLyBiaWdJbnQgIGFkZCh4LHkpICAgICAgICAgICAgICAgLy9yZXR1cm4gKHgreSkgZm9yIGJpZ0ludHMgeCBhbmQgeS5cbi8vIGJpZ0ludCAgYWRkSW50KHgsbikgICAgICAgICAgICAvL3JldHVybiAoeCtuKSB3aGVyZSB4IGlzIGEgYmlnSW50IGFuZCBuIGlzIGFuIGludGVnZXIuXG4vLyBzdHJpbmcgIGJpZ0ludDJzdHIoeCxiYXNlKSAgICAgLy9yZXR1cm4gYSBzdHJpbmcgZm9ybSBvZiBiaWdJbnQgeCBpbiBhIGdpdmVuIGJhc2UsIHdpdGggMiA8PSBiYXNlIDw9IDk1XG4vLyBpbnQgICAgIGJpdFNpemUoeCkgICAgICAgICAgICAgLy9yZXR1cm4gaG93IG1hbnkgYml0cyBsb25nIHRoZSBiaWdJbnQgeCBpcywgbm90IGNvdW50aW5nIGxlYWRpbmcgemVyb3Ncbi8vIGJpZ0ludCAgZHVwKHgpICAgICAgICAgICAgICAgICAvL3JldHVybiBhIGNvcHkgb2YgYmlnSW50IHhcbi8vIGJvb2xlYW4gZXF1YWxzKHgseSkgICAgICAgICAgICAvL2lzIHRoZSBiaWdJbnQgeCBlcXVhbCB0byB0aGUgYmlnaW50IHk/XG4vLyBib29sZWFuIGVxdWFsc0ludCh4LHkpICAgICAgICAgLy9pcyBiaWdpbnQgeCBlcXVhbCB0byBpbnRlZ2VyIHk/XG4vLyBiaWdJbnQgIGV4cGFuZCh4LG4pICAgICAgICAgICAgLy9yZXR1cm4gYSBjb3B5IG9mIHggd2l0aCBhdCBsZWFzdCBuIGVsZW1lbnRzLCBhZGRpbmcgbGVhZGluZyB6ZXJvcyBpZiBuZWVkZWRcbi8vIEFycmF5ICAgZmluZFByaW1lcyhuKSAgICAgICAgICAvL3JldHVybiBhcnJheSBvZiBhbGwgcHJpbWVzIGxlc3MgdGhhbiBpbnRlZ2VyIG5cbi8vIGJpZ0ludCAgR0NEKHgseSkgICAgICAgICAgICAgICAvL3JldHVybiBncmVhdGVzdCBjb21tb24gZGl2aXNvciBvZiBiaWdJbnRzIHggYW5kIHkgKGVhY2ggd2l0aCBzYW1lIG51bWJlciBvZiBlbGVtZW50cykuXG4vLyBib29sZWFuIGdyZWF0ZXIoeCx5KSAgICAgICAgICAgLy9pcyB4Pnk/ICAoeCBhbmQgeSBhcmUgbm9ubmVnYXRpdmUgYmlnSW50cylcbi8vIGJvb2xlYW4gZ3JlYXRlclNoaWZ0KHgseSxzaGlmdCkvL2lzICh4IDw8KHNoaWZ0KmJwZSkpID4geT9cbi8vIGJpZ0ludCAgaW50MmJpZ0ludCh0LG4sbSkgICAgICAvL3JldHVybiBhIGJpZ0ludCBlcXVhbCB0byBpbnRlZ2VyIHQsIHdpdGggYXQgbGVhc3QgbiBiaXRzIGFuZCBtIGFycmF5IGVsZW1lbnRzXG4vLyBiaWdJbnQgIGludmVyc2VNb2QoeCxuKSAgICAgICAgLy9yZXR1cm4gKHgqKigtMSkgbW9kIG4pIGZvciBiaWdJbnRzIHggYW5kIG4uICBJZiBubyBpbnZlcnNlIGV4aXN0cywgaXQgcmV0dXJucyBudWxsXG4vLyBpbnQgICAgIGludmVyc2VNb2RJbnQoeCxuKSAgICAgLy9yZXR1cm4geCoqKC0xKSBtb2QgbiwgZm9yIGludGVnZXJzIHggYW5kIG4uICBSZXR1cm4gMCBpZiB0aGVyZSBpcyBubyBpbnZlcnNlXG4vLyBib29sZWFuIGlzWmVybyh4KSAgICAgICAgICAgICAgLy9pcyB0aGUgYmlnSW50IHggZXF1YWwgdG8gemVybz9cbi8vIGJvb2xlYW4gbWlsbGVyUmFiaW4oeCxiKSAgICAgICAvL2RvZXMgb25lIHJvdW5kIG9mIE1pbGxlci1SYWJpbiBiYXNlIGludGVnZXIgYiBzYXkgdGhhdCBiaWdJbnQgeCBpcyBwb3NzaWJseSBwcmltZT8gKGIgaXMgYmlnSW50LCAxPGI8eClcbi8vIGJvb2xlYW4gbWlsbGVyUmFiaW5JbnQoeCxiKSAgICAvL2RvZXMgb25lIHJvdW5kIG9mIE1pbGxlci1SYWJpbiBiYXNlIGludGVnZXIgYiBzYXkgdGhhdCBiaWdJbnQgeCBpcyBwb3NzaWJseSBwcmltZT8gKGIgaXMgaW50LCAgICAxPGI8eClcbi8vIGJpZ0ludCAgbW9kKHgsbikgICAgICAgICAgICAgICAvL3JldHVybiBhIG5ldyBiaWdJbnQgZXF1YWwgdG8gKHggbW9kIG4pIGZvciBiaWdJbnRzIHggYW5kIG4uXG4vLyBpbnQgICAgIG1vZEludCh4LG4pICAgICAgICAgICAgLy9yZXR1cm4geCBtb2QgbiBmb3IgYmlnSW50IHggYW5kIGludGVnZXIgbi5cbi8vIGJpZ0ludCAgbXVsdCh4LHkpICAgICAgICAgICAgICAvL3JldHVybiB4KnkgZm9yIGJpZ0ludHMgeCBhbmQgeS4gVGhpcyBpcyBmYXN0ZXIgd2hlbiB5PHguXG4vLyBiaWdJbnQgIG11bHRNb2QoeCx5LG4pICAgICAgICAgLy9yZXR1cm4gKHgqeSBtb2QgbikgZm9yIGJpZ0ludHMgeCx5LG4uICBGb3IgZ3JlYXRlciBzcGVlZCwgbGV0IHk8eC5cbi8vIGJvb2xlYW4gbmVnYXRpdmUoeCkgICAgICAgICAgICAvL2lzIGJpZ0ludCB4IG5lZ2F0aXZlP1xuLy8gYmlnSW50ICBwb3dNb2QoeCx5LG4pICAgICAgICAgIC8vcmV0dXJuICh4Kip5IG1vZCBuKSB3aGVyZSB4LHksbiBhcmUgYmlnSW50cyBhbmQgKiogaXMgZXhwb25lbnRpYXRpb24uICAwKiowPTEuIEZhc3RlciBmb3Igb2RkIG4uXG4vLyBiaWdJbnQgIHJhbmRCaWdJbnQobixzKSAgICAgICAgLy9yZXR1cm4gYW4gbi1iaXQgcmFuZG9tIEJpZ0ludCAobj49MSkuICBJZiBzPTEsIHRoZW4gdGhlIG1vc3Qgc2lnbmlmaWNhbnQgb2YgdGhvc2UgbiBiaXRzIGlzIHNldCB0byAxLlxuLy8gYmlnSW50ICByYW5kVHJ1ZVByaW1lKGspICAgICAgIC8vcmV0dXJuIGEgbmV3LCByYW5kb20sIGstYml0LCB0cnVlIHByaW1lIGJpZ0ludCB1c2luZyBNYXVyZXIncyBhbGdvcml0aG0uXG4vLyBiaWdJbnQgIHJhbmRQcm9iUHJpbWUoaykgICAgICAgLy9yZXR1cm4gYSBuZXcsIHJhbmRvbSwgay1iaXQsIHByb2JhYmxlIHByaW1lIGJpZ0ludCAocHJvYmFiaWxpdHkgaXQncyBjb21wb3NpdGUgbGVzcyB0aGFuIDJeLTgwKS5cbi8vIGJpZ0ludCAgc3RyMmJpZ0ludChzLGIsbixtKSAgICAvL3JldHVybiBhIGJpZ0ludCBmb3IgbnVtYmVyIHJlcHJlc2VudGVkIGluIHN0cmluZyBzIGluIGJhc2UgYiB3aXRoIGF0IGxlYXN0IG4gYml0cyBhbmQgbSBhcnJheSBlbGVtZW50c1xuLy8gYmlnSW50ICBzdWIoeCx5KSAgICAgICAgICAgICAgIC8vcmV0dXJuICh4LXkpIGZvciBiaWdJbnRzIHggYW5kIHkuICBOZWdhdGl2ZSBhbnN3ZXJzIHdpbGwgYmUgMnMgY29tcGxlbWVudFxuLy8gYmlnSW50ICB0cmltKHgsaykgICAgICAgICAgICAgIC8vcmV0dXJuIGEgY29weSBvZiB4IHdpdGggZXhhY3RseSBrIGxlYWRpbmcgemVybyBlbGVtZW50c1xuLy9cbi8vXG4vLyBUaGUgZm9sbG93aW5nIGZ1bmN0aW9ucyBlYWNoIGhhdmUgYSBub24tdW5kZXJzY29yZWQgdmVyc2lvbiwgd2hpY2ggbW9zdCB1c2VycyBzaG91bGQgY2FsbCBpbnN0ZWFkLlxuLy8gVGhlc2UgZnVuY3Rpb25zIGVhY2ggd3JpdGUgdG8gYSBzaW5nbGUgcGFyYW1ldGVyLCBhbmQgdGhlIGNhbGxlciBpcyByZXNwb25zaWJsZSBmb3IgZW5zdXJpbmcgdGhlIGFycmF5XG4vLyBwYXNzZWQgaW4gaXMgbGFyZ2UgZW5vdWdoIHRvIGhvbGQgdGhlIHJlc3VsdC5cbi8vXG4vLyB2b2lkICAgIGFkZEludF8oeCxuKSAgICAgICAgICAvL2RvIHg9eCtuIHdoZXJlIHggaXMgYSBiaWdJbnQgYW5kIG4gaXMgYW4gaW50ZWdlclxuLy8gdm9pZCAgICBhZGRfKHgseSkgICAgICAgICAgICAgLy9kbyB4PXgreSBmb3IgYmlnSW50cyB4IGFuZCB5XG4vLyB2b2lkICAgIGNvcHlfKHgseSkgICAgICAgICAgICAvL2RvIHg9eSBvbiBiaWdJbnRzIHggYW5kIHlcbi8vIHZvaWQgICAgY29weUludF8oeCxuKSAgICAgICAgIC8vZG8geD1uIG9uIGJpZ0ludCB4IGFuZCBpbnRlZ2VyIG5cbi8vIHZvaWQgICAgR0NEXyh4LHkpICAgICAgICAgICAgIC8vc2V0IHggdG8gdGhlIGdyZWF0ZXN0IGNvbW1vbiBkaXZpc29yIG9mIGJpZ0ludHMgeCBhbmQgeSwgKHkgaXMgZGVzdHJveWVkKS4gIChUaGlzIG5ldmVyIG92ZXJmbG93cyBpdHMgYXJyYXkpLlxuLy8gYm9vbGVhbiBpbnZlcnNlTW9kXyh4LG4pICAgICAgLy9kbyB4PXgqKigtMSkgbW9kIG4sIGZvciBiaWdJbnRzIHggYW5kIG4uIFJldHVybnMgMSAoMCkgaWYgaW52ZXJzZSBkb2VzIChkb2Vzbid0KSBleGlzdFxuLy8gdm9pZCAgICBtb2RfKHgsbikgICAgICAgICAgICAgLy9kbyB4PXggbW9kIG4gZm9yIGJpZ0ludHMgeCBhbmQgbi4gKFRoaXMgbmV2ZXIgb3ZlcmZsb3dzIGl0cyBhcnJheSkuXG4vLyB2b2lkICAgIG11bHRfKHgseSkgICAgICAgICAgICAvL2RvIHg9eCp5IGZvciBiaWdJbnRzIHggYW5kIHkuXG4vLyB2b2lkICAgIG11bHRNb2RfKHgseSxuKSAgICAgICAvL2RvIHg9eCp5ICBtb2QgbiBmb3IgYmlnSW50cyB4LHksbi5cbi8vIHZvaWQgICAgcG93TW9kXyh4LHksbikgICAgICAgIC8vZG8geD14Kip5IG1vZCBuLCB3aGVyZSB4LHksbiBhcmUgYmlnSW50cyAobiBpcyBvZGQpIGFuZCAqKiBpcyBleHBvbmVudGlhdGlvbi4gIDAqKjA9MS5cbi8vIHZvaWQgICAgcmFuZEJpZ0ludF8oYixuLHMpICAgIC8vZG8gYiA9IGFuIG4tYml0IHJhbmRvbSBCaWdJbnQuIGlmIHM9MSwgdGhlbiBudGggYml0IChtb3N0IHNpZ25pZmljYW50IGJpdCkgaXMgc2V0IHRvIDEuIG4+PTEuXG4vLyB2b2lkICAgIHJhbmRUcnVlUHJpbWVfKGFucyxrKSAvL2RvIGFucyA9IGEgcmFuZG9tIGstYml0IHRydWUgcmFuZG9tIHByaW1lIChub3QganVzdCBwcm9iYWJsZSBwcmltZSkgd2l0aCAxIGluIHRoZSBtc2IuXG4vLyB2b2lkICAgIHN1Yl8oeCx5KSAgICAgICAgICAgICAvL2RvIHg9eC15IGZvciBiaWdJbnRzIHggYW5kIHkuIE5lZ2F0aXZlIGFuc3dlcnMgd2lsbCBiZSAycyBjb21wbGVtZW50LlxuLy9cbi8vIFRoZSBmb2xsb3dpbmcgZnVuY3Rpb25zIGRvIE5PVCBoYXZlIGEgbm9uLXVuZGVyc2NvcmVkIHZlcnNpb24uXG4vLyBUaGV5IGVhY2ggd3JpdGUgYSBiaWdJbnQgcmVzdWx0IHRvIG9uZSBvciBtb3JlIHBhcmFtZXRlcnMuICBUaGUgY2FsbGVyIGlzIHJlc3BvbnNpYmxlIGZvclxuLy8gZW5zdXJpbmcgdGhlIGFycmF5cyBwYXNzZWQgaW4gYXJlIGxhcmdlIGVub3VnaCB0byBob2xkIHRoZSByZXN1bHRzLlxuLy9cbi8vIHZvaWQgYWRkU2hpZnRfKHgseSx5cykgICAgICAgLy9kbyB4PXgrKHk8PCh5cypicGUpKVxuLy8gdm9pZCBjYXJyeV8oeCkgICAgICAgICAgICAgICAvL2RvIGNhcnJpZXMgYW5kIGJvcnJvd3Mgc28gZWFjaCBlbGVtZW50IG9mIHRoZSBiaWdJbnQgeCBmaXRzIGluIGJwZSBiaXRzLlxuLy8gdm9pZCBkaXZpZGVfKHgseSxxLHIpICAgICAgICAvL2RpdmlkZSB4IGJ5IHkgZ2l2aW5nIHF1b3RpZW50IHEgYW5kIHJlbWFpbmRlciByXG4vLyBpbnQgIGRpdkludF8oeCxuKSAgICAgICAgICAgIC8vZG8geD1mbG9vcih4L24pIGZvciBiaWdJbnQgeCBhbmQgaW50ZWdlciBuLCBhbmQgcmV0dXJuIHRoZSByZW1haW5kZXIuIChUaGlzIG5ldmVyIG92ZXJmbG93cyBpdHMgYXJyYXkpLlxuLy8gaW50ICBlR0NEXyh4LHksZCxhLGIpICAgICAgICAvL3NldHMgYSxiLGQgdG8gcG9zaXRpdmUgYmlnSW50cyBzdWNoIHRoYXQgZCA9IEdDRF8oeCx5KSA9IGEqeC1iKnlcbi8vIHZvaWQgaGFsdmVfKHgpICAgICAgICAgICAgICAgLy9kbyB4PWZsb29yKHx4fC8yKSpzZ24oeCkgZm9yIGJpZ0ludCB4IGluIDIncyBjb21wbGVtZW50LiAgKFRoaXMgbmV2ZXIgb3ZlcmZsb3dzIGl0cyBhcnJheSkuXG4vLyB2b2lkIGxlZnRTaGlmdF8oeCxuKSAgICAgICAgIC8vbGVmdCBzaGlmdCBiaWdJbnQgeCBieSBuIGJpdHMuICBuPGJwZS5cbi8vIHZvaWQgbGluQ29tYl8oeCx5LGEsYikgICAgICAgLy9kbyB4PWEqeCtiKnkgZm9yIGJpZ0ludHMgeCBhbmQgeSBhbmQgaW50ZWdlcnMgYSBhbmQgYlxuLy8gdm9pZCBsaW5Db21iU2hpZnRfKHgseSxiLHlzKSAvL2RvIHg9eCtiKih5PDwoeXMqYnBlKSkgZm9yIGJpZ0ludHMgeCBhbmQgeSwgYW5kIGludGVnZXJzIGIgYW5kIHlzXG4vLyB2b2lkIG1vbnRfKHgseSxuLG5wKSAgICAgICAgIC8vTW9udGdvbWVyeSBtdWx0aXBsaWNhdGlvbiAoc2VlIGNvbW1lbnRzIHdoZXJlIHRoZSBmdW5jdGlvbiBpcyBkZWZpbmVkKVxuLy8gdm9pZCBtdWx0SW50Xyh4LG4pICAgICAgICAgICAvL2RvIHg9eCpuIHdoZXJlIHggaXMgYSBiaWdJbnQgYW5kIG4gaXMgYW4gaW50ZWdlci5cbi8vIHZvaWQgcmlnaHRTaGlmdF8oeCxuKSAgICAgICAgLy9yaWdodCBzaGlmdCBiaWdJbnQgeCBieSBuIGJpdHMuICAwIDw9IG4gPCBicGUuIChUaGlzIG5ldmVyIG92ZXJmbG93cyBpdHMgYXJyYXkpLlxuLy8gdm9pZCBzcXVhcmVNb2RfKHgsbikgICAgICAgICAvL2RvIHg9eCp4ICBtb2QgbiBmb3IgYmlnSW50cyB4LG5cbi8vIHZvaWQgc3ViU2hpZnRfKHgseSx5cykgICAgICAgLy9kbyB4PXgtKHk8PCh5cypicGUpKS4gTmVnYXRpdmUgYW5zd2VycyB3aWxsIGJlIDJzIGNvbXBsZW1lbnQuXG4vL1xuLy8gVGhlIGZvbGxvd2luZyBmdW5jdGlvbnMgYXJlIGJhc2VkIG9uIGFsZ29yaXRobXMgZnJvbSB0aGUgX0hhbmRib29rIG9mIEFwcGxpZWQgQ3J5cHRvZ3JhcGh5X1xuLy8gICAgcG93TW9kXygpICAgICAgICAgICA9IGFsZ29yaXRobSAxNC45NCwgTW9udGdvbWVyeSBleHBvbmVudGlhdGlvblxuLy8gICAgZUdDRF8saW52ZXJzZU1vZF8oKSA9IGFsZ29yaXRobSAxNC42MSwgQmluYXJ5IGV4dGVuZGVkIEdDRF9cbi8vICAgIEdDRF8oKSAgICAgICAgICAgICAgPSBhbGdvcm90aG0gMTQuNTcsIExlaG1lcidzIGFsZ29yaXRobVxuLy8gICAgbW9udF8oKSAgICAgICAgICAgICA9IGFsZ29yaXRobSAxNC4zNiwgTW9udGdvbWVyeSBtdWx0aXBsaWNhdGlvblxuLy8gICAgZGl2aWRlXygpICAgICAgICAgICA9IGFsZ29yaXRobSAxNC4yMCAgTXVsdGlwbGUtcHJlY2lzaW9uIGRpdmlzaW9uXG4vLyAgICBzcXVhcmVNb2RfKCkgICAgICAgID0gYWxnb3JpdGhtIDE0LjE2ICBNdWx0aXBsZS1wcmVjaXNpb24gc3F1YXJpbmdcbi8vICAgIHJhbmRUcnVlUHJpbWVfKCkgICAgPSBhbGdvcml0aG0gIDQuNjIsIE1hdXJlcidzIGFsZ29yaXRobVxuLy8gICAgbWlsbGVyUmFiaW4oKSAgICAgICA9IGFsZ29yaXRobSAgNC4yNCwgTWlsbGVyLVJhYmluIGFsZ29yaXRobVxuLy9cbi8vIFByb2ZpbGluZyBzaG93czpcbi8vICAgICByYW5kVHJ1ZVByaW1lXygpIHNwZW5kczpcbi8vICAgICAgICAgMTAlIG9mIGl0cyB0aW1lIGluIGNhbGxzIHRvIHBvd01vZF8oKVxuLy8gICAgICAgICA4NSUgb2YgaXRzIHRpbWUgaW4gY2FsbHMgdG8gbWlsbGVyUmFiaW4oKVxuLy8gICAgIG1pbGxlclJhYmluKCkgc3BlbmRzOlxuLy8gICAgICAgICA5OSUgb2YgaXRzIHRpbWUgaW4gY2FsbHMgdG8gcG93TW9kXygpICAgKGFsd2F5cyB3aXRoIGEgYmFzZSBvZiAyKVxuLy8gICAgIHBvd01vZF8oKSBzcGVuZHM6XG4vLyAgICAgICAgIDk0JSBvZiBpdHMgdGltZSBpbiBjYWxscyB0byBtb250XygpICAoYWxtb3N0IGFsd2F5cyB3aXRoIHg9PXkpXG4vL1xuLy8gVGhpcyBzdWdnZXN0cyB0aGVyZSBhcmUgc2V2ZXJhbCB3YXlzIHRvIHNwZWVkIHVwIHRoaXMgbGlicmFyeSBzbGlnaHRseTpcbi8vICAgICAtIGNvbnZlcnQgcG93TW9kXyB0byB1c2UgYSBNb250Z29tZXJ5IGZvcm0gb2Ygay1hcnkgd2luZG93IChvciBtYXliZSBhIE1vbnRnb21lcnkgZm9ybSBvZiBzbGlkaW5nIHdpbmRvdylcbi8vICAgICAgICAgLS0gdGhpcyBzaG91bGQgZXNwZWNpYWxseSBmb2N1cyBvbiBiZWluZyBmYXN0IHdoZW4gcmFpc2luZyAyIHRvIGEgcG93ZXIgbW9kIG5cbi8vICAgICAtIGNvbnZlcnQgcmFuZFRydWVQcmltZV8oKSB0byB1c2UgYSBtaW5pbXVtIHIgb2YgMS8zIGluc3RlYWQgb2YgMS8yIHdpdGggdGhlIGFwcHJvcHJpYXRlIGNoYW5nZSB0byB0aGUgdGVzdFxuLy8gICAgIC0gdHVuZSB0aGUgcGFyYW1ldGVycyBpbiByYW5kVHJ1ZVByaW1lXygpLCBpbmNsdWRpbmcgYywgbSwgYW5kIHJlY0xpbWl0XG4vLyAgICAgLSBzcGVlZCB1cCB0aGUgc2luZ2xlIGxvb3AgaW4gbW9udF8oKSB0aGF0IHRha2VzIDk1JSBvZiB0aGUgcnVudGltZSwgcGVyaGFwcyBieSByZWR1Y2luZyBjaGVja2luZ1xuLy8gICAgICAgd2l0aGluIHRoZSBsb29wIHdoZW4gYWxsIHRoZSBwYXJhbWV0ZXJzIGFyZSB0aGUgc2FtZSBsZW5ndGguXG4vL1xuLy8gVGhlcmUgYXJlIHNldmVyYWwgaWRlYXMgdGhhdCBsb29rIGxpa2UgdGhleSB3b3VsZG4ndCBoZWxwIG11Y2ggYXQgYWxsOlxuLy8gICAgIC0gcmVwbGFjaW5nIHRyaWFsIGRpdmlzaW9uIGluIHJhbmRUcnVlUHJpbWVfKCkgd2l0aCBhIHNpZXZlICh0aGF0IHNwZWVkcyB1cCBzb21ldGhpbmcgdGFraW5nIGFsbW9zdCBubyB0aW1lIGFueXdheSlcbi8vICAgICAtIGluY3JlYXNlIGJwZSBmcm9tIDE1IHRvIDMwICh0aGF0IHdvdWxkIGhlbHAgaWYgd2UgaGFkIGEgMzIqMzItPjY0IG11bHRpcGxpZXIsIGJ1dCBub3Qgd2l0aCBKYXZhU2NyaXB0J3MgMzIqMzItPjMyKVxuLy8gICAgIC0gc3BlZWRpbmcgdXAgbW9udF8oeCx5LG4sbnApIHdoZW4geD09eSBieSBkb2luZyBhIG5vbi1tb2R1bGFyLCBub24tTW9udGdvbWVyeSBzcXVhcmVcbi8vICAgICAgIGZvbGxvd2VkIGJ5IGEgTW9udGdvbWVyeSByZWR1Y3Rpb24uICBUaGUgaW50ZXJtZWRpYXRlIGFuc3dlciB3aWxsIGJlIHR3aWNlIGFzIGxvbmcgYXMgeCwgc28gdGhhdFxuLy8gICAgICAgbWV0aG9kIHdvdWxkIGJlIHNsb3dlci4gIFRoaXMgaXMgdW5mb3J0dW5hdGUgYmVjYXVzZSB0aGUgY29kZSBjdXJyZW50bHkgc3BlbmRzIGFsbW9zdCBhbGwgb2YgaXRzIHRpbWVcbi8vICAgICAgIGRvaW5nIG1vbnRfKHgseCwuLi4pLCBib3RoIGZvciByYW5kVHJ1ZVByaW1lXygpIGFuZCBwb3dNb2RfKCkuICBBIGZhc3RlciBtZXRob2QgZm9yIE1vbnRnb21lcnkgc3F1YXJpbmdcbi8vICAgICAgIHdvdWxkIGhhdmUgYSBsYXJnZSBpbXBhY3Qgb24gdGhlIHNwZWVkIG9mIHJhbmRUcnVlUHJpbWVfKCkgYW5kIHBvd01vZF8oKS4gIEhBQyBoYXMgYSBjb3VwbGUgb2YgcG9vcmx5LXdvcmRlZFxuLy8gICAgICAgc2VudGVuY2VzIHRoYXQgc2VlbSB0byBpbXBseSBpdCdzIGZhc3RlciB0byBkbyBhIG5vbi1tb2R1bGFyIHNxdWFyZSBmb2xsb3dlZCBieSBhIHNpbmdsZVxuLy8gICAgICAgTW9udGdvbWVyeSByZWR1Y3Rpb24sIGJ1dCB0aGF0J3Mgb2J2aW91c2x5IHdyb25nLlxuLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuXG4oZnVuY3Rpb24gKCkge1xuLy9nbG9iYWxzXG5icGU9MDsgICAgICAgICAvL2JpdHMgc3RvcmVkIHBlciBhcnJheSBlbGVtZW50XG5tYXNrPTA7ICAgICAgICAvL0FORCB0aGlzIHdpdGggYW4gYXJyYXkgZWxlbWVudCB0byBjaG9wIGl0IGRvd24gdG8gYnBlIGJpdHNcbnJhZGl4PW1hc2srMTsgIC8vZXF1YWxzIDJeYnBlLiAgQSBzaW5nbGUgMSBiaXQgdG8gdGhlIGxlZnQgb2YgdGhlIGxhc3QgYml0IG9mIG1hc2suXG5cbi8vdGhlIGRpZ2l0cyBmb3IgY29udmVydGluZyB0byBkaWZmZXJlbnQgYmFzZXNcbmRpZ2l0c1N0cj0nMDEyMzQ1Njc4OUFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpfPSFAIyQlXiYqKClbXXt9fDs6LC48Pi8/YH4gXFxcXFxcJ1xcXCIrLSc7XG5cbi8vaW5pdGlhbGl6ZSB0aGUgZ2xvYmFsIHZhcmlhYmxlc1xuZm9yIChicGU9MDsgKDE8PChicGUrMSkpID4gKDE8PGJwZSk7IGJwZSsrKTsgIC8vYnBlPW51bWJlciBvZiBiaXRzIGluIHRoZSBtYW50aXNzYSBvbiB0aGlzIHBsYXRmb3JtXG5icGU+Pj0xOyAgICAgICAgICAgICAgICAgICAvL2JwZT1udW1iZXIgb2YgYml0cyBpbiBvbmUgZWxlbWVudCBvZiB0aGUgYXJyYXkgcmVwcmVzZW50aW5nIHRoZSBiaWdJbnRcbm1hc2s9KDE8PGJwZSktMTsgICAgICAgICAgIC8vQU5EIHRoZSBtYXNrIHdpdGggYW4gaW50ZWdlciB0byBnZXQgaXRzIGJwZSBsZWFzdCBzaWduaWZpY2FudCBiaXRzXG5yYWRpeD1tYXNrKzE7ICAgICAgICAgICAgICAvLzJeYnBlLiAgYSBzaW5nbGUgMSBiaXQgdG8gdGhlIGxlZnQgb2YgdGhlIGZpcnN0IGJpdCBvZiBtYXNrXG5vbmU9aW50MmJpZ0ludCgxLDEsMSk7ICAgICAvL2NvbnN0YW50IHVzZWQgaW4gcG93TW9kXygpXG5cbi8vdGhlIGZvbGxvd2luZyBnbG9iYWwgdmFyaWFibGVzIGFyZSBzY3JhdGNocGFkIG1lbW9yeSB0b1xuLy9yZWR1Y2UgZHluYW1pYyBtZW1vcnkgYWxsb2NhdGlvbiBpbiB0aGUgaW5uZXIgbG9vcFxudD1uZXcgQXJyYXkoMCk7XG5zcz10OyAgICAgICAvL3VzZWQgaW4gbXVsdF8oKVxuczA9dDsgICAgICAgLy91c2VkIGluIG11bHRNb2RfKCksIHNxdWFyZU1vZF8oKVxuczE9dDsgICAgICAgLy91c2VkIGluIHBvd01vZF8oKSwgbXVsdE1vZF8oKSwgc3F1YXJlTW9kXygpXG5zMj10OyAgICAgICAvL3VzZWQgaW4gcG93TW9kXygpLCBtdWx0TW9kXygpXG5zMz10OyAgICAgICAvL3VzZWQgaW4gcG93TW9kXygpXG5zND10OyBzNT10OyAvL3VzZWQgaW4gbW9kXygpXG5zNj10OyAgICAgICAvL3VzZWQgaW4gYmlnSW50MnN0cigpXG5zNz10OyAgICAgICAvL3VzZWQgaW4gcG93TW9kXygpXG5UPXQ7ICAgICAgICAvL3VzZWQgaW4gR0NEXygpXG5zYT10OyAgICAgICAvL3VzZWQgaW4gbW9udF8oKVxubXJfeDE9dDsgbXJfcj10OyBtcl9hPXQ7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL3VzZWQgaW4gbWlsbGVyUmFiaW4oKVxuZWdfdj10OyBlZ191PXQ7IGVnX0E9dDsgZWdfQj10OyBlZ19DPXQ7IGVnX0Q9dDsgICAgICAgICAgICAgICAvL3VzZWQgaW4gZUdDRF8oKSwgaW52ZXJzZU1vZF8oKVxubWRfcTE9dDsgbWRfcTI9dDsgbWRfcTM9dDsgbWRfcj10OyBtZF9yMT10OyBtZF9yMj10OyBtZF90dD10OyAvL3VzZWQgaW4gbW9kXygpXG5cbnByaW1lcz10OyBwb3dzPXQ7IHNfaT10OyBzX2kyPXQ7IHNfUj10OyBzX3JtPXQ7IHNfcT10OyBzX24xPXQ7XG4gIHNfYT10OyBzX3IyPXQ7IHNfbj10OyBzX2I9dDsgc19kPXQ7IHNfeDE9dDsgc194Mj10LCBzX2FhPXQ7IC8vdXNlZCBpbiByYW5kVHJ1ZVByaW1lXygpXG5cbnJwcHJiPXQ7IC8vdXNlZCBpbiByYW5kUHJvYlByaW1lUm91bmRzKCkgKHdoaWNoIGFsc28gdXNlcyBcInByaW1lc1wiKVxuXG4vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG5cblxuLy9yZXR1cm4gYXJyYXkgb2YgYWxsIHByaW1lcyBsZXNzIHRoYW4gaW50ZWdlciBuXG5mdW5jdGlvbiBmaW5kUHJpbWVzKG4pIHtcbiAgdmFyIGkscyxwLGFucztcbiAgcz1uZXcgQXJyYXkobik7XG4gIGZvciAoaT0wO2k8bjtpKyspXG4gICAgc1tpXT0wO1xuICBzWzBdPTI7XG4gIHA9MDsgICAgLy9maXJzdCBwIGVsZW1lbnRzIG9mIHMgYXJlIHByaW1lcywgdGhlIHJlc3QgYXJlIGEgc2lldmVcbiAgZm9yKDtzW3BdPG47KSB7ICAgICAgICAgICAgICAgICAgLy9zW3BdIGlzIHRoZSBwdGggcHJpbWVcbiAgICBmb3IoaT1zW3BdKnNbcF07IGk8bjsgaSs9c1twXSkgLy9tYXJrIG11bHRpcGxlcyBvZiBzW3BdXG4gICAgICBzW2ldPTE7XG4gICAgcCsrO1xuICAgIHNbcF09c1twLTFdKzE7XG4gICAgZm9yKDsgc1twXTxuICYmIHNbc1twXV07IHNbcF0rKyk7IC8vZmluZCBuZXh0IHByaW1lICh3aGVyZSBzW3BdPT0wKVxuICB9XG4gIGFucz1uZXcgQXJyYXkocCk7XG4gIGZvcihpPTA7aTxwO2krKylcbiAgICBhbnNbaV09c1tpXTtcbiAgcmV0dXJuIGFucztcbn1cblxuXG4vL2RvZXMgYSBzaW5nbGUgcm91bmQgb2YgTWlsbGVyLVJhYmluIGJhc2UgYiBjb25zaWRlciB4IHRvIGJlIGEgcG9zc2libGUgcHJpbWU/XG4vL3ggaXMgYSBiaWdJbnQsIGFuZCBiIGlzIGFuIGludGVnZXIsIHdpdGggYjx4XG5mdW5jdGlvbiBtaWxsZXJSYWJpbkludCh4LGIpIHtcbiAgaWYgKG1yX3gxLmxlbmd0aCE9eC5sZW5ndGgpIHtcbiAgICBtcl94MT1kdXAoeCk7XG4gICAgbXJfcj1kdXAoeCk7XG4gICAgbXJfYT1kdXAoeCk7XG4gIH1cblxuICBjb3B5SW50Xyhtcl9hLGIpO1xuICByZXR1cm4gbWlsbGVyUmFiaW4oeCxtcl9hKTtcbn1cblxuLy9kb2VzIGEgc2luZ2xlIHJvdW5kIG9mIE1pbGxlci1SYWJpbiBiYXNlIGIgY29uc2lkZXIgeCB0byBiZSBhIHBvc3NpYmxlIHByaW1lP1xuLy94IGFuZCBiIGFyZSBiaWdJbnRzIHdpdGggYjx4XG5mdW5jdGlvbiBtaWxsZXJSYWJpbih4LGIpIHtcbiAgdmFyIGksaixrLHM7XG5cbiAgaWYgKG1yX3gxLmxlbmd0aCE9eC5sZW5ndGgpIHtcbiAgICBtcl94MT1kdXAoeCk7XG4gICAgbXJfcj1kdXAoeCk7XG4gICAgbXJfYT1kdXAoeCk7XG4gIH1cblxuICBjb3B5Xyhtcl9hLGIpO1xuICBjb3B5Xyhtcl9yLHgpO1xuICBjb3B5Xyhtcl94MSx4KTtcblxuICBhZGRJbnRfKG1yX3IsLTEpO1xuICBhZGRJbnRfKG1yX3gxLC0xKTtcblxuICAvL3M9dGhlIGhpZ2hlc3QgcG93ZXIgb2YgdHdvIHRoYXQgZGl2aWRlcyBtcl9yXG4gIGs9MDtcbiAgZm9yIChpPTA7aTxtcl9yLmxlbmd0aDtpKyspXG4gICAgZm9yIChqPTE7ajxtYXNrO2o8PD0xKVxuICAgICAgaWYgKHhbaV0gJiBqKSB7XG4gICAgICAgIHM9KGs8bXJfci5sZW5ndGgrYnBlID8gayA6IDApO1xuICAgICAgICAgaT1tcl9yLmxlbmd0aDtcbiAgICAgICAgIGo9bWFzaztcbiAgICAgIH0gZWxzZVxuICAgICAgICBrKys7XG5cbiAgaWYgKHMpXG4gICAgcmlnaHRTaGlmdF8obXJfcixzKTtcblxuICBwb3dNb2RfKG1yX2EsbXJfcix4KTtcblxuICBpZiAoIWVxdWFsc0ludChtcl9hLDEpICYmICFlcXVhbHMobXJfYSxtcl94MSkpIHtcbiAgICBqPTE7XG4gICAgd2hpbGUgKGo8PXMtMSAmJiAhZXF1YWxzKG1yX2EsbXJfeDEpKSB7XG4gICAgICBzcXVhcmVNb2RfKG1yX2EseCk7XG4gICAgICBpZiAoZXF1YWxzSW50KG1yX2EsMSkpIHtcbiAgICAgICAgcmV0dXJuIDA7XG4gICAgICB9XG4gICAgICBqKys7XG4gICAgfVxuICAgIGlmICghZXF1YWxzKG1yX2EsbXJfeDEpKSB7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIDE7XG59XG5cbi8vcmV0dXJucyBob3cgbWFueSBiaXRzIGxvbmcgdGhlIGJpZ0ludCBpcywgbm90IGNvdW50aW5nIGxlYWRpbmcgemVyb3MuXG5mdW5jdGlvbiBiaXRTaXplKHgpIHtcbiAgdmFyIGoseix3O1xuICBmb3IgKGo9eC5sZW5ndGgtMTsgKHhbal09PTApICYmIChqPjApOyBqLS0pO1xuICBmb3IgKHo9MCx3PXhbal07IHc7ICh3Pj49MSkseisrKTtcbiAgeis9YnBlKmo7XG4gIHJldHVybiB6O1xufVxuXG4vL3JldHVybiBhIGNvcHkgb2YgeCB3aXRoIGF0IGxlYXN0IG4gZWxlbWVudHMsIGFkZGluZyBsZWFkaW5nIHplcm9zIGlmIG5lZWRlZFxuZnVuY3Rpb24gZXhwYW5kKHgsbikge1xuICB2YXIgYW5zPWludDJiaWdJbnQoMCwoeC5sZW5ndGg+biA/IHgubGVuZ3RoIDogbikqYnBlLDApO1xuICBjb3B5XyhhbnMseCk7XG4gIHJldHVybiBhbnM7XG59XG5cbi8vcmV0dXJuIGEgay1iaXQgdHJ1ZSByYW5kb20gcHJpbWUgdXNpbmcgTWF1cmVyJ3MgYWxnb3JpdGhtLlxuZnVuY3Rpb24gcmFuZFRydWVQcmltZShrKSB7XG4gIHZhciBhbnM9aW50MmJpZ0ludCgwLGssMCk7XG4gIHJhbmRUcnVlUHJpbWVfKGFucyxrKTtcbiAgcmV0dXJuIHRyaW0oYW5zLDEpO1xufVxuXG4vL3JldHVybiBhIGstYml0IHJhbmRvbSBwcm9iYWJsZSBwcmltZSB3aXRoIHByb2JhYmlsaXR5IG9mIGVycm9yIDwgMl4tODBcbmZ1bmN0aW9uIHJhbmRQcm9iUHJpbWUoaykge1xuICBpZiAoaz49NjAwKSByZXR1cm4gcmFuZFByb2JQcmltZVJvdW5kcyhrLDIpOyAvL251bWJlcnMgZnJvbSBIQUMgdGFibGUgNC4zXG4gIGlmIChrPj01NTApIHJldHVybiByYW5kUHJvYlByaW1lUm91bmRzKGssNCk7XG4gIGlmIChrPj01MDApIHJldHVybiByYW5kUHJvYlByaW1lUm91bmRzKGssNSk7XG4gIGlmIChrPj00MDApIHJldHVybiByYW5kUHJvYlByaW1lUm91bmRzKGssNik7XG4gIGlmIChrPj0zNTApIHJldHVybiByYW5kUHJvYlByaW1lUm91bmRzKGssNyk7XG4gIGlmIChrPj0zMDApIHJldHVybiByYW5kUHJvYlByaW1lUm91bmRzKGssOSk7XG4gIGlmIChrPj0yNTApIHJldHVybiByYW5kUHJvYlByaW1lUm91bmRzKGssMTIpOyAvL251bWJlcnMgZnJvbSBIQUMgdGFibGUgNC40XG4gIGlmIChrPj0yMDApIHJldHVybiByYW5kUHJvYlByaW1lUm91bmRzKGssMTUpO1xuICBpZiAoaz49MTUwKSByZXR1cm4gcmFuZFByb2JQcmltZVJvdW5kcyhrLDE4KTtcbiAgaWYgKGs+PTEwMCkgcmV0dXJuIHJhbmRQcm9iUHJpbWVSb3VuZHMoaywyNyk7XG4gICAgICAgICAgICAgIHJldHVybiByYW5kUHJvYlByaW1lUm91bmRzKGssNDApOyAvL251bWJlciBmcm9tIEhBQyByZW1hcmsgNC4yNiAob25seSBhbiBlc3RpbWF0ZSlcbn1cblxuLy9yZXR1cm4gYSBrLWJpdCBwcm9iYWJsZSByYW5kb20gcHJpbWUgdXNpbmcgbiByb3VuZHMgb2YgTWlsbGVyIFJhYmluIChhZnRlciB0cmlhbCBkaXZpc2lvbiB3aXRoIHNtYWxsIHByaW1lcylcbmZ1bmN0aW9uIHJhbmRQcm9iUHJpbWVSb3VuZHMoayxuKSB7XG4gIHZhciBhbnMsIGksIGRpdmlzaWJsZSwgQjtcbiAgQj0zMDAwMDsgIC8vQiBpcyBsYXJnZXN0IHByaW1lIHRvIHVzZSBpbiB0cmlhbCBkaXZpc2lvblxuICBhbnM9aW50MmJpZ0ludCgwLGssMCk7XG5cbiAgLy9vcHRpbWl6YXRpb246IHRyeSBsYXJnZXIgYW5kIHNtYWxsZXIgQiB0byBmaW5kIHRoZSBiZXN0IGxpbWl0LlxuXG4gIGlmIChwcmltZXMubGVuZ3RoPT0wKVxuICAgIHByaW1lcz1maW5kUHJpbWVzKDMwMDAwKTsgIC8vY2hlY2sgZm9yIGRpdmlzaWJpbGl0eSBieSBwcmltZXMgPD0zMDAwMFxuXG4gIGlmIChycHByYi5sZW5ndGghPWFucy5sZW5ndGgpXG4gICAgcnBwcmI9ZHVwKGFucyk7XG5cbiAgZm9yICg7OykgeyAvL2tlZXAgdHJ5aW5nIHJhbmRvbSB2YWx1ZXMgZm9yIGFucyB1bnRpbCBvbmUgYXBwZWFycyB0byBiZSBwcmltZVxuICAgIC8vb3B0aW1pemF0aW9uOiBwaWNrIGEgcmFuZG9tIG51bWJlciB0aW1lcyBMPTIqMyo1Ki4uLipwLCBwbHVzIGFcbiAgICAvLyAgIHJhbmRvbSBlbGVtZW50IG9mIHRoZSBsaXN0IG9mIGFsbCBudW1iZXJzIGluIFswLEwpIG5vdCBkaXZpc2libGUgYnkgYW55IHByaW1lIHVwIHRvIHAuXG4gICAgLy8gICBUaGlzIGNhbiByZWR1Y2UgdGhlIGFtb3VudCBvZiByYW5kb20gbnVtYmVyIGdlbmVyYXRpb24uXG5cbiAgICByYW5kQmlnSW50XyhhbnMsaywwKTsgLy9hbnMgPSBhIHJhbmRvbSBvZGQgbnVtYmVyIHRvIGNoZWNrXG4gICAgYW5zWzBdIHw9IDE7XG4gICAgZGl2aXNpYmxlPTA7XG5cbiAgICAvL2NoZWNrIGFucyBmb3IgZGl2aXNpYmlsaXR5IGJ5IHNtYWxsIHByaW1lcyB1cCB0byBCXG4gICAgZm9yIChpPTA7IChpPHByaW1lcy5sZW5ndGgpICYmIChwcmltZXNbaV08PUIpOyBpKyspXG4gICAgICBpZiAobW9kSW50KGFucyxwcmltZXNbaV0pPT0wICYmICFlcXVhbHNJbnQoYW5zLHByaW1lc1tpXSkpIHtcbiAgICAgICAgZGl2aXNpYmxlPTE7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgLy9vcHRpbWl6YXRpb246IGNoYW5nZSBtaWxsZXJSYWJpbiBzbyB0aGUgYmFzZSBjYW4gYmUgYmlnZ2VyIHRoYW4gdGhlIG51bWJlciBiZWluZyBjaGVja2VkLCB0aGVuIGVsaW1pbmF0ZSB0aGUgd2hpbGUgaGVyZS5cblxuICAgIC8vZG8gbiByb3VuZHMgb2YgTWlsbGVyIFJhYmluLCB3aXRoIHJhbmRvbSBiYXNlcyBsZXNzIHRoYW4gYW5zXG4gICAgZm9yIChpPTA7IGk8biAmJiAhZGl2aXNpYmxlOyBpKyspIHtcbiAgICAgIHJhbmRCaWdJbnRfKHJwcHJiLGssMCk7XG4gICAgICB3aGlsZSghZ3JlYXRlcihhbnMscnBwcmIpKSAvL3BpY2sgYSByYW5kb20gcnBwcmIgdGhhdCdzIDwgYW5zXG4gICAgICAgIHJhbmRCaWdJbnRfKHJwcHJiLGssMCk7XG4gICAgICBpZiAoIW1pbGxlclJhYmluKGFucyxycHByYikpXG4gICAgICAgIGRpdmlzaWJsZT0xO1xuICAgIH1cblxuICAgIGlmKCFkaXZpc2libGUpXG4gICAgICByZXR1cm4gYW5zO1xuICB9XG59XG5cbi8vcmV0dXJuIGEgbmV3IGJpZ0ludCBlcXVhbCB0byAoeCBtb2QgbikgZm9yIGJpZ0ludHMgeCBhbmQgbi5cbmZ1bmN0aW9uIG1vZCh4LG4pIHtcbiAgdmFyIGFucz1kdXAoeCk7XG4gIG1vZF8oYW5zLG4pO1xuICByZXR1cm4gdHJpbShhbnMsMSk7XG59XG5cbi8vcmV0dXJuICh4K24pIHdoZXJlIHggaXMgYSBiaWdJbnQgYW5kIG4gaXMgYW4gaW50ZWdlci5cbmZ1bmN0aW9uIGFkZEludCh4LG4pIHtcbiAgdmFyIGFucz1leHBhbmQoeCx4Lmxlbmd0aCsxKTtcbiAgYWRkSW50XyhhbnMsbik7XG4gIHJldHVybiB0cmltKGFucywxKTtcbn1cblxuLy9yZXR1cm4geCp5IGZvciBiaWdJbnRzIHggYW5kIHkuIFRoaXMgaXMgZmFzdGVyIHdoZW4geTx4LlxuZnVuY3Rpb24gbXVsdCh4LHkpIHtcbiAgdmFyIGFucz1leHBhbmQoeCx4Lmxlbmd0aCt5Lmxlbmd0aCk7XG4gIG11bHRfKGFucyx5KTtcbiAgcmV0dXJuIHRyaW0oYW5zLDEpO1xufVxuXG4vL3JldHVybiAoeCoqeSBtb2Qgbikgd2hlcmUgeCx5LG4gYXJlIGJpZ0ludHMgYW5kICoqIGlzIGV4cG9uZW50aWF0aW9uLiAgMCoqMD0xLiBGYXN0ZXIgZm9yIG9kZCBuLlxuZnVuY3Rpb24gcG93TW9kKHgseSxuKSB7XG4gIHZhciBhbnM9ZXhwYW5kKHgsbi5sZW5ndGgpO1xuICBwb3dNb2RfKGFucyx0cmltKHksMiksdHJpbShuLDIpLDApOyAgLy90aGlzIHNob3VsZCB3b3JrIHdpdGhvdXQgdGhlIHRyaW0sIGJ1dCBkb2Vzbid0XG4gIHJldHVybiB0cmltKGFucywxKTtcbn1cblxuLy9yZXR1cm4gKHgteSkgZm9yIGJpZ0ludHMgeCBhbmQgeS4gIE5lZ2F0aXZlIGFuc3dlcnMgd2lsbCBiZSAycyBjb21wbGVtZW50XG5mdW5jdGlvbiBzdWIoeCx5KSB7XG4gIHZhciBhbnM9ZXhwYW5kKHgsKHgubGVuZ3RoPnkubGVuZ3RoID8geC5sZW5ndGgrMSA6IHkubGVuZ3RoKzEpKTtcbiAgc3ViXyhhbnMseSk7XG4gIHJldHVybiB0cmltKGFucywxKTtcbn1cblxuLy9yZXR1cm4gKHgreSkgZm9yIGJpZ0ludHMgeCBhbmQgeS5cbmZ1bmN0aW9uIGFkZCh4LHkpIHtcbiAgdmFyIGFucz1leHBhbmQoeCwoeC5sZW5ndGg+eS5sZW5ndGggPyB4Lmxlbmd0aCsxIDogeS5sZW5ndGgrMSkpO1xuICBhZGRfKGFucyx5KTtcbiAgcmV0dXJuIHRyaW0oYW5zLDEpO1xufVxuXG4vL3JldHVybiAoeCoqKC0xKSBtb2QgbikgZm9yIGJpZ0ludHMgeCBhbmQgbi4gIElmIG5vIGludmVyc2UgZXhpc3RzLCBpdCByZXR1cm5zIG51bGxcbmZ1bmN0aW9uIGludmVyc2VNb2QoeCxuKSB7XG4gIHZhciBhbnM9ZXhwYW5kKHgsbi5sZW5ndGgpO1xuICB2YXIgcztcbiAgcz1pbnZlcnNlTW9kXyhhbnMsbik7XG4gIHJldHVybiBzID8gdHJpbShhbnMsMSkgOiBudWxsO1xufVxuXG4vL3JldHVybiAoeCp5IG1vZCBuKSBmb3IgYmlnSW50cyB4LHksbi4gIEZvciBncmVhdGVyIHNwZWVkLCBsZXQgeTx4LlxuZnVuY3Rpb24gbXVsdE1vZCh4LHksbikge1xuICB2YXIgYW5zPWV4cGFuZCh4LG4ubGVuZ3RoKTtcbiAgbXVsdE1vZF8oYW5zLHksbik7XG4gIHJldHVybiB0cmltKGFucywxKTtcbn1cblxuLy9nZW5lcmF0ZSBhIGstYml0IHRydWUgcmFuZG9tIHByaW1lIHVzaW5nIE1hdXJlcidzIGFsZ29yaXRobSxcbi8vYW5kIHB1dCBpdCBpbnRvIGFucy4gIFRoZSBiaWdJbnQgYW5zIG11c3QgYmUgbGFyZ2UgZW5vdWdoIHRvIGhvbGQgaXQuXG5mdW5jdGlvbiByYW5kVHJ1ZVByaW1lXyhhbnMsaykge1xuICB2YXIgYyxtLHBtLGRkLGoscixCLGRpdmlzaWJsZSx6LHp6LHJlY1NpemU7XG5cbiAgaWYgKHByaW1lcy5sZW5ndGg9PTApXG4gICAgcHJpbWVzPWZpbmRQcmltZXMoMzAwMDApOyAgLy9jaGVjayBmb3IgZGl2aXNpYmlsaXR5IGJ5IHByaW1lcyA8PTMwMDAwXG5cbiAgaWYgKHBvd3MubGVuZ3RoPT0wKSB7XG4gICAgcG93cz1uZXcgQXJyYXkoNTEyKTtcbiAgICBmb3IgKGo9MDtqPDUxMjtqKyspIHtcbiAgICAgIHBvd3Nbal09TWF0aC5wb3coMixqLzUxMS4tMS4pO1xuICAgIH1cbiAgfVxuXG4gIC8vYyBhbmQgbSBzaG91bGQgYmUgdHVuZWQgZm9yIGEgcGFydGljdWxhciBtYWNoaW5lIGFuZCB2YWx1ZSBvZiBrLCB0byBtYXhpbWl6ZSBzcGVlZFxuICBjPTAuMTsgIC8vYz0wLjEgaW4gSEFDXG4gIG09MjA7ICAgLy9nZW5lcmF0ZSB0aGlzIGstYml0IG51bWJlciBieSBmaXJzdCByZWN1cnNpdmVseSBnZW5lcmF0aW5nIGEgbnVtYmVyIHRoYXQgaGFzIGJldHdlZW4gay8yIGFuZCBrLW0gYml0c1xuICByZWNMaW1pdD0yMDsgLy9zdG9wIHJlY3Vyc2lvbiB3aGVuIGsgPD1yZWNMaW1pdC4gIE11c3QgaGF2ZSByZWNMaW1pdCA+PSAyXG5cbiAgaWYgKHNfaTIubGVuZ3RoIT1hbnMubGVuZ3RoKSB7XG4gICAgc19pMj1kdXAoYW5zKTtcbiAgICBzX1IgPWR1cChhbnMpO1xuICAgIHNfbjE9ZHVwKGFucyk7XG4gICAgc19yMj1kdXAoYW5zKTtcbiAgICBzX2QgPWR1cChhbnMpO1xuICAgIHNfeDE9ZHVwKGFucyk7XG4gICAgc194Mj1kdXAoYW5zKTtcbiAgICBzX2IgPWR1cChhbnMpO1xuICAgIHNfbiA9ZHVwKGFucyk7XG4gICAgc19pID1kdXAoYW5zKTtcbiAgICBzX3JtPWR1cChhbnMpO1xuICAgIHNfcSA9ZHVwKGFucyk7XG4gICAgc19hID1kdXAoYW5zKTtcbiAgICBzX2FhPWR1cChhbnMpO1xuICB9XG5cbiAgaWYgKGsgPD0gcmVjTGltaXQpIHsgIC8vZ2VuZXJhdGUgc21hbGwgcmFuZG9tIHByaW1lcyBieSB0cmlhbCBkaXZpc2lvbiB1cCB0byBpdHMgc3F1YXJlIHJvb3RcbiAgICBwbT0oMTw8KChrKzIpPj4xKSktMTsgLy9wbSBpcyBiaW5hcnkgbnVtYmVyIHdpdGggYWxsIG9uZXMsIGp1c3Qgb3ZlciBzcXJ0KDJeaylcbiAgICBjb3B5SW50XyhhbnMsMCk7XG4gICAgZm9yIChkZD0xO2RkOykge1xuICAgICAgZGQ9MDtcbiAgICAgIGFuc1swXT0gMSB8ICgxPDwoay0xKSkgfCBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkqKDE8PGspKTsgIC8vcmFuZG9tLCBrLWJpdCwgb2RkIGludGVnZXIsIHdpdGggbXNiIDFcbiAgICAgIGZvciAoaj0xOyhqPHByaW1lcy5sZW5ndGgpICYmICgocHJpbWVzW2pdJnBtKT09cHJpbWVzW2pdKTtqKyspIHsgLy90cmlhbCBkaXZpc2lvbiBieSBhbGwgcHJpbWVzIDMuLi5zcXJ0KDJeaylcbiAgICAgICAgaWYgKDA9PShhbnNbMF0lcHJpbWVzW2pdKSkge1xuICAgICAgICAgIGRkPTE7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgY2FycnlfKGFucyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgQj1jKmsqazsgICAgLy90cnkgc21hbGwgcHJpbWVzIHVwIHRvIEIgKG9yIGFsbCB0aGUgcHJpbWVzW10gYXJyYXkgaWYgdGhlIGxhcmdlc3QgaXMgbGVzcyB0aGFuIEIpLlxuICBpZiAoaz4yKm0pICAvL2dlbmVyYXRlIHRoaXMgay1iaXQgbnVtYmVyIGJ5IGZpcnN0IHJlY3Vyc2l2ZWx5IGdlbmVyYXRpbmcgYSBudW1iZXIgdGhhdCBoYXMgYmV0d2VlbiBrLzIgYW5kIGstbSBiaXRzXG4gICAgZm9yIChyPTE7IGstaypyPD1tOyApXG4gICAgICByPXBvd3NbTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKjUxMildOyAgIC8vcj1NYXRoLnBvdygyLE1hdGgucmFuZG9tKCktMSk7XG4gIGVsc2VcbiAgICByPS41O1xuXG4gIC8vc2ltdWxhdGlvbiBzdWdnZXN0cyB0aGUgbW9yZSBjb21wbGV4IGFsZ29yaXRobSB1c2luZyByPS4zMzMgaXMgb25seSBzbGlnaHRseSBmYXN0ZXIuXG5cbiAgcmVjU2l6ZT1NYXRoLmZsb29yKHIqaykrMTtcblxuICByYW5kVHJ1ZVByaW1lXyhzX3EscmVjU2l6ZSk7XG4gIGNvcHlJbnRfKHNfaTIsMCk7XG4gIHNfaTJbTWF0aC5mbG9vcigoay0yKS9icGUpXSB8PSAoMTw8KChrLTIpJWJwZSkpOyAgIC8vc19pMj0yXihrLTIpXG4gIGRpdmlkZV8oc19pMixzX3Esc19pLHNfcm0pOyAgICAgICAgICAgICAgICAgICAgICAgIC8vc19pPWZsb29yKCgyXihrLTEpKS8oMnEpKVxuXG4gIHo9Yml0U2l6ZShzX2kpO1xuXG4gIGZvciAoOzspIHtcbiAgICBmb3IgKDs7KSB7ICAvL2dlbmVyYXRlIHotYml0IG51bWJlcnMgdW50aWwgb25lIGZhbGxzIGluIHRoZSByYW5nZSBbMCxzX2ktMV1cbiAgICAgIHJhbmRCaWdJbnRfKHNfUix6LDApO1xuICAgICAgaWYgKGdyZWF0ZXIoc19pLHNfUikpXG4gICAgICAgIGJyZWFrO1xuICAgIH0gICAgICAgICAgICAgICAgLy9ub3cgc19SIGlzIGluIHRoZSByYW5nZSBbMCxzX2ktMV1cbiAgICBhZGRJbnRfKHNfUiwxKTsgIC8vbm93IHNfUiBpcyBpbiB0aGUgcmFuZ2UgWzEsc19pXVxuICAgIGFkZF8oc19SLHNfaSk7ICAgLy9ub3cgc19SIGlzIGluIHRoZSByYW5nZSBbc19pKzEsMipzX2ldXG5cbiAgICBjb3B5XyhzX24sc19xKTtcbiAgICBtdWx0XyhzX24sc19SKTtcbiAgICBtdWx0SW50XyhzX24sMik7XG4gICAgYWRkSW50XyhzX24sMSk7ICAgIC8vc19uPTIqc19SKnNfcSsxXG5cbiAgICBjb3B5XyhzX3IyLHNfUik7XG4gICAgbXVsdEludF8oc19yMiwyKTsgIC8vc19yMj0yKnNfUlxuXG4gICAgLy9jaGVjayBzX24gZm9yIGRpdmlzaWJpbGl0eSBieSBzbWFsbCBwcmltZXMgdXAgdG8gQlxuICAgIGZvciAoZGl2aXNpYmxlPTAsaj0wOyAoajxwcmltZXMubGVuZ3RoKSAmJiAocHJpbWVzW2pdPEIpOyBqKyspXG4gICAgICBpZiAobW9kSW50KHNfbixwcmltZXNbal0pPT0wICYmICFlcXVhbHNJbnQoc19uLHByaW1lc1tqXSkpIHtcbiAgICAgICAgZGl2aXNpYmxlPTE7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgaWYgKCFkaXZpc2libGUpICAgIC8vaWYgaXQgcGFzc2VzIHNtYWxsIHByaW1lcyBjaGVjaywgdGhlbiB0cnkgYSBzaW5nbGUgTWlsbGVyLVJhYmluIGJhc2UgMlxuICAgICAgaWYgKCFtaWxsZXJSYWJpbkludChzX24sMikpIC8vdGhpcyBsaW5lIHJlcHJlc2VudHMgNzUlIG9mIHRoZSB0b3RhbCBydW50aW1lIGZvciByYW5kVHJ1ZVByaW1lX1xuICAgICAgICBkaXZpc2libGU9MTtcblxuICAgIGlmICghZGl2aXNpYmxlKSB7ICAvL2lmIGl0IHBhc3NlcyB0aGF0IHRlc3QsIGNvbnRpbnVlIGNoZWNraW5nIHNfblxuICAgICAgYWRkSW50XyhzX24sLTMpO1xuICAgICAgZm9yIChqPXNfbi5sZW5ndGgtMTsoc19uW2pdPT0wKSAmJiAoaj4wKTsgai0tKTsgIC8vc3RyaXAgbGVhZGluZyB6ZXJvc1xuICAgICAgZm9yICh6ej0wLHc9c19uW2pdOyB3OyAodz4+PTEpLHp6KyspO1xuICAgICAgenorPWJwZSpqOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy96ej1udW1iZXIgb2YgYml0cyBpbiBzX24sIGlnbm9yaW5nIGxlYWRpbmcgemVyb3NcbiAgICAgIGZvciAoOzspIHsgIC8vZ2VuZXJhdGUgei1iaXQgbnVtYmVycyB1bnRpbCBvbmUgZmFsbHMgaW4gdGhlIHJhbmdlIFswLHNfbi0xXVxuICAgICAgICByYW5kQmlnSW50XyhzX2EsenosMCk7XG4gICAgICAgIGlmIChncmVhdGVyKHNfbixzX2EpKVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgfSAgICAgICAgICAgICAgICAvL25vdyBzX2EgaXMgaW4gdGhlIHJhbmdlIFswLHNfbi0xXVxuICAgICAgYWRkSW50XyhzX24sMyk7ICAvL25vdyBzX2EgaXMgaW4gdGhlIHJhbmdlIFswLHNfbi00XVxuICAgICAgYWRkSW50XyhzX2EsMik7ICAvL25vdyBzX2EgaXMgaW4gdGhlIHJhbmdlIFsyLHNfbi0yXVxuICAgICAgY29weV8oc19iLHNfYSk7XG4gICAgICBjb3B5XyhzX24xLHNfbik7XG4gICAgICBhZGRJbnRfKHNfbjEsLTEpO1xuICAgICAgcG93TW9kXyhzX2Isc19uMSxzX24pOyAgIC8vc19iPXNfYV4oc19uLTEpIG1vZHVsbyBzX25cbiAgICAgIGFkZEludF8oc19iLC0xKTtcbiAgICAgIGlmIChpc1plcm8oc19iKSkge1xuICAgICAgICBjb3B5XyhzX2Isc19hKTtcbiAgICAgICAgcG93TW9kXyhzX2Isc19yMixzX24pO1xuICAgICAgICBhZGRJbnRfKHNfYiwtMSk7XG4gICAgICAgIGNvcHlfKHNfYWEsc19uKTtcbiAgICAgICAgY29weV8oc19kLHNfYik7XG4gICAgICAgIEdDRF8oc19kLHNfbik7ICAvL2lmIHNfYiBhbmQgc19uIGFyZSByZWxhdGl2ZWx5IHByaW1lLCB0aGVuIHNfbiBpcyBhIHByaW1lXG4gICAgICAgIGlmIChlcXVhbHNJbnQoc19kLDEpKSB7XG4gICAgICAgICAgY29weV8oYW5zLHNfYWEpO1xuICAgICAgICAgIHJldHVybjsgICAgIC8vaWYgd2UndmUgbWFkZSBpdCB0aGlzIGZhciwgdGhlbiBzX24gaXMgYWJzb2x1dGVseSBndWFyYW50ZWVkIHRvIGJlIHByaW1lXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cblxuLy9SZXR1cm4gYW4gbi1iaXQgcmFuZG9tIEJpZ0ludCAobj49MSkuICBJZiBzPTEsIHRoZW4gdGhlIG1vc3Qgc2lnbmlmaWNhbnQgb2YgdGhvc2UgbiBiaXRzIGlzIHNldCB0byAxLlxuZnVuY3Rpb24gcmFuZEJpZ0ludChuLHMpIHtcbiAgdmFyIGEsYjtcbiAgYT1NYXRoLmZsb29yKChuLTEpL2JwZSkrMjsgLy8jIGFycmF5IGVsZW1lbnRzIHRvIGhvbGQgdGhlIEJpZ0ludCB3aXRoIGEgbGVhZGluZyAwIGVsZW1lbnRcbiAgYj1pbnQyYmlnSW50KDAsMCxhKTtcbiAgcmFuZEJpZ0ludF8oYixuLHMpO1xuICByZXR1cm4gYjtcbn1cblxuLy9TZXQgYiB0byBhbiBuLWJpdCByYW5kb20gQmlnSW50LiAgSWYgcz0xLCB0aGVuIHRoZSBtb3N0IHNpZ25pZmljYW50IG9mIHRob3NlIG4gYml0cyBpcyBzZXQgdG8gMS5cbi8vQXJyYXkgYiBtdXN0IGJlIGJpZyBlbm91Z2ggdG8gaG9sZCB0aGUgcmVzdWx0LiBNdXN0IGhhdmUgbj49MVxuZnVuY3Rpb24gcmFuZEJpZ0ludF8oYixuLHMpIHtcbiAgdmFyIGksYTtcbiAgZm9yIChpPTA7aTxiLmxlbmd0aDtpKyspXG4gICAgYltpXT0wO1xuICBhPU1hdGguZmxvb3IoKG4tMSkvYnBlKSsxOyAvLyMgYXJyYXkgZWxlbWVudHMgdG8gaG9sZCB0aGUgQmlnSW50XG4gIGZvciAoaT0wO2k8YTtpKyspIHtcbiAgICBiW2ldPU1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSooMTw8KGJwZS0xKSkpO1xuICB9XG4gIGJbYS0xXSAmPSAoMjw8KChuLTEpJWJwZSkpLTE7XG4gIGlmIChzPT0xKVxuICAgIGJbYS0xXSB8PSAoMTw8KChuLTEpJWJwZSkpO1xufVxuXG4vL1JldHVybiB0aGUgZ3JlYXRlc3QgY29tbW9uIGRpdmlzb3Igb2YgYmlnSW50cyB4IGFuZCB5IChlYWNoIHdpdGggc2FtZSBudW1iZXIgb2YgZWxlbWVudHMpLlxuZnVuY3Rpb24gR0NEKHgseSkge1xuICB2YXIgeGMseWM7XG4gIHhjPWR1cCh4KTtcbiAgeWM9ZHVwKHkpO1xuICBHQ0RfKHhjLHljKTtcbiAgcmV0dXJuIHhjO1xufVxuXG4vL3NldCB4IHRvIHRoZSBncmVhdGVzdCBjb21tb24gZGl2aXNvciBvZiBiaWdJbnRzIHggYW5kIHkgKGVhY2ggd2l0aCBzYW1lIG51bWJlciBvZiBlbGVtZW50cykuXG4vL3kgaXMgZGVzdHJveWVkLlxuZnVuY3Rpb24gR0NEXyh4LHkpIHtcbiAgdmFyIGkseHAseXAsQSxCLEMsRCxxLHNpbmc7XG4gIGlmIChULmxlbmd0aCE9eC5sZW5ndGgpXG4gICAgVD1kdXAoeCk7XG5cbiAgc2luZz0xO1xuICB3aGlsZSAoc2luZykgeyAvL3doaWxlIHkgaGFzIG5vbnplcm8gZWxlbWVudHMgb3RoZXIgdGhhbiB5WzBdXG4gICAgc2luZz0wO1xuICAgIGZvciAoaT0xO2k8eS5sZW5ndGg7aSsrKSAvL2NoZWNrIGlmIHkgaGFzIG5vbnplcm8gZWxlbWVudHMgb3RoZXIgdGhhbiAwXG4gICAgICBpZiAoeVtpXSkge1xuICAgICAgICBzaW5nPTE7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIGlmICghc2luZykgYnJlYWs7IC8vcXVpdCB3aGVuIHkgYWxsIHplcm8gZWxlbWVudHMgZXhjZXB0IHBvc3NpYmx5IHlbMF1cblxuICAgIGZvciAoaT14Lmxlbmd0aDsheFtpXSAmJiBpPj0wO2ktLSk7ICAvL2ZpbmQgbW9zdCBzaWduaWZpY2FudCBlbGVtZW50IG9mIHhcbiAgICB4cD14W2ldO1xuICAgIHlwPXlbaV07XG4gICAgQT0xOyBCPTA7IEM9MDsgRD0xO1xuICAgIHdoaWxlICgoeXArQykgJiYgKHlwK0QpKSB7XG4gICAgICBxID1NYXRoLmZsb29yKCh4cCtBKS8oeXArQykpO1xuICAgICAgcXA9TWF0aC5mbG9vcigoeHArQikvKHlwK0QpKTtcbiAgICAgIGlmIChxIT1xcClcbiAgICAgICAgYnJlYWs7XG4gICAgICB0PSBBLXEqQzsgICBBPUM7ICAgQz10OyAgICAvLyAgZG8gKEEsQix4cCwgQyxELHlwKSA9IChDLEQseXAsIEEsQix4cCkgLSBxKigwLDAsMCwgQyxELHlwKVxuICAgICAgdD0gQi1xKkQ7ICAgQj1EOyAgIEQ9dDtcbiAgICAgIHQ9eHAtcSp5cDsgeHA9eXA7IHlwPXQ7XG4gICAgfVxuICAgIGlmIChCKSB7XG4gICAgICBjb3B5XyhULHgpO1xuICAgICAgbGluQ29tYl8oeCx5LEEsQik7IC8veD1BKngrQip5XG4gICAgICBsaW5Db21iXyh5LFQsRCxDKTsgLy95PUQqeStDKlRcbiAgICB9IGVsc2Uge1xuICAgICAgbW9kXyh4LHkpO1xuICAgICAgY29weV8oVCx4KTtcbiAgICAgIGNvcHlfKHgseSk7XG4gICAgICBjb3B5Xyh5LFQpO1xuICAgIH1cbiAgfVxuICBpZiAoeVswXT09MClcbiAgICByZXR1cm47XG4gIHQ9bW9kSW50KHgseVswXSk7XG4gIGNvcHlJbnRfKHgseVswXSk7XG4gIHlbMF09dDtcbiAgd2hpbGUgKHlbMF0pIHtcbiAgICB4WzBdJT15WzBdO1xuICAgIHQ9eFswXTsgeFswXT15WzBdOyB5WzBdPXQ7XG4gIH1cbn1cblxuLy9kbyB4PXgqKigtMSkgbW9kIG4sIGZvciBiaWdJbnRzIHggYW5kIG4uXG4vL0lmIG5vIGludmVyc2UgZXhpc3RzLCBpdCBzZXRzIHggdG8gemVybyBhbmQgcmV0dXJucyAwLCBlbHNlIGl0IHJldHVybnMgMS5cbi8vVGhlIHggYXJyYXkgbXVzdCBiZSBhdCBsZWFzdCBhcyBsYXJnZSBhcyB0aGUgbiBhcnJheS5cbmZ1bmN0aW9uIGludmVyc2VNb2RfKHgsbikge1xuICB2YXIgaz0xKzIqTWF0aC5tYXgoeC5sZW5ndGgsbi5sZW5ndGgpO1xuXG4gIGlmKCEoeFswXSYxKSAgJiYgIShuWzBdJjEpKSB7ICAvL2lmIGJvdGggaW5wdXRzIGFyZSBldmVuLCB0aGVuIGludmVyc2UgZG9lc24ndCBleGlzdFxuICAgIGNvcHlJbnRfKHgsMCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAoZWdfdS5sZW5ndGghPWspIHtcbiAgICBlZ191PW5ldyBBcnJheShrKTtcbiAgICBlZ192PW5ldyBBcnJheShrKTtcbiAgICBlZ19BPW5ldyBBcnJheShrKTtcbiAgICBlZ19CPW5ldyBBcnJheShrKTtcbiAgICBlZ19DPW5ldyBBcnJheShrKTtcbiAgICBlZ19EPW5ldyBBcnJheShrKTtcbiAgfVxuXG4gIGNvcHlfKGVnX3UseCk7XG4gIGNvcHlfKGVnX3Ysbik7XG4gIGNvcHlJbnRfKGVnX0EsMSk7XG4gIGNvcHlJbnRfKGVnX0IsMCk7XG4gIGNvcHlJbnRfKGVnX0MsMCk7XG4gIGNvcHlJbnRfKGVnX0QsMSk7XG4gIGZvciAoOzspIHtcbiAgICB3aGlsZSghKGVnX3VbMF0mMSkpIHsgIC8vd2hpbGUgZWdfdSBpcyBldmVuXG4gICAgICBoYWx2ZV8oZWdfdSk7XG4gICAgICBpZiAoIShlZ19BWzBdJjEpICYmICEoZWdfQlswXSYxKSkgeyAvL2lmIGVnX0E9PWVnX0I9PTAgbW9kIDJcbiAgICAgICAgaGFsdmVfKGVnX0EpO1xuICAgICAgICBoYWx2ZV8oZWdfQik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhZGRfKGVnX0Esbik7ICBoYWx2ZV8oZWdfQSk7XG4gICAgICAgIHN1Yl8oZWdfQix4KTsgIGhhbHZlXyhlZ19CKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB3aGlsZSAoIShlZ192WzBdJjEpKSB7ICAvL3doaWxlIGVnX3YgaXMgZXZlblxuICAgICAgaGFsdmVfKGVnX3YpO1xuICAgICAgaWYgKCEoZWdfQ1swXSYxKSAmJiAhKGVnX0RbMF0mMSkpIHsgLy9pZiBlZ19DPT1lZ19EPT0wIG1vZCAyXG4gICAgICAgIGhhbHZlXyhlZ19DKTtcbiAgICAgICAgaGFsdmVfKGVnX0QpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYWRkXyhlZ19DLG4pOyAgaGFsdmVfKGVnX0MpO1xuICAgICAgICBzdWJfKGVnX0QseCk7ICBoYWx2ZV8oZWdfRCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCFncmVhdGVyKGVnX3YsZWdfdSkpIHsgLy9lZ192IDw9IGVnX3VcbiAgICAgIHN1Yl8oZWdfdSxlZ192KTtcbiAgICAgIHN1Yl8oZWdfQSxlZ19DKTtcbiAgICAgIHN1Yl8oZWdfQixlZ19EKTtcbiAgICB9IGVsc2UgeyAgICAgICAgICAgICAgICAgICAvL2VnX3YgPiBlZ191XG4gICAgICBzdWJfKGVnX3YsZWdfdSk7XG4gICAgICBzdWJfKGVnX0MsZWdfQSk7XG4gICAgICBzdWJfKGVnX0QsZWdfQik7XG4gICAgfVxuXG4gICAgaWYgKGVxdWFsc0ludChlZ191LDApKSB7XG4gICAgICBpZiAobmVnYXRpdmUoZWdfQykpIC8vbWFrZSBzdXJlIGFuc3dlciBpcyBub25uZWdhdGl2ZVxuICAgICAgICBhZGRfKGVnX0Msbik7XG4gICAgICBjb3B5Xyh4LGVnX0MpO1xuXG4gICAgICBpZiAoIWVxdWFsc0ludChlZ192LDEpKSB7IC8vaWYgR0NEXyh4LG4pIT0xLCB0aGVuIHRoZXJlIGlzIG5vIGludmVyc2VcbiAgICAgICAgY29weUludF8oeCwwKTtcbiAgICAgICAgcmV0dXJuIDA7XG4gICAgICB9XG4gICAgICByZXR1cm4gMTtcbiAgICB9XG4gIH1cbn1cblxuLy9yZXR1cm4geCoqKC0xKSBtb2QgbiwgZm9yIGludGVnZXJzIHggYW5kIG4uICBSZXR1cm4gMCBpZiB0aGVyZSBpcyBubyBpbnZlcnNlXG5mdW5jdGlvbiBpbnZlcnNlTW9kSW50KHgsbikge1xuICB2YXIgYT0xLGI9MCx0O1xuICBmb3IgKDs7KSB7XG4gICAgaWYgKHg9PTEpIHJldHVybiBhO1xuICAgIGlmICh4PT0wKSByZXR1cm4gMDtcbiAgICBiLT1hKk1hdGguZmxvb3Iobi94KTtcbiAgICBuJT14O1xuXG4gICAgaWYgKG49PTEpIHJldHVybiBiOyAvL3RvIGF2b2lkIG5lZ2F0aXZlcywgY2hhbmdlIHRoaXMgYiB0byBuLWIsIGFuZCBlYWNoIC09IHRvICs9XG4gICAgaWYgKG49PTApIHJldHVybiAwO1xuICAgIGEtPWIqTWF0aC5mbG9vcih4L24pO1xuICAgIHglPW47XG4gIH1cbn1cblxuLy90aGlzIGRlcHJlY2F0ZWQgZnVuY3Rpb24gaXMgZm9yIGJhY2t3YXJkIGNvbXBhdGliaWxpdHkgb25seS5cbmZ1bmN0aW9uIGludmVyc2VNb2RJbnRfKHgsbikge1xuICAgcmV0dXJuIGludmVyc2VNb2RJbnQoeCxuKTtcbn1cblxuXG4vL0dpdmVuIHBvc2l0aXZlIGJpZ0ludHMgeCBhbmQgeSwgY2hhbmdlIHRoZSBiaWdpbnRzIHYsIGEsIGFuZCBiIHRvIHBvc2l0aXZlIGJpZ0ludHMgc3VjaCB0aGF0OlxuLy8gICAgIHYgPSBHQ0RfKHgseSkgPSBhKngtYip5XG4vL1RoZSBiaWdJbnRzIHYsIGEsIGIsIG11c3QgaGF2ZSBleGFjdGx5IGFzIG1hbnkgZWxlbWVudHMgYXMgdGhlIGxhcmdlciBvZiB4IGFuZCB5LlxuZnVuY3Rpb24gZUdDRF8oeCx5LHYsYSxiKSB7XG4gIHZhciBnPTA7XG4gIHZhciBrPU1hdGgubWF4KHgubGVuZ3RoLHkubGVuZ3RoKTtcbiAgaWYgKGVnX3UubGVuZ3RoIT1rKSB7XG4gICAgZWdfdT1uZXcgQXJyYXkoayk7XG4gICAgZWdfQT1uZXcgQXJyYXkoayk7XG4gICAgZWdfQj1uZXcgQXJyYXkoayk7XG4gICAgZWdfQz1uZXcgQXJyYXkoayk7XG4gICAgZWdfRD1uZXcgQXJyYXkoayk7XG4gIH1cbiAgd2hpbGUoISh4WzBdJjEpICAmJiAhKHlbMF0mMSkpIHsgIC8vd2hpbGUgeCBhbmQgeSBib3RoIGV2ZW5cbiAgICBoYWx2ZV8oeCk7XG4gICAgaGFsdmVfKHkpO1xuICAgIGcrKztcbiAgfVxuICBjb3B5XyhlZ191LHgpO1xuICBjb3B5Xyh2LHkpO1xuICBjb3B5SW50XyhlZ19BLDEpO1xuICBjb3B5SW50XyhlZ19CLDApO1xuICBjb3B5SW50XyhlZ19DLDApO1xuICBjb3B5SW50XyhlZ19ELDEpO1xuICBmb3IgKDs7KSB7XG4gICAgd2hpbGUoIShlZ191WzBdJjEpKSB7ICAvL3doaWxlIHUgaXMgZXZlblxuICAgICAgaGFsdmVfKGVnX3UpO1xuICAgICAgaWYgKCEoZWdfQVswXSYxKSAmJiAhKGVnX0JbMF0mMSkpIHsgLy9pZiBBPT1CPT0wIG1vZCAyXG4gICAgICAgIGhhbHZlXyhlZ19BKTtcbiAgICAgICAgaGFsdmVfKGVnX0IpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYWRkXyhlZ19BLHkpOyAgaGFsdmVfKGVnX0EpO1xuICAgICAgICBzdWJfKGVnX0IseCk7ICBoYWx2ZV8oZWdfQik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgd2hpbGUgKCEodlswXSYxKSkgeyAgLy93aGlsZSB2IGlzIGV2ZW5cbiAgICAgIGhhbHZlXyh2KTtcbiAgICAgIGlmICghKGVnX0NbMF0mMSkgJiYgIShlZ19EWzBdJjEpKSB7IC8vaWYgQz09RD09MCBtb2QgMlxuICAgICAgICBoYWx2ZV8oZWdfQyk7XG4gICAgICAgIGhhbHZlXyhlZ19EKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGFkZF8oZWdfQyx5KTsgIGhhbHZlXyhlZ19DKTtcbiAgICAgICAgc3ViXyhlZ19ELHgpOyAgaGFsdmVfKGVnX0QpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICghZ3JlYXRlcih2LGVnX3UpKSB7IC8vdjw9dVxuICAgICAgc3ViXyhlZ191LHYpO1xuICAgICAgc3ViXyhlZ19BLGVnX0MpO1xuICAgICAgc3ViXyhlZ19CLGVnX0QpO1xuICAgIH0gZWxzZSB7ICAgICAgICAgICAgICAgIC8vdj51XG4gICAgICBzdWJfKHYsZWdfdSk7XG4gICAgICBzdWJfKGVnX0MsZWdfQSk7XG4gICAgICBzdWJfKGVnX0QsZWdfQik7XG4gICAgfVxuICAgIGlmIChlcXVhbHNJbnQoZWdfdSwwKSkge1xuICAgICAgaWYgKG5lZ2F0aXZlKGVnX0MpKSB7ICAgLy9tYWtlIHN1cmUgYSAoQylpcyBub25uZWdhdGl2ZVxuICAgICAgICBhZGRfKGVnX0MseSk7XG4gICAgICAgIHN1Yl8oZWdfRCx4KTtcbiAgICAgIH1cbiAgICAgIG11bHRJbnRfKGVnX0QsLTEpOyAgLy8vbWFrZSBzdXJlIGIgKEQpIGlzIG5vbm5lZ2F0aXZlXG4gICAgICBjb3B5XyhhLGVnX0MpO1xuICAgICAgY29weV8oYixlZ19EKTtcbiAgICAgIGxlZnRTaGlmdF8odixnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cbn1cblxuXG4vL2lzIGJpZ0ludCB4IG5lZ2F0aXZlP1xuZnVuY3Rpb24gbmVnYXRpdmUoeCkge1xuICByZXR1cm4gKCh4W3gubGVuZ3RoLTFdPj4oYnBlLTEpKSYxKTtcbn1cblxuXG4vL2lzICh4IDw8IChzaGlmdCpicGUpKSA+IHk/XG4vL3ggYW5kIHkgYXJlIG5vbm5lZ2F0aXZlIGJpZ0ludHNcbi8vc2hpZnQgaXMgYSBub25uZWdhdGl2ZSBpbnRlZ2VyXG5mdW5jdGlvbiBncmVhdGVyU2hpZnQoeCx5LHNoaWZ0KSB7XG4gIHZhciBpLCBreD14Lmxlbmd0aCwga3k9eS5sZW5ndGg7XG4gIGs9KChreCtzaGlmdCk8a3kpID8gKGt4K3NoaWZ0KSA6IGt5O1xuICBmb3IgKGk9a3ktMS1zaGlmdDsgaTxreCAmJiBpPj0wOyBpKyspXG4gICAgaWYgKHhbaV0+MClcbiAgICAgIHJldHVybiAxOyAvL2lmIHRoZXJlIGFyZSBub256ZXJvcyBpbiB4IHRvIHRoZSBsZWZ0IG9mIHRoZSBmaXJzdCBjb2x1bW4gb2YgeSwgdGhlbiB4IGlzIGJpZ2dlclxuICBmb3IgKGk9a3gtMStzaGlmdDsgaTxreTsgaSsrKVxuICAgIGlmICh5W2ldPjApXG4gICAgICByZXR1cm4gMDsgLy9pZiB0aGVyZSBhcmUgbm9uemVyb3MgaW4geSB0byB0aGUgbGVmdCBvZiB0aGUgZmlyc3QgY29sdW1uIG9mIHgsIHRoZW4geCBpcyBub3QgYmlnZ2VyXG4gIGZvciAoaT1rLTE7IGk+PXNoaWZ0OyBpLS0pXG4gICAgaWYgICAgICAoeFtpLXNoaWZ0XT55W2ldKSByZXR1cm4gMTtcbiAgICBlbHNlIGlmICh4W2ktc2hpZnRdPHlbaV0pIHJldHVybiAwO1xuICByZXR1cm4gMDtcbn1cblxuLy9pcyB4ID4geT8gKHggYW5kIHkgYm90aCBub25uZWdhdGl2ZSlcbmZ1bmN0aW9uIGdyZWF0ZXIoeCx5KSB7XG4gIHZhciBpO1xuICB2YXIgaz0oeC5sZW5ndGg8eS5sZW5ndGgpID8geC5sZW5ndGggOiB5Lmxlbmd0aDtcblxuICBmb3IgKGk9eC5sZW5ndGg7aTx5Lmxlbmd0aDtpKyspXG4gICAgaWYgKHlbaV0pXG4gICAgICByZXR1cm4gMDsgIC8veSBoYXMgbW9yZSBkaWdpdHNcblxuICBmb3IgKGk9eS5sZW5ndGg7aTx4Lmxlbmd0aDtpKyspXG4gICAgaWYgKHhbaV0pXG4gICAgICByZXR1cm4gMTsgIC8veCBoYXMgbW9yZSBkaWdpdHNcblxuICBmb3IgKGk9ay0xO2k+PTA7aS0tKVxuICAgIGlmICh4W2ldPnlbaV0pXG4gICAgICByZXR1cm4gMTtcbiAgICBlbHNlIGlmICh4W2ldPHlbaV0pXG4gICAgICByZXR1cm4gMDtcbiAgcmV0dXJuIDA7XG59XG5cbi8vZGl2aWRlIHggYnkgeSBnaXZpbmcgcXVvdGllbnQgcSBhbmQgcmVtYWluZGVyIHIuICAocT1mbG9vcih4L3kpLCAgcj14IG1vZCB5KS4gIEFsbCA0IGFyZSBiaWdpbnRzLlxuLy94IG11c3QgaGF2ZSBhdCBsZWFzdCBvbmUgbGVhZGluZyB6ZXJvIGVsZW1lbnQuXG4vL3kgbXVzdCBiZSBub256ZXJvLlxuLy9xIGFuZCByIG11c3QgYmUgYXJyYXlzIHRoYXQgYXJlIGV4YWN0bHkgdGhlIHNhbWUgbGVuZ3RoIGFzIHguIChPciBxIGNhbiBoYXZlIG1vcmUpLlxuLy9NdXN0IGhhdmUgeC5sZW5ndGggPj0geS5sZW5ndGggPj0gMi5cbmZ1bmN0aW9uIGRpdmlkZV8oeCx5LHEscikge1xuICB2YXIga3gsIGt5O1xuICB2YXIgaSxqLHkxLHkyLGMsYSxiO1xuICBjb3B5XyhyLHgpO1xuICBmb3IgKGt5PXkubGVuZ3RoO3lba3ktMV09PTA7a3ktLSk7IC8va3kgaXMgbnVtYmVyIG9mIGVsZW1lbnRzIGluIHksIG5vdCBpbmNsdWRpbmcgbGVhZGluZyB6ZXJvc1xuXG4gIC8vbm9ybWFsaXplOiBlbnN1cmUgdGhlIG1vc3Qgc2lnbmlmaWNhbnQgZWxlbWVudCBvZiB5IGhhcyBpdHMgaGlnaGVzdCBiaXQgc2V0XG4gIGI9eVtreS0xXTtcbiAgZm9yIChhPTA7IGI7IGErKylcbiAgICBiPj49MTtcbiAgYT1icGUtYTsgIC8vYSBpcyBob3cgbWFueSBiaXRzIHRvIHNoaWZ0IHNvIHRoYXQgdGhlIGhpZ2ggb3JkZXIgYml0IG9mIHkgaXMgbGVmdG1vc3QgaW4gaXRzIGFycmF5IGVsZW1lbnRcbiAgbGVmdFNoaWZ0Xyh5LGEpOyAgLy9tdWx0aXBseSBib3RoIGJ5IDE8PGEgbm93LCB0aGVuIGRpdmlkZSBib3RoIGJ5IHRoYXQgYXQgdGhlIGVuZFxuICBsZWZ0U2hpZnRfKHIsYSk7XG5cbiAgLy9Sb2IgVmlzc2VyIGRpc2NvdmVyZWQgYSBidWc6IHRoZSBmb2xsb3dpbmcgbGluZSB3YXMgb3JpZ2luYWxseSBqdXN0IGJlZm9yZSB0aGUgbm9ybWFsaXphdGlvbi5cbiAgZm9yIChreD1yLmxlbmd0aDtyW2t4LTFdPT0wICYmIGt4Pmt5O2t4LS0pOyAvL2t4IGlzIG51bWJlciBvZiBlbGVtZW50cyBpbiBub3JtYWxpemVkIHgsIG5vdCBpbmNsdWRpbmcgbGVhZGluZyB6ZXJvc1xuXG4gIGNvcHlJbnRfKHEsMCk7ICAgICAgICAgICAgICAgICAgICAgIC8vIHE9MFxuICB3aGlsZSAoIWdyZWF0ZXJTaGlmdCh5LHIsa3gta3kpKSB7ICAvLyB3aGlsZSAobGVmdFNoaWZ0Xyh5LGt4LWt5KSA8PSByKSB7XG4gICAgc3ViU2hpZnRfKHIseSxreC1reSk7ICAgICAgICAgICAgIC8vICAgcj1yLWxlZnRTaGlmdF8oeSxreC1reSlcbiAgICBxW2t4LWt5XSsrOyAgICAgICAgICAgICAgICAgICAgICAgLy8gICBxW2t4LWt5XSsrO1xuICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyB9XG5cbiAgZm9yIChpPWt4LTE7IGk+PWt5OyBpLS0pIHtcbiAgICBpZiAocltpXT09eVtreS0xXSlcbiAgICAgIHFbaS1reV09bWFzaztcbiAgICBlbHNlXG4gICAgICBxW2kta3ldPU1hdGguZmxvb3IoKHJbaV0qcmFkaXgrcltpLTFdKS95W2t5LTFdKTtcblxuICAgIC8vVGhlIGZvbGxvd2luZyBmb3IoOzspIGxvb3AgaXMgZXF1aXZhbGVudCB0byB0aGUgY29tbWVudGVkIHdoaWxlIGxvb3AsXG4gICAgLy9leGNlcHQgdGhhdCB0aGUgdW5jb21tZW50ZWQgdmVyc2lvbiBhdm9pZHMgb3ZlcmZsb3cuXG4gICAgLy9UaGUgY29tbWVudGVkIGxvb3AgY29tZXMgZnJvbSBIQUMsIHdoaWNoIGFzc3VtZXMgclstMV09PXlbLTFdPT0wXG4gICAgLy8gIHdoaWxlIChxW2kta3ldKih5W2t5LTFdKnJhZGl4K3lba3ktMl0pID4gcltpXSpyYWRpeCpyYWRpeCtyW2ktMV0qcmFkaXgrcltpLTJdKVxuICAgIC8vICAgIHFbaS1reV0tLTtcbiAgICBmb3IgKDs7KSB7XG4gICAgICB5Mj0oa3k+MSA/IHlba3ktMl0gOiAwKSpxW2kta3ldO1xuICAgICAgYz15Mj4+YnBlO1xuICAgICAgeTI9eTIgJiBtYXNrO1xuICAgICAgeTE9YytxW2kta3ldKnlba3ktMV07XG4gICAgICBjPXkxPj5icGU7XG4gICAgICB5MT15MSAmIG1hc2s7XG5cbiAgICAgIGlmIChjPT1yW2ldID8geTE9PXJbaS0xXSA/IHkyPihpPjEgPyByW2ktMl0gOiAwKSA6IHkxPnJbaS0xXSA6IGM+cltpXSlcbiAgICAgICAgcVtpLWt5XS0tO1xuICAgICAgZWxzZVxuICAgICAgICBicmVhaztcbiAgICB9XG5cbiAgICBsaW5Db21iU2hpZnRfKHIseSwtcVtpLWt5XSxpLWt5KTsgICAgLy9yPXItcVtpLWt5XSpsZWZ0U2hpZnRfKHksaS1reSlcbiAgICBpZiAobmVnYXRpdmUocikpIHtcbiAgICAgIGFkZFNoaWZ0XyhyLHksaS1reSk7ICAgICAgICAgLy9yPXIrbGVmdFNoaWZ0Xyh5LGkta3kpXG4gICAgICBxW2kta3ldLS07XG4gICAgfVxuICB9XG5cbiAgcmlnaHRTaGlmdF8oeSxhKTsgIC8vdW5kbyB0aGUgbm9ybWFsaXphdGlvbiBzdGVwXG4gIHJpZ2h0U2hpZnRfKHIsYSk7ICAvL3VuZG8gdGhlIG5vcm1hbGl6YXRpb24gc3RlcFxufVxuXG4vL2RvIGNhcnJpZXMgYW5kIGJvcnJvd3Mgc28gZWFjaCBlbGVtZW50IG9mIHRoZSBiaWdJbnQgeCBmaXRzIGluIGJwZSBiaXRzLlxuZnVuY3Rpb24gY2FycnlfKHgpIHtcbiAgdmFyIGksayxjLGI7XG4gIGs9eC5sZW5ndGg7XG4gIGM9MDtcbiAgZm9yIChpPTA7aTxrO2krKykge1xuICAgIGMrPXhbaV07XG4gICAgYj0wO1xuICAgIGlmIChjPDApIHtcbiAgICAgIGI9LShjPj5icGUpO1xuICAgICAgYys9YipyYWRpeDtcbiAgICB9XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPShjPj5icGUpLWI7XG4gIH1cbn1cblxuLy9yZXR1cm4geCBtb2QgbiBmb3IgYmlnSW50IHggYW5kIGludGVnZXIgbi5cbmZ1bmN0aW9uIG1vZEludCh4LG4pIHtcbiAgdmFyIGksYz0wO1xuICBmb3IgKGk9eC5sZW5ndGgtMTsgaT49MDsgaS0tKVxuICAgIGM9KGMqcmFkaXgreFtpXSklbjtcbiAgcmV0dXJuIGM7XG59XG5cbi8vY29udmVydCB0aGUgaW50ZWdlciB0IGludG8gYSBiaWdJbnQgd2l0aCBhdCBsZWFzdCB0aGUgZ2l2ZW4gbnVtYmVyIG9mIGJpdHMuXG4vL3RoZSByZXR1cm5lZCBhcnJheSBzdG9yZXMgdGhlIGJpZ0ludCBpbiBicGUtYml0IGNodW5rcywgbGl0dGxlIGVuZGlhbiAoYnVmZlswXSBpcyBsZWFzdCBzaWduaWZpY2FudCB3b3JkKVxuLy9QYWQgdGhlIGFycmF5IHdpdGggbGVhZGluZyB6ZXJvcyBzbyB0aGF0IGl0IGhhcyBhdCBsZWFzdCBtaW5TaXplIGVsZW1lbnRzLlxuLy9UaGVyZSB3aWxsIGFsd2F5cyBiZSBhdCBsZWFzdCBvbmUgbGVhZGluZyAwIGVsZW1lbnQuXG5mdW5jdGlvbiBpbnQyYmlnSW50KHQsYml0cyxtaW5TaXplKSB7XG4gIHZhciBpLGs7XG4gIGs9TWF0aC5jZWlsKGJpdHMvYnBlKSsxO1xuICBrPW1pblNpemU+ayA/IG1pblNpemUgOiBrO1xuICBidWZmPW5ldyBBcnJheShrKTtcbiAgY29weUludF8oYnVmZix0KTtcbiAgcmV0dXJuIGJ1ZmY7XG59XG5cbi8vcmV0dXJuIHRoZSBiaWdJbnQgZ2l2ZW4gYSBzdHJpbmcgcmVwcmVzZW50YXRpb24gaW4gYSBnaXZlbiBiYXNlLlxuLy9QYWQgdGhlIGFycmF5IHdpdGggbGVhZGluZyB6ZXJvcyBzbyB0aGF0IGl0IGhhcyBhdCBsZWFzdCBtaW5TaXplIGVsZW1lbnRzLlxuLy9JZiBiYXNlPS0xLCB0aGVuIGl0IHJlYWRzIGluIGEgc3BhY2Utc2VwYXJhdGVkIGxpc3Qgb2YgYXJyYXkgZWxlbWVudHMgaW4gZGVjaW1hbC5cbi8vVGhlIGFycmF5IHdpbGwgYWx3YXlzIGhhdmUgYXQgbGVhc3Qgb25lIGxlYWRpbmcgemVybywgdW5sZXNzIGJhc2U9LTEuXG5mdW5jdGlvbiBzdHIyYmlnSW50KHMsYixtaW5TaXplKSB7XG4gIHZhciBkLCBpLCBqLCBiYXNlLCBzdHIsIHgsIHksIGtrO1xuICBpZiAodHlwZW9mIGIgPT09ICdzdHJpbmcnKSB7XG5cdCAgYmFzZSA9IGIubGVuZ3RoO1xuXHQgIHN0ciA9IGI7XG4gIH0gZWxzZSB7XG5cdCAgYmFzZSA9IGI7XG5cdCAgc3RyID0gZGlnaXRzU3RyO1xuICB9XG4gIHZhciBrPXMubGVuZ3RoO1xuICBpZiAoYmFzZT09LTEpIHsgLy9jb21tYS1zZXBhcmF0ZWQgbGlzdCBvZiBhcnJheSBlbGVtZW50cyBpbiBkZWNpbWFsXG4gICAgeD1uZXcgQXJyYXkoMCk7XG4gICAgZm9yICg7Oykge1xuICAgICAgeT1uZXcgQXJyYXkoeC5sZW5ndGgrMSk7XG4gICAgICBmb3IgKGk9MDtpPHgubGVuZ3RoO2krKylcbiAgICAgICAgeVtpKzFdPXhbaV07XG4gICAgICB5WzBdPXBhcnNlSW50KHMsMTApO1xuICAgICAgeD15O1xuICAgICAgZD1zLmluZGV4T2YoJywnLDApO1xuICAgICAgaWYgKGQ8MSlcbiAgICAgICAgYnJlYWs7XG4gICAgICBzPXMuc3Vic3RyaW5nKGQrMSk7XG4gICAgICBpZiAocy5sZW5ndGg9PTApXG4gICAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBpZiAoeC5sZW5ndGg8bWluU2l6ZSkge1xuICAgICAgeT1uZXcgQXJyYXkobWluU2l6ZSk7XG4gICAgICBjb3B5Xyh5LHgpO1xuICAgICAgcmV0dXJuIHk7XG4gICAgfVxuICAgIHJldHVybiB4O1xuICB9XG5cbiAgeD1pbnQyYmlnSW50KDAsYmFzZSprLDApO1xuICBmb3IgKGk9MDtpPGs7aSsrKSB7XG4gICAgZD1zdHIuaW5kZXhPZihzLnN1YnN0cmluZyhpLGkrMSksMCk7XG4vLyAgICBpZiAoYmFzZTw9MzYgJiYgZD49MzYpICAvL2NvbnZlcnQgbG93ZXJjYXNlIHRvIHVwcGVyY2FzZSBpZiBiYXNlPD0zNlxuLy8gICAgICBkLT0yNjtcbiAgICBpZiAoZD49YmFzZSB8fCBkPDApIHsgICAvL2lnbm9yZSBpbGxlZ2FsIGNoYXJhY3RlcnNcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBtdWx0SW50Xyh4LGJhc2UpO1xuICAgIGFkZEludF8oeCxkKTtcbiAgfVxuXG4gIGZvciAoaz14Lmxlbmd0aDtrPjAgJiYgIXhbay0xXTtrLS0pOyAvL3N0cmlwIG9mZiBsZWFkaW5nIHplcm9zXG4gIGs9bWluU2l6ZT5rKzEgPyBtaW5TaXplIDogaysxO1xuICB5PW5ldyBBcnJheShrKTtcbiAga2s9azx4Lmxlbmd0aCA/IGsgOiB4Lmxlbmd0aDtcbiAgZm9yIChpPTA7aTxraztpKyspXG4gICAgeVtpXT14W2ldO1xuICBmb3IgKDtpPGs7aSsrKVxuICAgIHlbaV09MDtcbiAgcmV0dXJuIHk7XG59XG5cbi8vaXMgYmlnaW50IHggZXF1YWwgdG8gaW50ZWdlciB5P1xuLy95IG11c3QgaGF2ZSBsZXNzIHRoYW4gYnBlIGJpdHNcbmZ1bmN0aW9uIGVxdWFsc0ludCh4LHkpIHtcbiAgdmFyIGk7XG4gIGlmICh4WzBdIT15KVxuICAgIHJldHVybiAwO1xuICBmb3IgKGk9MTtpPHgubGVuZ3RoO2krKylcbiAgICBpZiAoeFtpXSlcbiAgICAgIHJldHVybiAwO1xuICByZXR1cm4gMTtcbn1cblxuLy9hcmUgYmlnaW50cyB4IGFuZCB5IGVxdWFsP1xuLy90aGlzIHdvcmtzIGV2ZW4gaWYgeCBhbmQgeSBhcmUgZGlmZmVyZW50IGxlbmd0aHMgYW5kIGhhdmUgYXJiaXRyYXJpbHkgbWFueSBsZWFkaW5nIHplcm9zXG5mdW5jdGlvbiBlcXVhbHMoeCx5KSB7XG4gIHZhciBpO1xuICB2YXIgaz14Lmxlbmd0aDx5Lmxlbmd0aCA/IHgubGVuZ3RoIDogeS5sZW5ndGg7XG4gIGZvciAoaT0wO2k8aztpKyspXG4gICAgaWYgKHhbaV0hPXlbaV0pXG4gICAgICByZXR1cm4gMDtcbiAgaWYgKHgubGVuZ3RoPnkubGVuZ3RoKSB7XG4gICAgZm9yICg7aTx4Lmxlbmd0aDtpKyspXG4gICAgICBpZiAoeFtpXSlcbiAgICAgICAgcmV0dXJuIDA7XG4gIH0gZWxzZSB7XG4gICAgZm9yICg7aTx5Lmxlbmd0aDtpKyspXG4gICAgICBpZiAoeVtpXSlcbiAgICAgICAgcmV0dXJuIDA7XG4gIH1cbiAgcmV0dXJuIDE7XG59XG5cbi8vaXMgdGhlIGJpZ0ludCB4IGVxdWFsIHRvIHplcm8/XG5mdW5jdGlvbiBpc1plcm8oeCkge1xuICB2YXIgaTtcbiAgZm9yIChpPTA7aTx4Lmxlbmd0aDtpKyspXG4gICAgaWYgKHhbaV0pXG4gICAgICByZXR1cm4gMDtcbiAgcmV0dXJuIDE7XG59XG5cbi8vY29udmVydCBhIGJpZ0ludCBpbnRvIGEgc3RyaW5nIGluIGEgZ2l2ZW4gYmFzZSwgZnJvbSBiYXNlIDIgdXAgdG8gYmFzZSA5NS5cbi8vQmFzZSAtMSBwcmludHMgdGhlIGNvbnRlbnRzIG9mIHRoZSBhcnJheSByZXByZXNlbnRpbmcgdGhlIG51bWJlci5cbmZ1bmN0aW9uIGJpZ0ludDJzdHIoeCxiKSB7XG4gIHZhciBpLHQsYmFzZSxzdHIscz1cIlwiO1xuICBpZiAodHlwZW9mIGIgPT09ICdzdHJpbmcnKSB7XG5cdCAgYmFzZSA9IGIubGVuZ3RoO1xuXHQgIHN0ciA9IGI7XG4gIH0gZWxzZSB7XG5cdCAgYmFzZSA9IGI7XG5cdCAgc3RyID0gZGlnaXRzU3RyO1xuICB9XG5cbiAgaWYgKHM2Lmxlbmd0aCE9eC5sZW5ndGgpXG4gICAgczY9ZHVwKHgpO1xuICBlbHNlXG4gICAgY29weV8oczYseCk7XG5cbiAgaWYgKGJhc2U9PS0xKSB7IC8vcmV0dXJuIHRoZSBsaXN0IG9mIGFycmF5IGNvbnRlbnRzXG4gICAgZm9yIChpPXgubGVuZ3RoLTE7aT4wO2ktLSlcbiAgICAgIHMrPXhbaV0rJywnO1xuICAgIHMrPXhbMF07XG4gIH1cbiAgZWxzZSB7IC8vcmV0dXJuIGl0IGluIHRoZSBnaXZlbiBiYXNlXG4gICAgd2hpbGUgKCFpc1plcm8oczYpKSB7XG4gICAgICB0PWRpdkludF8oczYsYmFzZSk7ICAvL3Q9czYgJSBiYXNlOyBzNj1mbG9vcihzNi9iYXNlKTtcbiAgICAgIHM9c3RyLnN1YnN0cmluZyh0LHQrMSkrcztcbiAgICB9XG4gIH1cbiAgaWYgKHMubGVuZ3RoPT0wKVxuICAgIHM9c3RyWzBdO1xuICByZXR1cm4gcztcbn1cblxuLy9yZXR1cm5zIGEgZHVwbGljYXRlIG9mIGJpZ0ludCB4XG5mdW5jdGlvbiBkdXAoeCkge1xuICB2YXIgaTtcbiAgYnVmZj1uZXcgQXJyYXkoeC5sZW5ndGgpO1xuICBjb3B5XyhidWZmLHgpO1xuICByZXR1cm4gYnVmZjtcbn1cblxuLy9kbyB4PXkgb24gYmlnSW50cyB4IGFuZCB5LiAgeCBtdXN0IGJlIGFuIGFycmF5IGF0IGxlYXN0IGFzIGJpZyBhcyB5IChub3QgY291bnRpbmcgdGhlIGxlYWRpbmcgemVyb3MgaW4geSkuXG5mdW5jdGlvbiBjb3B5Xyh4LHkpIHtcbiAgdmFyIGk7XG4gIHZhciBrPXgubGVuZ3RoPHkubGVuZ3RoID8geC5sZW5ndGggOiB5Lmxlbmd0aDtcbiAgZm9yIChpPTA7aTxrO2krKylcbiAgICB4W2ldPXlbaV07XG4gIGZvciAoaT1rO2k8eC5sZW5ndGg7aSsrKVxuICAgIHhbaV09MDtcbn1cblxuLy9kbyB4PXkgb24gYmlnSW50IHggYW5kIGludGVnZXIgeS5cbmZ1bmN0aW9uIGNvcHlJbnRfKHgsbikge1xuICB2YXIgaSxjO1xuICBmb3IgKGM9bixpPTA7aTx4Lmxlbmd0aDtpKyspIHtcbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM+Pj1icGU7XG4gIH1cbn1cblxuLy9kbyB4PXgrbiB3aGVyZSB4IGlzIGEgYmlnSW50IGFuZCBuIGlzIGFuIGludGVnZXIuXG4vL3ggbXVzdCBiZSBsYXJnZSBlbm91Z2ggdG8gaG9sZCB0aGUgcmVzdWx0LlxuZnVuY3Rpb24gYWRkSW50Xyh4LG4pIHtcbiAgdmFyIGksayxjLGI7XG4gIHhbMF0rPW47XG4gIGs9eC5sZW5ndGg7XG4gIGM9MDtcbiAgZm9yIChpPTA7aTxrO2krKykge1xuICAgIGMrPXhbaV07XG4gICAgYj0wO1xuICAgIGlmIChjPDApIHtcbiAgICAgIGI9LShjPj5icGUpO1xuICAgICAgYys9YipyYWRpeDtcbiAgICB9XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPShjPj5icGUpLWI7XG4gICAgaWYgKCFjKSByZXR1cm47IC8vc3RvcCBjYXJyeWluZyBhcyBzb29uIGFzIHRoZSBjYXJyeSBpcyB6ZXJvXG4gIH1cbn1cblxuLy9yaWdodCBzaGlmdCBiaWdJbnQgeCBieSBuIGJpdHMuICAwIDw9IG4gPCBicGUuXG5mdW5jdGlvbiByaWdodFNoaWZ0Xyh4LG4pIHtcbiAgdmFyIGk7XG4gIHZhciBrPU1hdGguZmxvb3Iobi9icGUpO1xuICBpZiAoaykge1xuICAgIGZvciAoaT0wO2k8eC5sZW5ndGgtaztpKyspIC8vcmlnaHQgc2hpZnQgeCBieSBrIGVsZW1lbnRzXG4gICAgICB4W2ldPXhbaStrXTtcbiAgICBmb3IgKDtpPHgubGVuZ3RoO2krKylcbiAgICAgIHhbaV09MDtcbiAgICBuJT1icGU7XG4gIH1cbiAgZm9yIChpPTA7aTx4Lmxlbmd0aC0xO2krKykge1xuICAgIHhbaV09bWFzayAmICgoeFtpKzFdPDwoYnBlLW4pKSB8ICh4W2ldPj5uKSk7XG4gIH1cbiAgeFtpXT4+PW47XG59XG5cbi8vZG8geD1mbG9vcih8eHwvMikqc2duKHgpIGZvciBiaWdJbnQgeCBpbiAyJ3MgY29tcGxlbWVudFxuZnVuY3Rpb24gaGFsdmVfKHgpIHtcbiAgdmFyIGk7XG4gIGZvciAoaT0wO2k8eC5sZW5ndGgtMTtpKyspIHtcbiAgICB4W2ldPW1hc2sgJiAoKHhbaSsxXTw8KGJwZS0xKSkgfCAoeFtpXT4+MSkpO1xuICB9XG4gIHhbaV09KHhbaV0+PjEpIHwgKHhbaV0gJiAocmFkaXg+PjEpKTsgIC8vbW9zdCBzaWduaWZpY2FudCBiaXQgc3RheXMgdGhlIHNhbWVcbn1cblxuLy9sZWZ0IHNoaWZ0IGJpZ0ludCB4IGJ5IG4gYml0cy5cbmZ1bmN0aW9uIGxlZnRTaGlmdF8oeCxuKSB7XG4gIHZhciBpO1xuICB2YXIgaz1NYXRoLmZsb29yKG4vYnBlKTtcbiAgaWYgKGspIHtcbiAgICBmb3IgKGk9eC5sZW5ndGg7IGk+PWs7IGktLSkgLy9sZWZ0IHNoaWZ0IHggYnkgayBlbGVtZW50c1xuICAgICAgeFtpXT14W2kta107XG4gICAgZm9yICg7aT49MDtpLS0pXG4gICAgICB4W2ldPTA7XG4gICAgbiU9YnBlO1xuICB9XG4gIGlmICghbilcbiAgICByZXR1cm47XG4gIGZvciAoaT14Lmxlbmd0aC0xO2k+MDtpLS0pIHtcbiAgICB4W2ldPW1hc2sgJiAoKHhbaV08PG4pIHwgKHhbaS0xXT4+KGJwZS1uKSkpO1xuICB9XG4gIHhbaV09bWFzayAmICh4W2ldPDxuKTtcbn1cblxuLy9kbyB4PXgqbiB3aGVyZSB4IGlzIGEgYmlnSW50IGFuZCBuIGlzIGFuIGludGVnZXIuXG4vL3ggbXVzdCBiZSBsYXJnZSBlbm91Z2ggdG8gaG9sZCB0aGUgcmVzdWx0LlxuZnVuY3Rpb24gbXVsdEludF8oeCxuKSB7XG4gIHZhciBpLGssYyxiO1xuICBpZiAoIW4pXG4gICAgcmV0dXJuO1xuICBrPXgubGVuZ3RoO1xuICBjPTA7XG4gIGZvciAoaT0wO2k8aztpKyspIHtcbiAgICBjKz14W2ldKm47XG4gICAgYj0wO1xuICAgIGlmIChjPDApIHtcbiAgICAgIGI9LShjPj5icGUpO1xuICAgICAgYys9YipyYWRpeDtcbiAgICB9XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPShjPj5icGUpLWI7XG4gIH1cbn1cblxuLy9kbyB4PWZsb29yKHgvbikgZm9yIGJpZ0ludCB4IGFuZCBpbnRlZ2VyIG4sIGFuZCByZXR1cm4gdGhlIHJlbWFpbmRlclxuZnVuY3Rpb24gZGl2SW50Xyh4LG4pIHtcbiAgdmFyIGkscj0wLHM7XG4gIGZvciAoaT14Lmxlbmd0aC0xO2k+PTA7aS0tKSB7XG4gICAgcz1yKnJhZGl4K3hbaV07XG4gICAgeFtpXT1NYXRoLmZsb29yKHMvbik7XG4gICAgcj1zJW47XG4gIH1cbiAgcmV0dXJuIHI7XG59XG5cbi8vZG8gdGhlIGxpbmVhciBjb21iaW5hdGlvbiB4PWEqeCtiKnkgZm9yIGJpZ0ludHMgeCBhbmQgeSwgYW5kIGludGVnZXJzIGEgYW5kIGIuXG4vL3ggbXVzdCBiZSBsYXJnZSBlbm91Z2ggdG8gaG9sZCB0aGUgYW5zd2VyLlxuZnVuY3Rpb24gbGluQ29tYl8oeCx5LGEsYikge1xuICB2YXIgaSxjLGssa2s7XG4gIGs9eC5sZW5ndGg8eS5sZW5ndGggPyB4Lmxlbmd0aCA6IHkubGVuZ3RoO1xuICBraz14Lmxlbmd0aDtcbiAgZm9yIChjPTAsaT0wO2k8aztpKyspIHtcbiAgICBjKz1hKnhbaV0rYip5W2ldO1xuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz4+PWJwZTtcbiAgfVxuICBmb3IgKGk9aztpPGtrO2krKykge1xuICAgIGMrPWEqeFtpXTtcbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM+Pj1icGU7XG4gIH1cbn1cblxuLy9kbyB0aGUgbGluZWFyIGNvbWJpbmF0aW9uIHg9YSp4K2IqKHk8PCh5cypicGUpKSBmb3IgYmlnSW50cyB4IGFuZCB5LCBhbmQgaW50ZWdlcnMgYSwgYiBhbmQgeXMuXG4vL3ggbXVzdCBiZSBsYXJnZSBlbm91Z2ggdG8gaG9sZCB0aGUgYW5zd2VyLlxuZnVuY3Rpb24gbGluQ29tYlNoaWZ0Xyh4LHksYix5cykge1xuICB2YXIgaSxjLGssa2s7XG4gIGs9eC5sZW5ndGg8eXMreS5sZW5ndGggPyB4Lmxlbmd0aCA6IHlzK3kubGVuZ3RoO1xuICBraz14Lmxlbmd0aDtcbiAgZm9yIChjPTAsaT15cztpPGs7aSsrKSB7XG4gICAgYys9eFtpXStiKnlbaS15c107XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPj49YnBlO1xuICB9XG4gIGZvciAoaT1rO2MgJiYgaTxraztpKyspIHtcbiAgICBjKz14W2ldO1xuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz4+PWJwZTtcbiAgfVxufVxuXG4vL2RvIHg9eCsoeTw8KHlzKmJwZSkpIGZvciBiaWdJbnRzIHggYW5kIHksIGFuZCBpbnRlZ2VycyBhLGIgYW5kIHlzLlxuLy94IG11c3QgYmUgbGFyZ2UgZW5vdWdoIHRvIGhvbGQgdGhlIGFuc3dlci5cbmZ1bmN0aW9uIGFkZFNoaWZ0Xyh4LHkseXMpIHtcbiAgdmFyIGksYyxrLGtrO1xuICBrPXgubGVuZ3RoPHlzK3kubGVuZ3RoID8geC5sZW5ndGggOiB5cyt5Lmxlbmd0aDtcbiAga2s9eC5sZW5ndGg7XG4gIGZvciAoYz0wLGk9eXM7aTxrO2krKykge1xuICAgIGMrPXhbaV0reVtpLXlzXTtcbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM+Pj1icGU7XG4gIH1cbiAgZm9yIChpPWs7YyAmJiBpPGtrO2krKykge1xuICAgIGMrPXhbaV07XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPj49YnBlO1xuICB9XG59XG5cbi8vZG8geD14LSh5PDwoeXMqYnBlKSkgZm9yIGJpZ0ludHMgeCBhbmQgeSwgYW5kIGludGVnZXJzIGEsYiBhbmQgeXMuXG4vL3ggbXVzdCBiZSBsYXJnZSBlbm91Z2ggdG8gaG9sZCB0aGUgYW5zd2VyLlxuZnVuY3Rpb24gc3ViU2hpZnRfKHgseSx5cykge1xuICB2YXIgaSxjLGssa2s7XG4gIGs9eC5sZW5ndGg8eXMreS5sZW5ndGggPyB4Lmxlbmd0aCA6IHlzK3kubGVuZ3RoO1xuICBraz14Lmxlbmd0aDtcbiAgZm9yIChjPTAsaT15cztpPGs7aSsrKSB7XG4gICAgYys9eFtpXS15W2kteXNdO1xuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz4+PWJwZTtcbiAgfVxuICBmb3IgKGk9aztjICYmIGk8a2s7aSsrKSB7XG4gICAgYys9eFtpXTtcbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM+Pj1icGU7XG4gIH1cbn1cblxuLy9kbyB4PXgteSBmb3IgYmlnSW50cyB4IGFuZCB5LlxuLy94IG11c3QgYmUgbGFyZ2UgZW5vdWdoIHRvIGhvbGQgdGhlIGFuc3dlci5cbi8vbmVnYXRpdmUgYW5zd2VycyB3aWxsIGJlIDJzIGNvbXBsZW1lbnRcbmZ1bmN0aW9uIHN1Yl8oeCx5KSB7XG4gIHZhciBpLGMsayxraztcbiAgaz14Lmxlbmd0aDx5Lmxlbmd0aCA/IHgubGVuZ3RoIDogeS5sZW5ndGg7XG4gIGZvciAoYz0wLGk9MDtpPGs7aSsrKSB7XG4gICAgYys9eFtpXS15W2ldO1xuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz4+PWJwZTtcbiAgfVxuICBmb3IgKGk9aztjICYmIGk8eC5sZW5ndGg7aSsrKSB7XG4gICAgYys9eFtpXTtcbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM+Pj1icGU7XG4gIH1cbn1cblxuLy9kbyB4PXgreSBmb3IgYmlnSW50cyB4IGFuZCB5LlxuLy94IG11c3QgYmUgbGFyZ2UgZW5vdWdoIHRvIGhvbGQgdGhlIGFuc3dlci5cbmZ1bmN0aW9uIGFkZF8oeCx5KSB7XG4gIHZhciBpLGMsayxraztcbiAgaz14Lmxlbmd0aDx5Lmxlbmd0aCA/IHgubGVuZ3RoIDogeS5sZW5ndGg7XG4gIGZvciAoYz0wLGk9MDtpPGs7aSsrKSB7XG4gICAgYys9eFtpXSt5W2ldO1xuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz4+PWJwZTtcbiAgfVxuICBmb3IgKGk9aztjICYmIGk8eC5sZW5ndGg7aSsrKSB7XG4gICAgYys9eFtpXTtcbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM+Pj1icGU7XG4gIH1cbn1cblxuLy9kbyB4PXgqeSBmb3IgYmlnSW50cyB4IGFuZCB5LiAgVGhpcyBpcyBmYXN0ZXIgd2hlbiB5PHguXG5mdW5jdGlvbiBtdWx0Xyh4LHkpIHtcbiAgdmFyIGk7XG4gIGlmIChzcy5sZW5ndGghPTIqeC5sZW5ndGgpXG4gICAgc3M9bmV3IEFycmF5KDIqeC5sZW5ndGgpO1xuICBjb3B5SW50XyhzcywwKTtcbiAgZm9yIChpPTA7aTx5Lmxlbmd0aDtpKyspXG4gICAgaWYgKHlbaV0pXG4gICAgICBsaW5Db21iU2hpZnRfKHNzLHgseVtpXSxpKTsgICAvL3NzPTEqc3MreVtpXSooeDw8KGkqYnBlKSlcbiAgY29weV8oeCxzcyk7XG59XG5cbi8vZG8geD14IG1vZCBuIGZvciBiaWdJbnRzIHggYW5kIG4uXG5mdW5jdGlvbiBtb2RfKHgsbikge1xuICBpZiAoczQubGVuZ3RoIT14Lmxlbmd0aClcbiAgICBzND1kdXAoeCk7XG4gIGVsc2VcbiAgICBjb3B5XyhzNCx4KTtcbiAgaWYgKHM1Lmxlbmd0aCE9eC5sZW5ndGgpXG4gICAgczU9ZHVwKHgpO1xuICBkaXZpZGVfKHM0LG4sczUseCk7ICAvL3ggPSByZW1haW5kZXIgb2YgczQgLyBuXG59XG5cbi8vZG8geD14KnkgbW9kIG4gZm9yIGJpZ0ludHMgeCx5LG4uXG4vL2ZvciBncmVhdGVyIHNwZWVkLCBsZXQgeTx4LlxuZnVuY3Rpb24gbXVsdE1vZF8oeCx5LG4pIHtcbiAgdmFyIGk7XG4gIGlmIChzMC5sZW5ndGghPTIqeC5sZW5ndGgpXG4gICAgczA9bmV3IEFycmF5KDIqeC5sZW5ndGgpO1xuICBjb3B5SW50XyhzMCwwKTtcbiAgZm9yIChpPTA7aTx5Lmxlbmd0aDtpKyspXG4gICAgaWYgKHlbaV0pXG4gICAgICBsaW5Db21iU2hpZnRfKHMwLHgseVtpXSxpKTsgICAvL3MwPTEqczAreVtpXSooeDw8KGkqYnBlKSlcbiAgbW9kXyhzMCxuKTtcbiAgY29weV8oeCxzMCk7XG59XG5cbi8vZG8geD14KnggbW9kIG4gZm9yIGJpZ0ludHMgeCxuLlxuZnVuY3Rpb24gc3F1YXJlTW9kXyh4LG4pIHtcbiAgdmFyIGksaixkLGMsa3gsa24saztcbiAgZm9yIChreD14Lmxlbmd0aDsga3g+MCAmJiAheFtreC0xXTsga3gtLSk7ICAvL2lnbm9yZSBsZWFkaW5nIHplcm9zIGluIHhcbiAgaz1reD5uLmxlbmd0aCA/IDIqa3ggOiAyKm4ubGVuZ3RoOyAvL2s9IyBlbGVtZW50cyBpbiB0aGUgcHJvZHVjdCwgd2hpY2ggaXMgdHdpY2UgdGhlIGVsZW1lbnRzIGluIHRoZSBsYXJnZXIgb2YgeCBhbmQgblxuICBpZiAoczAubGVuZ3RoIT1rKVxuICAgIHMwPW5ldyBBcnJheShrKTtcbiAgY29weUludF8oczAsMCk7XG4gIGZvciAoaT0wO2k8a3g7aSsrKSB7XG4gICAgYz1zMFsyKmldK3hbaV0qeFtpXTtcbiAgICBzMFsyKmldPWMgJiBtYXNrO1xuICAgIGM+Pj1icGU7XG4gICAgZm9yIChqPWkrMTtqPGt4O2orKykge1xuICAgICAgYz1zMFtpK2pdKzIqeFtpXSp4W2pdK2M7XG4gICAgICBzMFtpK2pdPShjICYgbWFzayk7XG4gICAgICBjPj49YnBlO1xuICAgIH1cbiAgICBzMFtpK2t4XT1jO1xuICB9XG4gIG1vZF8oczAsbik7XG4gIGNvcHlfKHgsczApO1xufVxuXG4vL3JldHVybiB4IHdpdGggZXhhY3RseSBrIGxlYWRpbmcgemVybyBlbGVtZW50c1xuZnVuY3Rpb24gdHJpbSh4LGspIHtcbiAgdmFyIGkseTtcbiAgZm9yIChpPXgubGVuZ3RoOyBpPjAgJiYgIXhbaS0xXTsgaS0tKTtcbiAgeT1uZXcgQXJyYXkoaStrKTtcbiAgY29weV8oeSx4KTtcbiAgcmV0dXJuIHk7XG59XG5cbi8vZG8geD14Kip5IG1vZCBuLCB3aGVyZSB4LHksbiBhcmUgYmlnSW50cyBhbmQgKiogaXMgZXhwb25lbnRpYXRpb24uICAwKiowPTEuXG4vL3RoaXMgaXMgZmFzdGVyIHdoZW4gbiBpcyBvZGQuICB4IHVzdWFsbHkgbmVlZHMgdG8gaGF2ZSBhcyBtYW55IGVsZW1lbnRzIGFzIG4uXG5mdW5jdGlvbiBwb3dNb2RfKHgseSxuKSB7XG4gIHZhciBrMSxrMixrbixucDtcbiAgaWYoczcubGVuZ3RoIT1uLmxlbmd0aClcbiAgICBzNz1kdXAobik7XG5cbiAgLy9mb3IgZXZlbiBtb2R1bHVzLCB1c2UgYSBzaW1wbGUgc3F1YXJlLWFuZC1tdWx0aXBseSBhbGdvcml0aG0sXG4gIC8vcmF0aGVyIHRoYW4gdXNpbmcgdGhlIG1vcmUgY29tcGxleCBNb250Z29tZXJ5IGFsZ29yaXRobS5cbiAgaWYgKChuWzBdJjEpPT0wKSB7XG4gICAgY29weV8oczcseCk7XG4gICAgY29weUludF8oeCwxKTtcbiAgICB3aGlsZSghZXF1YWxzSW50KHksMCkpIHtcbiAgICAgIGlmICh5WzBdJjEpXG4gICAgICAgIG11bHRNb2RfKHgsczcsbik7XG4gICAgICBkaXZJbnRfKHksMik7XG4gICAgICBzcXVhcmVNb2RfKHM3LG4pO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICAvL2NhbGN1bGF0ZSBucCBmcm9tIG4gZm9yIHRoZSBNb250Z29tZXJ5IG11bHRpcGxpY2F0aW9uc1xuICBjb3B5SW50XyhzNywwKTtcbiAgZm9yIChrbj1uLmxlbmd0aDtrbj4wICYmICFuW2tuLTFdO2tuLS0pO1xuICBucD1yYWRpeC1pbnZlcnNlTW9kSW50KG1vZEludChuLHJhZGl4KSxyYWRpeCk7XG4gIHM3W2tuXT0xO1xuICBtdWx0TW9kXyh4ICxzNyxuKTsgICAvLyB4ID0geCAqIDIqKihrbipicCkgbW9kIG5cblxuICBpZiAoczMubGVuZ3RoIT14Lmxlbmd0aClcbiAgICBzMz1kdXAoeCk7XG4gIGVsc2VcbiAgICBjb3B5XyhzMyx4KTtcblxuICBmb3IgKGsxPXkubGVuZ3RoLTE7azE+MCAmICF5W2sxXTsgazEtLSk7ICAvL2sxPWZpcnN0IG5vbnplcm8gZWxlbWVudCBvZiB5XG4gIGlmICh5W2sxXT09MCkgeyAgLy9hbnl0aGluZyB0byB0aGUgMHRoIHBvd2VyIGlzIDFcbiAgICBjb3B5SW50Xyh4LDEpO1xuICAgIHJldHVybjtcbiAgfVxuICBmb3IgKGsyPTE8PChicGUtMSk7azIgJiYgISh5W2sxXSAmIGsyKTsgazI+Pj0xKTsgIC8vazI9cG9zaXRpb24gb2YgZmlyc3QgMSBiaXQgaW4geVtrMV1cbiAgZm9yICg7Oykge1xuICAgIGlmICghKGsyPj49MSkpIHsgIC8vbG9vayBhdCBuZXh0IGJpdCBvZiB5XG4gICAgICBrMS0tO1xuICAgICAgaWYgKGsxPDApIHtcbiAgICAgICAgbW9udF8oeCxvbmUsbixucCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGsyPTE8PChicGUtMSk7XG4gICAgfVxuICAgIG1vbnRfKHgseCxuLG5wKTtcblxuICAgIGlmIChrMiAmIHlbazFdKSAvL2lmIG5leHQgYml0IGlzIGEgMVxuICAgICAgbW9udF8oeCxzMyxuLG5wKTtcbiAgfVxufVxuXG5cbi8vZG8geD14KnkqUmkgbW9kIG4gZm9yIGJpZ0ludHMgeCx5LG4sXG4vLyAgd2hlcmUgUmkgPSAyKiooLWtuKmJwZSkgbW9kIG4sIGFuZCBrbiBpcyB0aGVcbi8vICBudW1iZXIgb2YgZWxlbWVudHMgaW4gdGhlIG4gYXJyYXksIG5vdFxuLy8gIGNvdW50aW5nIGxlYWRpbmcgemVyb3MuXG4vL3ggYXJyYXkgbXVzdCBoYXZlIGF0IGxlYXN0IGFzIG1hbnkgZWxlbW50cyBhcyB0aGUgbiBhcnJheVxuLy9JdCdzIE9LIGlmIHggYW5kIHkgYXJlIHRoZSBzYW1lIHZhcmlhYmxlLlxuLy9tdXN0IGhhdmU6XG4vLyAgeCx5IDwgblxuLy8gIG4gaXMgb2RkXG4vLyAgbnAgPSAtKG5eKC0xKSkgbW9kIHJhZGl4XG5mdW5jdGlvbiBtb250Xyh4LHksbixucCkge1xuICB2YXIgaSxqLGMsdWksdCxrcztcbiAgdmFyIGtuPW4ubGVuZ3RoO1xuICB2YXIga3k9eS5sZW5ndGg7XG5cbiAgaWYgKHNhLmxlbmd0aCE9a24pXG4gICAgc2E9bmV3IEFycmF5KGtuKTtcblxuICBjb3B5SW50XyhzYSwwKTtcblxuICBmb3IgKDtrbj4wICYmIG5ba24tMV09PTA7a24tLSk7IC8vaWdub3JlIGxlYWRpbmcgemVyb3Mgb2YgblxuICBmb3IgKDtreT4wICYmIHlba3ktMV09PTA7a3ktLSk7IC8vaWdub3JlIGxlYWRpbmcgemVyb3Mgb2YgeVxuICBrcz1zYS5sZW5ndGgtMTsgLy9zYSB3aWxsIG5ldmVyIGhhdmUgbW9yZSB0aGFuIHRoaXMgbWFueSBub256ZXJvIGVsZW1lbnRzLlxuXG4gIC8vdGhlIGZvbGxvd2luZyBsb29wIGNvbnN1bWVzIDk1JSBvZiB0aGUgcnVudGltZSBmb3IgcmFuZFRydWVQcmltZV8oKSBhbmQgcG93TW9kXygpIGZvciBsYXJnZSBudW1iZXJzXG4gIGZvciAoaT0wOyBpPGtuOyBpKyspIHtcbiAgICB0PXNhWzBdK3hbaV0qeVswXTtcbiAgICB1aT0oKHQgJiBtYXNrKSAqIG5wKSAmIG1hc2s7ICAvL3RoZSBpbm5lciBcIiYgbWFza1wiIHdhcyBuZWVkZWQgb24gU2FmYXJpIChidXQgbm90IE1TSUUpIGF0IG9uZSB0aW1lXG4gICAgYz0odCt1aSpuWzBdKSA+PiBicGU7XG4gICAgdD14W2ldO1xuXG4gICAgLy9kbyBzYT0oc2EreFtpXSp5K3VpKm4pL2IgICB3aGVyZSBiPTIqKmJwZS4gIExvb3AgaXMgdW5yb2xsZWQgNS1mb2xkIGZvciBzcGVlZFxuICAgIGo9MTtcbiAgICBmb3IgKDtqPGt5LTQ7KSB7IGMrPXNhW2pdK3VpKm5bal0rdCp5W2pdOyAgIHNhW2otMV09YyAmIG1hc2s7ICAgYz4+PWJwZTsgICBqKys7XG4gICAgICAgICAgICAgICAgICAgICBjKz1zYVtqXSt1aSpuW2pdK3QqeVtqXTsgICBzYVtqLTFdPWMgJiBtYXNrOyAgIGM+Pj1icGU7ICAgaisrO1xuICAgICAgICAgICAgICAgICAgICAgYys9c2Fbal0rdWkqbltqXSt0Knlbal07ICAgc2Fbai0xXT1jICYgbWFzazsgICBjPj49YnBlOyAgIGorKztcbiAgICAgICAgICAgICAgICAgICAgIGMrPXNhW2pdK3VpKm5bal0rdCp5W2pdOyAgIHNhW2otMV09YyAmIG1hc2s7ICAgYz4+PWJwZTsgICBqKys7XG4gICAgICAgICAgICAgICAgICAgICBjKz1zYVtqXSt1aSpuW2pdK3QqeVtqXTsgICBzYVtqLTFdPWMgJiBtYXNrOyAgIGM+Pj1icGU7ICAgaisrOyB9XG4gICAgZm9yICg7ajxreTspICAgeyBjKz1zYVtqXSt1aSpuW2pdK3QqeVtqXTsgICBzYVtqLTFdPWMgJiBtYXNrOyAgIGM+Pj1icGU7ICAgaisrOyB9XG4gICAgZm9yICg7ajxrbi00OykgeyBjKz1zYVtqXSt1aSpuW2pdOyAgICAgICAgICBzYVtqLTFdPWMgJiBtYXNrOyAgIGM+Pj1icGU7ICAgaisrO1xuICAgICAgICAgICAgICAgICAgICAgYys9c2Fbal0rdWkqbltqXTsgICAgICAgICAgc2Fbai0xXT1jICYgbWFzazsgICBjPj49YnBlOyAgIGorKztcbiAgICAgICAgICAgICAgICAgICAgIGMrPXNhW2pdK3VpKm5bal07ICAgICAgICAgIHNhW2otMV09YyAmIG1hc2s7ICAgYz4+PWJwZTsgICBqKys7XG4gICAgICAgICAgICAgICAgICAgICBjKz1zYVtqXSt1aSpuW2pdOyAgICAgICAgICBzYVtqLTFdPWMgJiBtYXNrOyAgIGM+Pj1icGU7ICAgaisrO1xuICAgICAgICAgICAgICAgICAgICAgYys9c2Fbal0rdWkqbltqXTsgICAgICAgICAgc2Fbai0xXT1jICYgbWFzazsgICBjPj49YnBlOyAgIGorKzsgfVxuICAgIGZvciAoO2o8a247KSAgIHsgYys9c2Fbal0rdWkqbltqXTsgICAgICAgICAgc2Fbai0xXT1jICYgbWFzazsgICBjPj49YnBlOyAgIGorKzsgfVxuICAgIGZvciAoO2o8a3M7KSAgIHsgYys9c2Fbal07ICAgICAgICAgICAgICAgICAgc2Fbai0xXT1jICYgbWFzazsgICBjPj49YnBlOyAgIGorKzsgfVxuICAgIHNhW2otMV09YyAmIG1hc2s7XG4gIH1cblxuICBpZiAoIWdyZWF0ZXIobixzYSkpXG4gICAgc3ViXyhzYSxuKTtcbiAgY29weV8oeCxzYSk7XG59XG5cbmlmICh0eXBlb2YgbW9kdWxlID09PSAndW5kZWZpbmVkJykge1xuXHRtb2R1bGUgPSB7fTtcbn1cbkJpZ0ludCA9IG1vZHVsZS5leHBvcnRzID0ge1xuXHQnYWRkJzogYWRkLCAnYWRkSW50JzogYWRkSW50LCAnYmlnSW50MnN0cic6IGJpZ0ludDJzdHIsICdiaXRTaXplJzogYml0U2l6ZSxcblx0J2R1cCc6IGR1cCwgJ2VxdWFscyc6IGVxdWFscywgJ2VxdWFsc0ludCc6IGVxdWFsc0ludCwgJ2V4cGFuZCc6IGV4cGFuZCxcblx0J2ZpbmRQcmltZXMnOiBmaW5kUHJpbWVzLCAnR0NEJzogR0NELCAnZ3JlYXRlcic6IGdyZWF0ZXIsXG5cdCdncmVhdGVyU2hpZnQnOiBncmVhdGVyU2hpZnQsICdpbnQyYmlnSW50JzogaW50MmJpZ0ludCxcblx0J2ludmVyc2VNb2QnOiBpbnZlcnNlTW9kLCAnaW52ZXJzZU1vZEludCc6IGludmVyc2VNb2RJbnQsICdpc1plcm8nOiBpc1plcm8sXG5cdCdtaWxsZXJSYWJpbic6IG1pbGxlclJhYmluLCAnbWlsbGVyUmFiaW5JbnQnOiBtaWxsZXJSYWJpbkludCwgJ21vZCc6IG1vZCxcblx0J21vZEludCc6IG1vZEludCwgJ211bHQnOiBtdWx0LCAnbXVsdE1vZCc6IG11bHRNb2QsICduZWdhdGl2ZSc6IG5lZ2F0aXZlLFxuXHQncG93TW9kJzogcG93TW9kLCAncmFuZEJpZ0ludCc6IHJhbmRCaWdJbnQsICdyYW5kVHJ1ZVByaW1lJzogcmFuZFRydWVQcmltZSxcblx0J3JhbmRQcm9iUHJpbWUnOiByYW5kUHJvYlByaW1lLCAnc3RyMmJpZ0ludCc6IHN0cjJiaWdJbnQsICdzdWInOiBzdWIsXG5cdCd0cmltJzogdHJpbSwgJ2FkZEludF8nOiBhZGRJbnRfLCAnYWRkXyc6IGFkZF8sICdjb3B5Xyc6IGNvcHlfLFxuXHQnY29weUludF8nOiBjb3B5SW50XywgJ0dDRF8nOiBHQ0RfLCAnaW52ZXJzZU1vZF8nOiBpbnZlcnNlTW9kXywgJ21vZF8nOiBtb2RfLFxuXHQnbXVsdF8nOiBtdWx0XywgJ211bHRNb2RfJzogbXVsdE1vZF8sICdwb3dNb2RfJzogcG93TW9kXyxcblx0J3JhbmRCaWdJbnRfJzogcmFuZEJpZ0ludF8sICdyYW5kVHJ1ZVByaW1lXyc6IHJhbmRUcnVlUHJpbWVfLCAnc3ViXyc6IHN1Yl8sXG5cdCdhZGRTaGlmdF8nOiBhZGRTaGlmdF8sICdjYXJyeV8nOiBjYXJyeV8sICdkaXZpZGVfJzogZGl2aWRlXyxcblx0J2RpdkludF8nOiBkaXZJbnRfLCAnZUdDRF8nOiBlR0NEXywgJ2hhbHZlXyc6IGhhbHZlXywgJ2xlZnRTaGlmdF8nOiBsZWZ0U2hpZnRfLFxuXHQnbGluQ29tYl8nOiBsaW5Db21iXywgJ2xpbkNvbWJTaGlmdF8nOiBsaW5Db21iU2hpZnRfLCAnbW9udF8nOiBtb250Xyxcblx0J211bHRJbnRfJzogbXVsdEludF8sICdyaWdodFNoaWZ0Xyc6IHJpZ2h0U2hpZnRfLCAnc3F1YXJlTW9kXyc6IHNxdWFyZU1vZF8sXG5cdCdzdWJTaGlmdF8nOiBzdWJTaGlmdF8sICdwb3dNb2RfJzogcG93TW9kXywgJ2VHQ0RfJzogZUdDRF8sXG5cdCdpbnZlcnNlTW9kXyc6IGludmVyc2VNb2RfLCAnR0NEXyc6IEdDRF8sICdtb250Xyc6IG1vbnRfLCAnZGl2aWRlXyc6IGRpdmlkZV8sXG5cdCdzcXVhcmVNb2RfJzogc3F1YXJlTW9kXywgJ3JhbmRUcnVlUHJpbWVfJzogcmFuZFRydWVQcmltZV8sXG5cdCdtaWxsZXJSYWJpbic6IG1pbGxlclJhYmluXG59O1xuXG59KSgpO1xuIiwiLyohXG4gKiBNSm9pbihpZClcbiAqIE1SZXF1ZXN0VGlja2V0KGlkKVxuICogTU9mZmVyVGlja2V0KGlkLCB0aWNrZXQsIHBlZXIpXG4gKiBNU3RhbXBlZFRpY2tldChpZCwgdGlja2V0LCBwZWVyKVxuICogTUV4Y2hhbmdlKGlkLCBwZWVyKVxuICovXG5cbi8qIVxuICogXFxicmllZiBtZXNzYWdlIHJlcXVlc3RpbmcgdG8gam9pbiB0aGUgbmV0d29ya1xuICogXFxwYXJhbSBpZCB0aGUgaWRlbnRpZmllciBvZiB0aGUgam9pbiBtZXNzYWdlXG4gKi9cbmZ1bmN0aW9uIE1Kb2luKGlkKXtcbiAgICB0aGlzLnByb3RvY29sID0gJ3NwcmF5JztcbiAgICB0aGlzLnR5cGUgPSAnTUpvaW4nO1xuICAgIHRoaXMuaWQgPSBpZDtcbn07XG5tb2R1bGUuZXhwb3J0cy5NSm9pbiA9IE1Kb2luO1xuXG4vKiFcbiAqIFxcYnJpZWYgbWVzc2FnZSByZXF1ZXN0aW5nIGFuIG9mZmVyIHRpY2tldFxuICogXFxwYXJhbSBpZCB0aGUgaWRlbnRpZmllciBvZiB0aGUgcmVxdWVzdCBtZXNzYWdlXG4gKi9cbmZ1bmN0aW9uIE1SZXF1ZXN0VGlja2V0KGlkKXtcbiAgICB0aGlzLnByb3RvY29sID0gJ3NwcmF5JztcbiAgICB0aGlzLnR5cGUgPSAnTVJlcXVlc3RUaWNrZXQnO1xuICAgIHRoaXMuaWQgPSBpZDtcbn07XG5tb2R1bGUuZXhwb3J0cy5NUmVxdWVzdFRpY2tldCA9IE1SZXF1ZXN0VGlja2V0O1xuXG4vKiFcbiAqIFxcYnJpZWYgYW4gb2ZmZXIgdGlja2V0IGNvbnRhaW5pbmcgdGhlIGZpcnN0IHBhcnQgb2YgdGhlIHdlYnJ0YyBjb25uZWN0aW9uXG4gKiBlc3RhYmxpc2htZW50XG4gKiBcXHBhcmFtIGlkIHRoZSB1bmlxdWUgaWRlbnRpZmllciBvZiB0aGUgcmVxdWVzdCBtZXNzYWdlXG4gKiBcXHBhcmFtIHRpY2tldCB0aGUgZmlyc3Qgc3RlcCBvZiB0aGUgY29ubmVjdGlvbiBlc3RhYmxpc2hlbWVudCBkYXRhXG4gKiBcXHBhcmFtIHBlZXIgdGhlIHBlZXIgdGhhdCBlbWl0IHRoZSBvZmZlciB0aWNrZXRcbiAqL1xuZnVuY3Rpb24gTU9mZmVyVGlja2V0KGlkLCB0aWNrZXQsIHBlZXIpe1xuICAgIHRoaXMucHJvdG9jb2wgPSAnc3ByYXknO1xuICAgIHRoaXMudHlwZSA9ICdNT2ZmZXJUaWNrZXQnO1xuICAgIHRoaXMuaWQgPSBpZDtcbiAgICB0aGlzLnRpY2tldCA9IHRpY2tldDtcbiAgICB0aGlzLnBlZXIgPSBwZWVyO1xufTtcbm1vZHVsZS5leHBvcnRzLk1PZmZlclRpY2tldCA9IE1PZmZlclRpY2tldDtcblxuLyohXG4gKiBcXGJyaWVmIGFuIHN0YW1wZWQgdGlja2V0IGNvbnRhaW5pbmcgdGhlIHNlY29uZCBwYXJ0IG9mIHRoZSB3ZWJydGMgY29ubmVjdGlvblxuICogZXN0YWJsaXNoZW1lbnRcbiAqIFxccGFyYW0gaWQgdGhlIHVuaXF1ZSBpZGVudGlmaWVyIG9mIHRoZSByZXF1ZXN0IHRpY2tldFxuICogXFxwYXJhbSB0aWNrZXQgdGhlIHNlY29uZCBzdGVwIG9mIHRoZSBjb25uZWN0aW9uIGVzdGFibGlzaGVtZW50IGRhdGFcbiAqIFxccGFyYW0gcGVlciB0aGUgcGVlciB0aGF0IGVtaXQgdGhlIHN0YW1wZWQgdGlja2V0XG4gKi9cbmZ1bmN0aW9uIE1TdGFtcGVkVGlja2V0KGlkLCB0aWNrZXQsIHBlZXIpe1xuICAgIHRoaXMucHJvdG9jb2wgPSAnc3ByYXknO1xuICAgIHRoaXMudHlwZSA9ICdNU3RhbXBlZFRpY2tldCc7XG4gICAgdGhpcy5pZCA9IGlkO1xuICAgIHRoaXMudGlja2V0ID0gdGlja2V0O1xuICAgIHRoaXMucGVlciA9IHBlZXI7XG59O1xubW9kdWxlLmV4cG9ydHMuTVN0YW1wZWRUaWNrZXQgPSBNU3RhbXBlZFRpY2tldDtcblxuLyohXG4gKiBcXGJyaWVmIG1lc3NhZ2UgcmVxdWVzdGluZyBhbiBleGNoYW5nZSBvZiBuZWlnaGJvcmhvb2RcbiAqIFxccGFyYW0gaWQgdGhlIGlkZW50aWZpZXIgb2YgdGhlIHJlcXVlc3QgbWVzc2FnZVxuICogXFxwYXJhbSBwZWVyIHRoZSBpZGVudGl0eSBvZiB0aGUgaW5pdGlhdG9yIG9mIHRoZSBleGNoYW5nZVxuICovXG5mdW5jdGlvbiBNRXhjaGFuZ2UoaWQsIHBlZXIpe1xuICAgIHRoaXMucHJvdG9jb2wgPSAnc3ByYXknO1xuICAgIHRoaXMudHlwZSA9ICdNRXhjaGFuZ2UnO1xuICAgIHRoaXMuaWQgPSBpZDtcbiAgICB0aGlzLnBlZXIgPSBwZWVyO1xufTtcbm1vZHVsZS5leHBvcnRzLk1FeGNoYW5nZSA9IE1FeGNoYW5nZTtcbiIsInZhciBTb3J0ZWRBcnJheSA9IHJlcXVpcmUoXCJzb3J0ZWQtY21wLWFycmF5XCIpO1xuXG4vKiFcbiAqIFxcYnJpZWYgY29tcGFyYXRvclxuICogXFxwYXJhbSBhIHRoZSBmaXJzdCBvYmplY3QgaW5jbHVkaW5nIGFuICdhZ2UnIHByb3BlcnR5XG4gKiBcXHBhcmFtIGIgdGhlIHNlY29uZCBvYmplY3QgaW5jbHVkaW5nIGFuICdhZ2UnIHByb3BlcnR5XG4gKiBcXHJldHVybiAxIGlmIGEuYWdlID4gYi5hZ2UsIC0xIGlmIGEuYWdlIDwgYi5hZ2UsIDAgb3RoZXJ3aXNlXG4gKi9cbmZ1bmN0aW9uIGNvbXAoYSwgYil7XG4gICAgaWYgKGEuYWdlIDwgYi5hZ2UpeyByZXR1cm4gLTE7fTtcbiAgICBpZiAoYS5hZ2UgPiBiLmFnZSl7IHJldHVybiAgMTt9O1xuICAgIHJldHVybiAwO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHN0cnVjdHVyZSBjb250YWluaW5nIHRoZSBuZWlnaGJvcmhvb2Qgb2YgYSBwZWVyLlxuICovXG5mdW5jdGlvbiBQYXJ0aWFsVmlldygpe1xuICAgIC8vICMxIGluaXRpYWxpemUgdGhlIHBhcnRpYWwgdmlldyBhcyBhbiBhcnJheSBzb3J0ZWQgYnkgYWdlXG4gICAgdGhpcy5hcnJheSA9IG5ldyBTb3J0ZWRBcnJheShjb21wKTtcbn07XG5cbi8qIVxuICogXFxyZXR1cm4gdGhlIG9sZGVzdCBwZWVyIGluIHRoZSBhcnJheVxuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUuZ2V0T2xkZXN0ID0gZnVuY3Rpb24oKXtcbiAgICByZXR1cm4gdGhpcy5hcnJheS5hcnJbMF07XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgaW5jcmVtZW50IHRoZSBhZ2Ugb2YgdGhlIHdob2xlIHBhcnRpYWwgdmlld1xuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUuaW5jcmVtZW50QWdlID0gZnVuY3Rpb24oKXtcbiAgICBmb3IgKHZhciBpPTA7IGk8dGhpcy5hcnJheS5hcnIubGVuZ3RoOyArK2kpe1xuICAgICAgICB0aGlzLmFycmF5LmFycltpXS5hZ2UgKz0gMTtcbiAgICB9O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGdldCBhIHNhbXBsZSBvZiB0aGUgcGFydGlhbCB0byBzZW5kIHRvIHRoZSBuZWlnaGJvclxuICogXFxwYXJhbSBuZWlnaGJvciB0aGUgbmVpZ2hib3Igd2hpY2ggcGVyZm9ybXMgdGhlIGV4Y2hhbmdlIHdpdGggdXNcbiAqIFxccGFyYW0gaXNJbml0aWF0b3Igd2hldGhlciBvciBub3QgdGhlIGNhbGxlciBpcyB0aGUgaW5pdGlhdG9yIG9mIHRoZVxuICogZXhjaGFuZ2VcbiAqIFxccmV0dXJuIGFuIGFycmF5IGNvbnRhaW5pbmcgbmVpZ2hib3JzIGZyb20gdGhpcyBwYXJ0aWFsIHZpZXdcbiAqL1xuUGFydGlhbFZpZXcucHJvdG90eXBlLmdldFNhbXBsZSA9IGZ1bmN0aW9uKG5laWdoYm9yLCBpc0luaXRpYXRvcil7XG4gICAgdmFyIHNhbXBsZSA9IFtdO1xuICAgIC8vICMxIGNvcHkgdGhlIHBhcnRpYWwgdmlld1xuICAgIHZhciBjbG9uZSA9IG5ldyBTb3J0ZWRBcnJheShjb21wKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMuYXJyYXkuYXJyLmxlbmd0aDsgKytpKXtcbiAgICAgICAgY2xvbmUuYXJyLnB1c2godGhpcy5hcnJheS5hcnJbaV0pO1xuICAgIH07XG5cbiAgICAvLyAjMiBwcm9jZXNzIHRoZSBzaXplIG9mIHRoZSBzYW1wbGVcbiAgICB2YXIgc2FtcGxlU2l6ZSA9IE1hdGguY2VpbCh0aGlzLmFycmF5LmFyci5sZW5ndGgvMik7XG4gICAgXG4gICAgaWYgKGlzSW5pdGlhdG9yKXtcbiAgICAgICAgLy8gI0EgcmVtb3ZlIGFuIG9jY3VycmVuY2Ugb2YgdGhlIGNob3NlbiBuZWlnaGJvclxuICAgICAgICB2YXIgaW5kZXggPSBjbG9uZS5pbmRleE9mKG5laWdoYm9yKTtcbiAgICAgICAgc2FtcGxlLnB1c2goY2xvbmUuYXJyW2luZGV4XSk7IFxuICAgICAgICBjbG9uZS5hcnIuc3BsaWNlKGluZGV4LCAxKTtcbiAgICB9O1xuICAgIFxuICAgIC8vICMzIHJhbmRvbWx5IGFkZCBuZWlnaGJvcnMgdG8gdGhlIHNhbXBsZVxuICAgIHdoaWxlIChzYW1wbGUubGVuZ3RoIDwgc2FtcGxlU2l6ZSl7XG4gICAgICAgIHZhciBybiA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSpjbG9uZS5hcnIubGVuZ3RoKTtcbiAgICAgICAgc2FtcGxlLnB1c2goY2xvbmUuYXJyW3JuXSk7XG4gICAgICAgIGNsb25lLmFyci5zcGxpY2Uocm4sIDEpO1xuICAgIH07XG4gICAgXG4gICAgcmV0dXJuIHNhbXBsZTtcbn07XG5cblxuXG4vKiFcbiAqIFxcYnJpZWYgcmVwbGFjZSB0aGUgb2NjdXJyZW5jZXMgb2YgdGhlIG9sZCBwZWVyIGJ5IHRoZSBmcmVzaCBvbmVcbiAqIFxccGFyYW0gc2FtcGxlIHRoZSBzYW1wbGUgdG8gbW9kaWZ5XG4gKiBcXHBhcmFtIG9sZCB0aGUgb2xkIHJlZmVyZW5jZSB0byByZXBsYWNlXG4gKiBcXHBhcmFtIGZyZXNoIHRoZSBuZXcgcmVmZXJlbmNlIHRvIGluc2VydFxuICogXFxyZXR1cm4gYW4gYXJyYXkgd2l0aCB0aGUgcmVwbGFjZWQgb2NjdXJlbmNlc1xuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUucmVwbGFjZSA9IGZ1bmN0aW9uKHNhbXBsZSwgb2xkLCBmcmVzaCl7XG4gICAgdmFyIHJlc3VsdCA9IFtdO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc2FtcGxlLmxlbmd0aDsgKytpKXtcbiAgICAgICAgaWYgKHNhbXBsZVtpXS5pZCA9PT0gb2xkLmlkKXtcbiAgICAgICAgICAgIHJlc3VsdC5wdXNoKGZyZXNoKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJlc3VsdC5wdXNoKHNhbXBsZVtpXSk7XG4gICAgICAgIH07XG4gICAgfTtcbiAgICByZXR1cm4gcmVzdWx0O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGFkZCB0aGUgbmVpZ2Job3IgdG8gdGhlIHBhcnRpYWwgdmlldyB3aXRoIGFuIGFnZSBvZiAwXG4gKiBcXHBhcmFtIHBlZXIgdGhlIHBlZXIgdG8gYWRkIHRvIHRoZSBwYXJ0aWFsIHZpZXdcbiAqL1xuUGFydGlhbFZpZXcucHJvdG90eXBlLmFkZE5laWdoYm9yID0gZnVuY3Rpb24ocGVlcil7XG4gICAgcGVlci5hZ2UgPSAwO1xuICAgIHRoaXMuYXJyYXkuYXJyLnB1c2gocGVlcik7XG59O1xuXG5cbi8qIVxuICogXFxicmllZiBnZXQgdGhlIGluZGV4IG9mIHRoZSBwZWVyIGluIHRoZSBwYXJ0aWFsdmlld1xuICogXFxyZXR1cm4gdGhlIGluZGV4IG9mIHRoZSBwZWVyIGluIHRoZSBhcnJheSwgLTEgaWYgbm90IGZvdW5kXG4gKi9cblBhcnRpYWxWaWV3LnByb3RvdHlwZS5nZXRJbmRleCA9IGZ1bmN0aW9uKHBlZXIpe1xuICAgIHZhciBpID0gMCxcbiAgICAgICAgaW5kZXggPSAtMTtcbiAgICAgICAgZm91bmQgPSBmYWxzZTtcbiAgICB3aGlsZSAoIWZvdW5kICYmIGkgPCB0aGlzLmFycmF5LmFyci5sZW5ndGgpe1xuICAgICAgICBpZiAocGVlci5pZCA9PT0gdGhpcy5hcnJheS5hcnJbaV0uaWQpe1xuICAgICAgICAgICAgZm91bmQgPSB0cnVlO1xuICAgICAgICAgICAgaW5kZXggPSBpO1xuICAgICAgICB9O1xuICAgICAgICArK2k7XG4gICAgfTtcbiAgICByZXR1cm4gaW5kZXg7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgcmVtb3ZlIHRoZSBwZWVyIGZyb20gdGhlIHBhcnRpYWwgdmlld1xuICogXFxwYXJhbSBwZWVyIHRoZSBwZWVyIHRvIHJlbW92ZVxuICogXFxyZXR1cm4gdGhlIHJlbW92ZWQgZW50cnkgaWYgaXQgZXhpc3RzLCBudWxsIG90aGVyd2lzZVxuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUucmVtb3ZlUGVlciA9IGZ1bmN0aW9uKHBlZXIpe1xuICAgIHZhciBpbmRleCA9IHRoaXMuZ2V0SW5kZXgocGVlciksXG4gICAgICAgIHJlbW92ZWRFbnRyeSA9IG51bGw7XG4gICAgaWYgKGluZGV4ID4gLTEpe1xuICAgICAgICByZW1vdmVkRW50cnkgPSB0aGlzLmFycmF5LmFycltpbmRleF07XG4gICAgICAgIHRoaXMuYXJyYXkuYXJyLnNwbGljZShpbmRleCwgMSk7XG4gICAgfTtcbiAgICByZXR1cm4gcmVtb3ZlZEVudHJ5O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHJlbW92ZSB0aGUgcGVlciB3aXRoIHRoZSBhc3NvY2lhdGVkIGFnZSBmcm9tIHRoZSBwYXJ0aWFsIHZpZXdcbiAqIFxccGFyYW0gcGVlciB0aGUgcGVlciB0byByZW1vdmVcbiAqIFxccGFyYW0gYWdlIHRoZSBhZ2Ugb2YgdGhlIHBlZXIgdG8gcmVtb3ZlXG4gKiBcXHJldHVybiB0aGUgcmVtb3ZlZCBlbnRyeSBpZiBpdCBleGlzdHMsIG51bGwgb3RoZXJ3aXNlXG4gKi9cblBhcnRpYWxWaWV3LnByb3RvdHlwZS5yZW1vdmVQZWVyQWdlID0gZnVuY3Rpb24ocGVlciwgYWdlKXtcbiAgICB2YXIgZm91bmQgPSBmYWxzZSxcbiAgICAgICAgaSA9IDAsXG4gICAgICAgIHJlbW92ZWRFbnRyeSA9IG51bGw7XG4gICAgd2hpbGUoIWZvdW5kICYmIGkgPCB0aGlzLmFycmF5LmFyci5sZW5ndGgpe1xuICAgICAgICBpZiAocGVlci5pZCA9PT0gdGhpcy5hcnJheS5hcnJbaV0uaWQgJiYgYWdlID09PSB0aGlzLmFycmF5LmFycltpXS5hZ2Upe1xuICAgICAgICAgICAgZm91bmQgPSB0cnVlO1xuICAgICAgICAgICAgcmVtb3ZlZEVudHJ5ID0gdGhpcy5hcnJheS5hcnJbaV07XG4gICAgICAgICAgICB0aGlzLmFycmF5LmFyci5zcGxpY2UoaSwgMSk7XG4gICAgICAgIH07XG4gICAgICAgICsraTtcbiAgICB9O1xuICAgIHJldHVybiByZW1vdmVkRW50cnk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgcmVtb3ZlIGFsbCBvY2N1cnJlbmNlcyBvZiB0aGUgcGVlciBhbmQgcmV0dXJuIHRoZSBudW1iZXIgb2YgcmVtb3ZhbHNcbiAqIFxccGFyYW0gcGVlciB0aGUgcGVlciB0byByZW1vdmVcbiAqIFxccmV0dXJuIHRoZSBudW1iZXIgb2Ygb2NjdXJyZW5jZXMgb2YgdGhlIHJlbW92ZWQgcGVlclxuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUucmVtb3ZlQWxsID0gZnVuY3Rpb24ocGVlcil7XG4gICAgdmFyIG9jYyA9IDAsXG4gICAgICAgIGkgPSAwO1xuICAgIHdoaWxlIChpIDwgdGhpcy5hcnJheS5hcnIubGVuZ3RoKXtcbiAgICAgICAgaWYgKHRoaXMuYXJyYXkuYXJyW2ldLmlkID09PSBwZWVyLmlkKXtcbiAgICAgICAgICAgIHRoaXMuYXJyYXkuYXJyLnNwbGljZShpLCAxKTtcbiAgICAgICAgICAgIG9jYyArPSAxO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgKytpO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgcmV0dXJuIG9jYztcbn07XG5cbi8qIVxuICogXFxicmllZiByZW1vdmUgYWxsIHRoZSBlbGVtZW50cyBjb250YWluZWQgaW4gdGhlIHNhbXBsZSBpbiBhcmd1bWVudFxuICogXFxwYXJhbSBzYW1wbGUgdGhlIGVsZW1lbnRzIHRvIHJlbW92ZVxuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUucmVtb3ZlU2FtcGxlID0gZnVuY3Rpb24oc2FtcGxlKXtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHNhbXBsZS5sZW5ndGg7ICsraSl7XG4gICAgICAgIHRoaXMucmVtb3ZlUGVlckFnZShzYW1wbGVbaV0sIHNhbXBsZVtpXS5hZ2UpO1xuICAgIH07XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0IHRoZSBzaXplIG9mIHRoZSBwYXJ0aWFsIHZpZXdcbiAqIFxccmV0dXJuIHRoZSBzaXplIG9mIHRoZSBwYXJ0aWFsIHZpZXdcbiAqL1xuUGFydGlhbFZpZXcucHJvdG90eXBlLmxlbmd0aCA9IGZ1bmN0aW9uKCl7XG4gICAgcmV0dXJuIHRoaXMuYXJyYXkuYXJyLmxlbmd0aDtcbn07XG5cbi8qIVxuICogXFxicmllZiBjaGVjayBpZiB0aGUgcGFydGlhbCB2aWV3IGNvbnRhaW5zIHRoZSByZWZlcmVuY2VcbiAqIFxccGFyYW0gcGVlciB0aGUgcGVlciB0byBjaGVja1xuICogXFxyZXR1cm4gdHJ1ZSBpZiB0aGUgcGVlciBpcyBpbiB0aGUgcGFydGlhbCB2aWV3LCBmYWxzZSBvdGhlcndpc2VcbiAqL1xuUGFydGlhbFZpZXcucHJvdG90eXBlLmNvbnRhaW5zID0gZnVuY3Rpb24ocGVlcil7XG4gICAgcmV0dXJuIHRoaXMuZ2V0SW5kZXgocGVlcik+PTA7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IFBhcnRpYWxWaWV3O1xuIiwidmFyIFNvcnRlZEFycmF5ID0gcmVxdWlyZShcInNvcnRlZC1jbXAtYXJyYXlcIik7XG5cbi8qIVxuICogXFxicmllZiByZXByZXNlbnQgdGhlIGFycmF5IGNvbnRhaW5pbmcgdGhlIHNvY2tldHMgYXNzb2NpYXRlZCB3aXRoXG4gKiBhIHVuaXF1ZSBpZGVudGlmaWVyIGlkXG4gKi9cbmZ1bmN0aW9uIFNvY2tldHMoKXtcbiAgICB0aGlzLmFycmF5ID0gbmV3IFNvcnRlZEFycmF5KFxuICAgICAgICBmdW5jdGlvbihhLCBiKXtcbiAgICAgICAgICAgIGlmIChhLmlkIDwgYi5pZCl7IHJldHVybiAtMTsgfTtcbiAgICAgICAgICAgIGlmIChhLmlkID4gYi5pZCl7IHJldHVybiAgMTsgfTtcbiAgICAgICAgICAgIHJldHVybiAwO1xuICAgICAgICB9XG4gICAgKTtcbiAgICB0aGlzLmxhc3RDaGFuY2UgPSBudWxsOyAvLyBsYXN0IGNoYW5jZSBzb2NrZXQuXG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgYWRkIHRoZSBzb2NrZXQgd2l0aCBhbiBvYmplY3QgY29udGFpbmluZyBhbiBpZGVudGlmaWVyIFxuICogXFxwYXJhbSBzb2NrZXQgdGhlIHNvY2tldCB0byBjb21tdW5pY2F0ZSB3aXRoIHBlZXJcbiAqIFxccGFyYW0gb2JqZWN0IHRoZSBvYmplY3QgY29udGFpbmluZyB0aGUgaWRlbnRpZmllclxuICogXFxyZXR1cm4gdHJ1ZSBpZiB0aGUgc29ja2V0IGFzIGJlZW4gYWRkZWQsIGZhbHNlIG90aGVyd2lzZVxuICovIFxuU29ja2V0cy5wcm90b3R5cGUuYWRkU29ja2V0ID0gZnVuY3Rpb24oc29ja2V0LCBvYmplY3Qpe1xuICAgIHZhciBjb250YWlucyA9IHRoaXMuY29udGFpbnMob2JqZWN0KTtcbiAgICBpZiAoIWNvbnRhaW5zKXtcbiAgICAgICAgdGhpcy5hcnJheS5pbnNlcnQoe2lkOm9iamVjdC5pZCwgc29ja2V0OnNvY2tldH0pO1xuICAgIH07XG4gICAgcmV0dXJuICFjb250YWlucztcbn07XG5cbi8qIVxuICogXFxicmllZiByZW1vdmUgdGhlIG9iamVjdCBhbmQgaXRzIGFzc29jaWF0ZWQgc29ja2V0IGZyb20gdGhlIGFycmF5XG4gKiBcXHBhcmFtIG9iamVjdCB0aGUgb2JqZWN0IGNvbnRhaW5pbmcgdGhlIGlkZW50aWZpZXIgdG8gcmVtb3ZlXG4gKiBcXHJldHVybiB0aGUgc29ja2V0IHRhcmdldGVkIGJ5IHRoZSByZW1vdmFsLCBudWxsIGlmIGl0IGRvZXMgbm90IGV4aXN0XG4gKi9cblNvY2tldHMucHJvdG90eXBlLnJlbW92ZVNvY2tldCA9IGZ1bmN0aW9uKG9iamVjdCl7XG4gICAgdmFyIHNvY2tldCA9IHRoaXMuZ2V0U29ja2V0KG9iamVjdCk7XG4gICAgaWYgKHNvY2tldCAhPT0gbnVsbCl7XG4gICAgICAgIHRoaXMuYXJyYXkucmVtb3ZlKG9iamVjdCk7XG4gICAgICAgIHRoaXMubGFzdENoYW5jZSA9IHNvY2tldDtcbiAgICB9O1xuICAgIHJldHVybiBzb2NrZXQ7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0IHRoZSBzb2NrZXQgYXR0YWNoZWQgdG8gdGhlIG9iamVjdCBpZGVudGl0eVxuICogXFxwYXJhbSBvYmplY3QgdGhlIG9iamVjdCBjb250YWluaW5nIHRoZSBpZGVudGlmaWVyIHRvIHNlYXJjaFxuICogXFxyZXR1cm4gdGhlIHNvY2tldCBpZiB0aGUgb2JqZWN0IGV4aXN0cywgbnVsbCBvdGhlcndpc2VcbiAqL1xuU29ja2V0cy5wcm90b3R5cGUuZ2V0U29ja2V0ID0gZnVuY3Rpb24ob2JqZWN0KXtcbiAgICB2YXIgaW5kZXggPSB0aGlzLmFycmF5LmluZGV4T2Yob2JqZWN0KSxcbiAgICAgICAgc29ja2V0ID0gbnVsbDtcbiAgICBpZiAoaW5kZXggIT09IC0xKXtcbiAgICAgICAgc29ja2V0ID0gdGhpcy5hcnJheS5hcnJbaW5kZXhdLnNvY2tldDtcbiAgICB9O1xuICAgIHJldHVybiBzb2NrZXQ7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgY2hlY2sgaWYgdGhlcmUgaXMgYSBzb2NrZXQgYXNzb2NpYXRlZCB0byB0aGUgb2JqZWN0XG4gKiBcXHBhcmFtIG9iamVjdCB0aGUgb2JqZWN0IGNvbnRhaW5pbmcgdGhlIGlkZW50aWZpZXIgdG8gY2hlY2tcbiAqIFxccmV0dXJuIHRydWUgaWYgYSBzb2NrZXQgYXNzb2NpYXRlZCB0byB0aGUgb2JqZWN0IGV4aXN0cywgZmFsc2Ugb3RoZXJ3aXNlXG4gKi9cblNvY2tldHMucHJvdG90eXBlLmNvbnRhaW5zID0gZnVuY3Rpb24ob2JqZWN0KXtcbiAgICByZXR1cm4gKHRoaXMuYXJyYXkuaW5kZXhPZihvYmplY3QpICE9PSAtMSk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0IHRoZSBsZW5ndGggb2YgdGhlIHVuZGVybHlpbmcgYXJyYXlcbiAqIFxccmV0dXJuIHRoZSBsZW5ndGggb2YgdGhlIGFycmF5XG4gKi9cblNvY2tldHMucHJvdG90eXBlLmxlbmd0aCA9IGZ1bmN0aW9uKCl7XG4gICAgcmV0dXJuIHRoaXMuYXJyYXkuYXJyLmxlbmd0aDtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gU29ja2V0cztcbiIsInZhciBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKS5FdmVudEVtaXR0ZXI7XG52YXIgU29ja2V0ID0gcmVxdWlyZSgnc2ltcGxlLXBlZXInKTtcbnZhciB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuXG52YXIgUGFydGlhbFZpZXcgPSByZXF1aXJlKCcuL3BhcnRpYWx2aWV3LmpzJyk7XG52YXIgU29ja2V0cyA9IHJlcXVpcmUoJy4vc29ja2V0cy5qcycpO1xudmFyIEdVSUQgPSByZXF1aXJlKCcuL2d1aWQuanMnKTtcblxudmFyIE1lc3NhZ2VzID0gcmVxdWlyZSgnLi9tZXNzYWdlcy5qcycpO1xudmFyIE1Kb2luID0gTWVzc2FnZXMuTUpvaW47XG52YXIgTVJlcXVlc3RUaWNrZXQgPSBNZXNzYWdlcy5NUmVxdWVzdFRpY2tldDtcbnZhciBNT2ZmZXJUaWNrZXQgPSBNZXNzYWdlcy5NT2ZmZXJUaWNrZXQ7XG52YXIgTVN0YW1wZWRUaWNrZXQgPSBNZXNzYWdlcy5NU3RhbXBlZFRpY2tldDtcbnZhciBNRXhjaGFuZ2UgPSBNZXNzYWdlcy5NRXhjaGFuZ2U7XG5cbnV0aWwuaW5oZXJpdHMoU3ByYXksIEV2ZW50RW1pdHRlcik7XG5cbi8qIVxuICogXFxicmllZiBJbXBsZW1lbnRhdGlvbiBvZiB0aGUgcmFuZG9tIHBlZXIgc2FtcGxpbmcgY2FsbGVkIFNwcmF5IG9uIHRvcCBvZlxuICogc29ja2V0LmlvXG4gKiBcXHBhcmFtIGlkIHRoZSB1bmlxdWUgaWRlbnRpZmllciBvZiBvdXIgcGVlclxuICogXFxwYXJhbSBvcHRpb25zIHRoZSBXZWJSVEMgb3B0aW9ucywgZm9yIG1vcmUgaW5mb3JtYXRpb25zOiBcbiAqIFxcdXJsIGh0dHBzOi8vZ2l0aHViLmNvbS9mZXJvc3Mvc2ltcGxlLXBlZXJcbiAqL1xuZnVuY3Rpb24gU3ByYXkoaWQsIG9wdGlvbnMpe1xuICAgIEV2ZW50RW1pdHRlci5jYWxsKHRoaXMpO1xuICAgIC8vICNBIGNvbnN0YW50c1xuICAgIHRoaXMuREVMVEFUSU1FID0gKG9wdGlvbnMgJiYgb3B0aW9ucy5kZWx0YXRpbWUpIHx8IDEwMDAgKiA2MCAqIDI7IC8vIDJtaW5cbiAgICB0aGlzLlRJTUVPVVQgPSAob3B0aW9ucyAmJiBvcHRpb25zLnRpbWVvdXQpIHx8IDEwMDAgKiA2MCAqIDE7IC8vIDFtaW5cbiAgICB0aGlzLklEID0gKGlkICYmICcnK2lkKycnKSB8fCBHVUlEKCk7XG4gICAgdGhpcy5PUFRJT05TID0gb3B0aW9ucyB8fCB7fTtcbiAgICBcbiAgICAvLyAjQiBwcm90b2NvbCB2YXJpYWJsZXNcbiAgICB0aGlzLnBhcnRpYWxWaWV3ID0gbmV3IFBhcnRpYWxWaWV3KCk7XG4gICAgdGhpcy5zb2NrZXRzID0gbmV3IFNvY2tldHMoKTtcbiAgICB0aGlzLnBlbmRpbmcgPSBuZXcgU29ja2V0cygpO1xuICAgIHRoaXMuZm9yd2FyZHMgPSBuZXcgU29ja2V0cygpO1xuICAgIHRoaXMuc3RhdGUgPSAnZGlzY29ubmVjdCc7XG4gICAgXG4gICAgLy8gI0Mgd2VicnRjIHNwZWNpZmljc1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBzZXRJbnRlcnZhbChmdW5jdGlvbigpe1xuICAgICAgICBpZiAoc2VsZi5wYXJ0aWFsVmlldy5sZW5ndGgoKT4wKXtcbiAgICAgICAgICAgIHNlbGYuZXhjaGFuZ2UoKTtcbiAgICAgICAgfTtcbiAgICB9LCB0aGlzLkRFTFRBVElNRSk7XG5cbiAgICAvLyAjRCBldmVudHNcbiAgICB0aGlzLm9uKCdzcHJheS1yZWNlaXZlJywgZnVuY3Rpb24oc29ja2V0LCBtZXNzYWdlKXtcbiAgICAgICAgc2VsZi5vblNwcmF5UmVjZWl2ZShzb2NrZXQsIG1lc3NhZ2UpO1xuICAgIH0pO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNoZWNrIGlmIHRoZSBuZXR3b3JrIGlzIHJlYWR5IGFuZCBjYWxsYmFjaywgbm90aGluZyBvdGhlcndpc2VcbiAqIFxccGFyYW0gY2FsbGJhY2sgdGhlIGZ1bmN0aW9uIHRvIGNhbGwgaWYgdGhlIG5ldHdvcmsgaXMgcmVhZHlcbiAqL1xuU3ByYXkucHJvdG90eXBlLnJlYWR5ID0gZnVuY3Rpb24oY2FsbGJhY2spe1xuICAgIGlmICh0aGlzLnBhcnRpYWxWaWV3Lmxlbmd0aCgpID4gMCl7IGNhbGxiYWNrKCk7IH07XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0IGEgc2V0IG9mIG5laWdoYm9yc1xuICogXFxwYXJhbSBrIHRoZSBudW1iZXIgb2YgbmVpZ2hib3JzIHJlcXVlc3RlZFxuICogXFxyZXR1cm4gYSBsaXN0IG9mIHNvY2tldHNcbiAqL1xuU3ByYXkucHJvdG90eXBlLmdldFBlZXJzID0gZnVuY3Rpb24oayl7XG4gICAgdmFyIHJlc3VsdCA9IFtdO1xuICAgIC8vICNBIGNvcHkgdGhlIHNvY2tldHMgb2YgdGhlIHBhcnRpYWwgdmlld1xuICAgIHZhciBjbG9uZVNvY2tldHMgPSBbXTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMuc29ja2V0cy5sZW5ndGgoKTsgKytpKXtcbiAgICAgICAgY2xvbmVTb2NrZXRzW2ldID0gdGhpcy5zb2NrZXRzLmFycmF5LmFycltpXTtcbiAgICB9O1xuICAgIC8vICNCIGdldCBhcyBtdWNoIG5laWdoYm9ycyBhcyBwb3NzaWJsZVxuICAgIHdoaWxlICgwIDwgY2xvbmVTb2NrZXRzLmxlbmd0aCAmJiByZXN1bHQubGVuZ3RoIDwgayl7XG4gICAgICAgIHZhciBybiA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSpjbG9uZVNvY2tldHMubGVuZ3RoKTtcbiAgICAgICAgcmVzdWx0LnB1c2goY2xvbmVTb2NrZXRzW3JuXS5zb2NrZXQpO1xuICAgICAgICBjbG9uZVNvY2tldHMuc3BsaWNlKHJuLCAxKTtcbiAgICB9O1xuICAgIC8vICNDIGxhc3QgY2hhbmNlIHNvY2tldFxuICAgIGlmIChrPjAgJiYgcmVzdWx0Lmxlbmd0aD09PTAgJiYgdGhpcy5zb2NrZXRzLmxhc3RDaGFuY2UhPT1udWxsKXtcbiAgICAgICAgcmVzdWx0LnB1c2godGhpcy5zb2NrZXRzLmxhc3RDaGFuY2UpO1xuICAgIH07XG4gICAgcmV0dXJuIHJlc3VsdDtcbn07XG5cblNwcmF5LnByb3RvdHlwZS51cGRhdGVTdGF0ZSA9IGZ1bmN0aW9uKCl7XG4gICAgaWYgKHRoaXMucGFydGlhbFZpZXcubGVuZ3RoKCkgPiAwICYmIHRoaXMuc3RhdGUgIT09ICdjb25uZWN0Jyl7XG4gICAgICAgIHRoaXMuc3RhdGUgPSAnY29ubmVjdCc7XG4gICAgICAgIHRoaXMuZW1pdCgnc3RhdGVjaGFuZ2UnLCAnY29ubmVjdCcpO1xuICAgIH1cbiAgICBpZiAodGhpcy5wYXJ0aWFsVmlldy5sZW5ndGgoKSA9PT0gMCAmJiB0aGlzLnBlbmRpbmcubGVuZ3RoKCkgPiAwICYmXG4gICAgICAgIHRoaXMuc3RhdGUgIT09ICdwYXJ0aWFsJyl7XG4gICAgICAgIHRoaXMuc3RhdGUgPSAncGFydGlhbCc7XG4gICAgICAgIHRoaXMuZW1pdCgnc3RhdGVjaGFuZ2UnLCAncGFydGlhbCcpO1xuICAgIH07XG4gICAgaWYgKHRoaXMucGFydGlhbFZpZXcubGVuZ3RoKCkgPT09IDAgJiYgdGhpcy5wZW5kaW5nLmxlbmd0aCgpID09PSAwICYmXG4gICAgICAgIHRoaXMuc3RhdGUgIT09ICdkaXNjb25uZWN0Jyl7XG4gICAgICAgIHRoaXMuc3RhdGUgPSAnZGlzY29ubmVjdCc7XG4gICAgICAgIHRoaXMuZW1pdCgnc3RhdGVjaGFuZ2UnLCAnZGlzY29ubmVjdCcpO1xuICAgIH07XG59O1xuXG4vKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKlxuICogQm9vdHN0cmFwIHRoZSBmaXJzdCBXZWJSVEMgY29ubmVjdGlvblxuICoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKi9cblxuLyohXG4gKiBcXGJyaWVmIHRoZSB2ZXJ5IGZpcnN0IHBhcnQgb2YgYSBjb25uZWN0aW9uIGVzdGFibGlzaG1lbnQgdG8gam9pbiB0aGUgbmV0d29yay5cbiAqIFRoaXMgcGFydCBjb3JyZXNwb25kcyB0byB0aGUgZmlyc3QgcGFydCBvZiB0aGUgJ29uU3RhbXBlZFRpY2tldFJlcXVlc3QnIG9mXG4gKiB0aGUgc3ByYXkgcHJvdG9jb2wuXG4gKiBcXHBhcmFtIGNhbGxiYWNrIGEgY2FsbGJhY2sgZnVuY3Rpb24gdGFraW5nIGEgJ21lc3NhZ2UnIGluIGFyZ3VtZW50IGFuZFxuICogY2FsbGVkIHdoZW4gd2UgcmVjZWl2ZSB0aGUgZGF0YSBmcm9tIHRoZSBzdHVuIHNlcnZlclxuICovXG5TcHJheS5wcm90b3R5cGUubGF1bmNoID0gZnVuY3Rpb24oY2FsbGJhY2spe1xuICAgIHZhciBvcHRpb25zPXRoaXMuT1BUSU9OUzsgb3B0aW9ucy5pbml0aWF0b3I9dHJ1ZTsgb3B0aW9ucy50cmlja2xlPWZhbHNlO1xuICAgIHZhciBzb2NrZXQgPSBuZXcgU29ja2V0KG9wdGlvbnMpLFxuICAgICAgICBpZCA9IEdVSUQoKSxcbiAgICAgICAgc2VsZiA9IHRoaXM7XG4gICAgc29ja2V0Lm9uKCdzaWduYWwnLCBmdW5jdGlvbihkYXRhKXtcbiAgICAgICAgdmFyIG1lc3NhZ2UgPSBuZXcgTU9mZmVyVGlja2V0KGlkLCBkYXRhLCB7aWQ6IHNlbGYuSUR9KTtcbiAgICAgICAgc2VsZi5wZW5kaW5nLmFkZFNvY2tldChzb2NrZXQsIG1lc3NhZ2UpO1xuICAgICAgICBjYWxsYmFjayhtZXNzYWdlKTtcbiAgICB9KTtcbiAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7XG4gICAgICAgIGlmIChzZWxmLnBlbmRpbmcuY29udGFpbnMoe2lkOmlkfSkpe1xuICAgICAgICAgICAgc2VsZi5wZW5kaW5nLnJlbW92ZVNvY2tldCh7aWQ6aWR9KTtcbiAgICAgICAgICAgIHNvY2tldC5kZXN0cm95KCk7XG4gICAgICAgIH07XG4gICAgfSwgdGhpcy5USU1FT1VUKTtcbn07XG5cbi8qIVxuICogXFxicmllZiB0aGUgc2Vjb25kIHBhcnQgb2YgdGhlIGNvbm5lY3Rpb24gZXN0YWJsaXNobWVudC4gVGhpcyBmdW5jdGlvbiBpc1xuICogY2FsbGVkIGF0IHRoZSBwZWVyIGFscmVhZHkgaW5zaWRlIHRoZSBuZXR3b3JrLiBJdCBjb3JyZXNwb25kcyB0byB0aGUgZnVuY3Rpb25cbiAqICdvblRpY2tldFJlcXVlc3QnIG9mIHRoZSBTcHJheSBwcm90b2NvbFxuICogXFxwYXJhbSBtZXNzYWdlIHRoZSBtZXNzYWdlIGdlbmVyYXRlZCBieSB0aGUgbGF1bmNoIGZ1bmN0aW9uIGF0IHRoZSBqb2luaW5nXG4gKiBwZWVyXG4gKiBcXHBhcmFtIGNhbGxiYWNrIHRoZSBmdW5jdGlvbiBjYWxsZWQgd2hlbiB3ZSByZWNlaXZlIHRoZSBzdGFtcGVkIHRpY2tldCBmcm9tXG4gKiB0aGUgc3R1biBzZXJ2ZXIuIEl0IGhhcyBhICdtZXNzYWdlJyBhcmd1bWVudC5cbiAqL1xuU3ByYXkucHJvdG90eXBlLmFuc3dlciA9IGZ1bmN0aW9uKG1lc3NhZ2UsIGNhbGxiYWNrKXtcbiAgICB2YXIgb3B0aW9ucz10aGlzLk9QVElPTlM7IG9wdGlvbnMuaW5pdGlhdG9yPWZhbHNlOyBvcHRpb25zLnRyaWNrbGU9ZmFsc2U7XG4gICAgdmFyIHNvY2tldCA9IG5ldyBTb2NrZXQob3B0aW9ucyksXG4gICAgICAgIGlkID0gbWVzc2FnZS5pZCxcbiAgICAgICAgdGlja2V0ID0gbWVzc2FnZS50aWNrZXQsXG4gICAgICAgIHBlZXIgPSBtZXNzYWdlLnBlZXIsXG4gICAgICAgIHNlbGYgPSB0aGlzO1xuICAgIHNvY2tldC5vbignc2lnbmFsJywgZnVuY3Rpb24oZGF0YSl7XG4gICAgICAgIHZhciBzdGFtcGVkVGlja2V0ID0gbmV3IE1TdGFtcGVkVGlja2V0KGlkLCBkYXRhLCB7aWQ6c2VsZi5JRH0pO1xuICAgICAgICBzZWxmLnBlbmRpbmcuYWRkU29ja2V0KHNvY2tldCwgc3RhbXBlZFRpY2tldCk7XG4gICAgICAgIGNhbGxiYWNrKHN0YW1wZWRUaWNrZXQpO1xuICAgIH0pO1xuICAgIHNvY2tldC5vbignY29ubmVjdCcsIGZ1bmN0aW9uKCl7XG4gICAgICAgIGNvbnNvbGUubG9nKCd3cnRjOiBzdWNjZXNzZnVsIGNvbm5lY3Rpb24gZXN0YWJsaXNobWVudCcpO1xuICAgICAgICBzZWxmLnBlbmRpbmcucmVtb3ZlU29ja2V0KG1lc3NhZ2UpO1xuICAgIH0pO1xuICAgIHNvY2tldC5vbignZGF0YScsIGZ1bmN0aW9uKHJlY2VpdmVkTWVzc2FnZSl7XG4gICAgICAgIHNlbGYucmVjZWl2ZShzb2NrZXQsIHJlY2VpdmVkTWVzc2FnZSk7XG4gICAgfSk7XG4gICAgc29ja2V0Lm9uKCdzdHJlYW0nLCBmdW5jdGlvbihzdHJlYW0pe1xuICAgICAgICBzZWxmLmVtaXQoJ3N0cmVhbScsIHNvY2tldCwgc3RyZWFtKTtcbiAgICB9KTtcbiAgICBzb2NrZXQub24oJ2Nsb3NlJywgZnVuY3Rpb24oKXtcbiAgICAgICAgY29uc29sZS5sb2coJ3dydGM6IGEgY29ubmVjdGlvbiBoYXMgYmVlbiBjbG9zZWQnKTtcbiAgICB9KTtcbiAgICBzb2NrZXQuc2lnbmFsKHRpY2tldCk7XG4gICAgc2V0VGltZW91dChmdW5jdGlvbigpe1xuICAgICAgICBpZiAoc2VsZi5wZW5kaW5nLmNvbnRhaW5zKHtpZDppZH0pKXtcbiAgICAgICAgICAgIHZhciBzb2NrZXQgPSBzZWxmLnBlbmRpbmcucmVtb3ZlU29ja2V0KHtpZDppZH0pO1xuICAgICAgICAgICAgc29ja2V0LmRlc3Ryb3koKTtcbiAgICAgICAgfTtcbiAgICB9LCB0aGlzLlRJTUVPVVQpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHRoZSB0aGlyZCBwYXJ0IG9mIHRoZSB2ZXJ5IGZpcnN0IGNvbm5lY3Rpb24gZXN0YWJsaXNobWVudCB0byBqb2luIHRoZVxuICogbmV0d29yay4gSXQgY29ycmVzcG9uZHMgdG8gdGhlIGxhc3QgcGFydCBvZiB0aGUgZnVuY3Rpb24gb2ZcbiAqICdvblN0YW1wZWRUaWNrZXRSZXF1ZXN0JyBvZiB0aGUgU3ByYXkgcHJvdG9jb2wuXG4gKiBcXHBhcmFtIG1lc3NhZ2UgdGhlIG1lc3NhZ2UgY29udGFpbmluZyB0aGUgc3RhbXBlZCB0aWNrZXQgZnJvbSB0aGUgY29udGFjdFxuICogcGVlclxuICovXG5TcHJheS5wcm90b3R5cGUuaGFuZHNoYWtlID0gZnVuY3Rpb24obWVzc2FnZSl7XG4gICAgdmFyIHNvY2tldCA9IHRoaXMucGVuZGluZy5yZW1vdmVTb2NrZXQobWVzc2FnZSksXG4gICAgICAgIGlkID0gbWVzc2FnZS5pZCxcbiAgICAgICAgdGlja2V0ID0gbWVzc2FnZS50aWNrZXQsXG4gICAgICAgIHBlZXIgPSBtZXNzYWdlLnBlZXIsXG4gICAgICAgIHNlbGYgPSB0aGlzO1xuICAgIHNvY2tldC5vbignY29ubmVjdCcsIGZ1bmN0aW9uKCl7XG4gICAgICAgIGNvbnNvbGUubG9nKCd3cnRjOiBzdWNjZXNzZnVsIGNvbm5lY3Rpb24gZXN0YWJsaXNobWVudCcpO1xuICAgICAgICBzZWxmLnBhcnRpYWxWaWV3LmFkZE5laWdoYm9yKHBlZXIpO1xuICAgICAgICBzZWxmLnNvY2tldHMuYWRkU29ja2V0KHNvY2tldCwgcGVlcik7XG4gICAgICAgIHNlbGYuam9pbihwZWVyKTtcbiAgICAgICAgc2VsZi51cGRhdGVTdGF0ZSgpO1xuICAgIH0pO1xuICAgIHNvY2tldC5vbignZGF0YScsIGZ1bmN0aW9uKHJlY2VpdmVkTWVzc2FnZSl7XG4gICAgICAgIHNlbGYucmVjZWl2ZShzb2NrZXQsIHJlY2VpdmVkTWVzc2FnZSk7XG4gICAgfSk7XG4gICAgc29ja2V0Lm9uKCdzdHJlYW0nLCBmdW5jdGlvbihzdHJlYW0pe1xuICAgICAgICBzZWxmLmVtaXQoJ3N0cmVhbScsIHNvY2tldCwgc3RyZWFtKTtcbiAgICB9KTtcbiAgICBzb2NrZXQub24oJ2Nsb3NlJywgZnVuY3Rpb24oKXtcbiAgICAgICAgY29uc29sZS5sb2coJ3dydGM6IGEgY29ubmVjdGlvbiBoYXMgYmVlbiBjbG9zZWQnKTtcbiAgICAgICAgc2VsZi51cGRhdGVTdGF0ZSgpO1xuICAgIH0pO1xuICAgIHNvY2tldC5zaWduYWwodGlja2V0KTtcbn07XG5cblxuLyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcbiAqIFNwcmF5J3MgcHJvdG9jb2wgaW1wbGVtZW50YXRpb25cbiAqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiovXG5cbi8qIVxuICogXFxicmllZiBqb2luIHRoZSBuZXR3b3JrIHVzaW5nIHRoZSBrd25vbiBjb250YWN0IHBlZXIgXG4gKiBcXHBhcmFtIGNvbnRhY3QgdGhlIGtub3duIHBlZXIgdGhhdCB3aWxsIGludHJvZHVjZSB1cyB0byB0aGUgbmV0d29ya1xuICovXG5TcHJheS5wcm90b3R5cGUuam9pbiA9IGZ1bmN0aW9uKGNvbnRhY3Qpe1xuICAgIC8vICNBIGFzayB0byB0aGUgY29udGFjdCBwZWVyIHRvIGFkdmVydGlzZSB5b3VyIHByZXNlbmNlIGluIHRoZSBuZXR3b3JrXG4gICAgdmFyIG1lc3NhZ2UgPSBuZXcgTUpvaW4oR1VJRCgpKTtcbiAgICB0aGlzLnNlbmQobWVzc2FnZSwgY29udGFjdCk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZXZlbnQgZXhlY3V0ZXIgd2hlbiBcInRoaXNcIiByZWNlaXZlcyBhIGpvaW4gbWVzc2FnZVxuICogXFxwYXJhbSBpZCB0aGUgaWRlbnRpZmllciBvZiB0aGUgcmVxdWVzdFxuICovXG5TcHJheS5wcm90b3R5cGUub25Kb2luID0gZnVuY3Rpb24oaWQpe1xuICAgIC8vICNBIGlmIGl0IGlzIHRoZSB2ZXJ5IGZpcnN0IGNvbm5lY3Rpb24sIGVzdGFibGlzaCBhIGNvbm5lY3Rpb24gZnJvbVxuICAgIC8vIHVzIHRvIHRoZSBuZXdjb21lclxuICAgIGlmICh0aGlzLnBhcnRpYWxWaWV3Lmxlbmd0aCgpPT09MCl7XG4gICAgICAgIHZhciBtUmVxdWVzdFRpY2tldCA9IG5ldyBNUmVxdWVzdFRpY2tldChHVUlEKCkpO1xuICAgICAgICB0aGlzLnNlbmQobVJlcXVlc3RUaWNrZXQsIHtpZDppZH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIC8vICNCIGlmIHRoZXJlIGlzIGFuIGFscmVhZHkgZXN0YWJsaXNoZWQgbmV0d29yaywgd2UgcmVxdWVzdCB0aGF0XG4gICAgICAgIC8vIHRoZSBuZXdjb21lciBzZW5kcyB1cyBhbiBvZmZlciB0aWNrZXQgZm9yIGVhY2ggb2Ygb3VyIG5laWdoYm9yc1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMucGFydGlhbFZpZXcubGVuZ3RoKCk7ICsraSl7XG4gICAgICAgICAgICAvLyAjMSBjcmVhdGUgdGhlIHRpY2tldCB3aXRoIGFuIG9yaWdpbmFsIGlkZW50aWZpZXJcbiAgICAgICAgICAgIHZhciBtUmVxdWVzdFRpY2tldCA9IG5ldyBNUmVxdWVzdFRpY2tldChHVUlEKCkpO1xuICAgICAgICAgICAgLy8gIzIgcmVnaXN0ZXIgdGhlIGZvcndhcmRpbmcgcm91dGUgZm9yIHRoZSBhbnN3ZXJzXG4gICAgICAgICAgICB0aGlzLmZvcndhcmRzLmFkZFNvY2tldChcbiAgICAgICAgICAgICAgICB0aGlzLnNvY2tldHMuZ2V0U29ja2V0KHRoaXMucGFydGlhbFZpZXcuYXJyYXkuYXJyW2ldKSxcbiAgICAgICAgICAgICAgICBtUmVxdWVzdFRpY2tldCk7XG4gICAgICAgICAgICAvLyAjMyBzZW5kIHRoZSByZXF1ZXN0IHRvIHRoZSBuZXcgY29tZXJcbiAgICAgICAgICAgIHRoaXMuc2VuZChtUmVxdWVzdFRpY2tldCwge2lkOmlkfSk7XG4gICAgICAgIH07XG4gICAgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiBwZXJpb2RpY2FsbHkgY2FsbGVkIGZ1bmN0aW9uIHRoYXQgYWltcyB0byBiYWxhbmNlIHRoZSBwYXJ0aWFsIHZpZXdcbiAqIGFuZCB0byBtaXggdGhlIG5laWdoYm9ycyBpbnNpZGUgdGhlbVxuICovXG5TcHJheS5wcm90b3R5cGUuZXhjaGFuZ2UgPSBmdW5jdGlvbigpe1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICB2YXIgc29ja2V0T2xkZXN0ID0gbnVsbDtcbiAgICAvLyAjMSBnZXQgdGhlIG9sZGVzdCBuZWlnaGJvciByZWFjaGFibGVcbiAgICB3aGlsZSAoKHNvY2tldE9sZGVzdD09PW51bGwpIHx8XG4gICAgICAgICAgIChzb2NrZXRPbGRlc3QhPT1udWxsICYmICFzb2NrZXRPbGRlc3QuY29ubmVjdGVkKSAmJlxuICAgICAgICAgICB0aGlzLnBhcnRpYWxWaWV3Lmxlbmd0aCgpPjApe1xuICAgICAgICB2YXIgb2xkZXN0ID0gdGhpcy5wYXJ0aWFsVmlldy5nZXRPbGRlc3QoKTtcbiAgICAgICAgc29ja2V0T2xkZXN0ID0gdGhpcy5zb2NrZXRzLmdldFNvY2tldChvbGRlc3QpO1xuICAgICAgICBpZiAoc29ja2V0T2xkZXN0PT09bnVsbCB8fFxuICAgICAgICAgICAgKHNvY2tldE9sZGVzdCE9PW51bGwgJiYgIXNvY2tldE9sZGVzdC5jb25uZWN0ZWQpKSB7XG4gICAgICAgICAgICB0aGlzLm9uUGVlckRvd24ob2xkZXN0KTtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIGlmICh0aGlzLnBhcnRpYWxWaWV3Lmxlbmd0aCgpPT09MCl7cmV0dXJuO307IC8vIHVnbHkgcmV0dXJuXG4gICAgLy8gIzIgbm90aWZ5IHRoZSBvbGRlc3QgbmVpZ2hib3IgdGhhdCBpdCBpcyB0aGUgY2hvc2VuIG9uZVxuICAgIHZhciBtRXhjaGFuZ2UgPSBuZXcgTUV4Y2hhbmdlKEdVSUQoKSwge2lkOnRoaXMuSUR9KTtcbiAgICB0aGlzLnNlbmQobUV4Y2hhbmdlLCBvbGRlc3QpO1xuICAgIC8vICMzIGdldCBhIHNhbXBsZSBmcm9tIG91ciBwYXJ0aWFsIHZpZXdcbiAgICB2YXIgc2FtcGxlID0gdGhpcy5wYXJ0aWFsVmlldy5nZXRTYW1wbGUob2xkZXN0LCB0cnVlKTtcbiAgICAvLyAjNCBhc2sgdG8gdGhlIG5laWdoYm9ycyBpbiB0aGUgc2FtcGxlIHRvIGNyZWF0ZSB0aGUgb2ZmZXIgdGlja2V0cyBpblxuICAgIC8vIG9yZGVyIHRvIGZvcndhcmQgdGhlbSB0byB0aGUgb2xkZXN0IG5laWdoYm9yXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzYW1wbGUubGVuZ3RoOyArK2kpe1xuICAgICAgICBpZiAoc2FtcGxlW2ldLmlkICE9PSBvbGRlc3QuaWQpe1xuICAgICAgICAgICAgLy8gIzUgaWYgdGhlIG5laWdoYm9yIGlzIG5vdCB0aGUgb2xkZXN0IG5laWdoYm9yXG4gICAgICAgICAgICAvLyAjNUEgcmVnaXN0ZXIgdGhlIGZvcndhcmRpbmcgZGVzdGluYXRpb25cbiAgICAgICAgICAgIHZhciBtZXNzYWdlID0gbmV3IE1SZXF1ZXN0VGlja2V0KEdVSUQoKSk7XG4gICAgICAgICAgICB0aGlzLmZvcndhcmRzLmFkZFNvY2tldCh0aGlzLnNvY2tldHMuZ2V0U29ja2V0KG9sZGVzdCksbWVzc2FnZSk7XG4gICAgICAgICAgICAvLyAjNUIgc2VuZCBhIHRpY2tldCByZXF1ZXN0IHRvIHRoZSBuZWlnaGJvciBpbiB0aGUgc2FtcGxlXG4gICAgICAgICAgICB0aGlzLnNlbmQobWVzc2FnZSwgc2FtcGxlW2ldKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vICM2IG90aGVyd2lzZSwgY3JlYXRlIGFuIG9mZmVyIHRpY2tldCBvdXJzZWxmIGFuZCBzZW5kIGl0IHRvIHRoZVxuICAgICAgICAgICAgLy8gb2xkZXN0IG5laWdiaG9yXG4gICAgICAgICAgICB2YXIgaWRUaWNrZXQgPSBHVUlEKCk7XG4gICAgICAgICAgICB0aGlzLmZvcndhcmRzLmFkZFNvY2tldCh0aGlzLnNvY2tldHMuZ2V0U29ja2V0KG9sZGVzdCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7aWQ6aWRUaWNrZXR9KTtcbiAgICAgICAgICAgIHRoaXMub25UaWNrZXRSZXF1ZXN0KGlkVGlja2V0KTtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIC8vICM3IHJlbW92ZSB0aGUgc2VudCBzYW1wbGUgZnJvbSBvdXIgcGFydGlhbCB2aWV3XG4gICAgdGhpcy5wYXJ0aWFsVmlldy5yZW1vdmVTYW1wbGUoc2FtcGxlKTtcbiAgICAvLyAjOCByZW1vdmUgZnJvbSB0aGUgc29ja2V0cyBkaWN0aW9ubmFyeVxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc2FtcGxlLmxlbmd0aDsgKytpKXtcbiAgICAgICAgLy8gIzhBIGNoZWNrIGlmIHRoZSBwYXJ0aWFsIHZpZXcgc3RpbGwgY29udGFpbnMgcmVmZXJlbmNlcyB0byB0aGUgc29ja2V0XG4gICAgICAgIGlmICghdGhpcy5wYXJ0aWFsVmlldy5jb250YWlucyhzYW1wbGVbaV0pKXtcbiAgICAgICAgICAgIC8vICM4QiBvdGhlcndpc2UgcmVtb3ZlIHRoZSBzb2NrZXQgZnJvbSB0aGUgZGljdGlvbm5hcnlcbiAgICAgICAgICAgIHZhciBzb2NrZXQgPSB0aGlzLnNvY2tldHMucmVtb3ZlU29ja2V0KHNhbXBsZVtpXSk7XG4gICAgICAgICAgICAvLyAjOEMgY2xvc2UgdGhlIHNvY2tldCBhZnRlciBhIHdoaWxlXG4gICAgICAgICAgICBpZiAoc29ja2V0IT09bnVsbCl7XG4gICAgICAgICAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbihzKXtcbiAgICAgICAgICAgICAgICAgICAgcy5kZXN0cm95KCk7XG4gICAgICAgICAgICAgICAgfSwgdGhpcy5USU1FT1VULCBzb2NrZXQpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfTtcbiAgICB9OyAgICBcbn07XG5cbi8qIVxuICogXFxicmllZiBldmVudCBleGVjdXRlZCB3aGVuIHdlIHJlY2VpdmUgYW4gZXhjaGFuZ2UgcmVxdWVzdFxuICogXFxwYXJhbSBpZCB0aGUgaWRlbnRpZmllciBvZiB0aGUgcmVxdWVzdCBtZXNzYWdlXG4gKiBcXHBhcmFtIGluaXRpYXRvciB0aGUgcGVlciB0aGF0IHJlcXVlc3RlZCB0aGUgZXhjaGFuZ2VcbiAqL1xuU3ByYXkucHJvdG90eXBlLm9uRXhjaGFuZ2UgPSBmdW5jdGlvbihpZCwgaW5pdGlhdG9yKXtcbiAgICAvLyAjMSBnZXQgYSBzYW1wbGUgb2YgbmVpZ2hib3JzIGZyb20gb3VyIHBhcnRpYWwgdmlld1xuICAgIHZhciBzYW1wbGUgPSB0aGlzLnBhcnRpYWxWaWV3LmdldFNhbXBsZShpbml0aWF0b3IsIGZhbHNlKTtcbiAgICAvLyAjMiBhc2sgdG8gZWFjaCBuZWlnaGJvciBpbiB0aGUgc2FtcGxlIHRvIGNyZWF0ZSBhbiBvZmZlciB0aWNrZXQgdG9cbiAgICAvLyBnaXZlIHRvIHRoZSBpbml0aWF0b3IgcGVlclxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc2FtcGxlLmxlbmd0aDsgKytpKXtcbiAgICAgICAgaWYgKHNhbXBsZVtpXS5pZCAhPT0gaW5pdGlhdG9yLmlkKXtcbiAgICAgICAgICAgIC8vICMyQSBpZiB0aGUgbmVpZ2Job3IgaXMgbm90IHRoZSBpbml0aWF0b3IsIHJlcXVlc3QgYW4gb2ZmZXIgdGlja2V0XG4gICAgICAgICAgICAvLyBmcm9tIGl0XG4gICAgICAgICAgICB2YXIgbWVzc2FnZSA9IG5ldyBNUmVxdWVzdFRpY2tldChHVUlEKCkpO1xuICAgICAgICAgICAgLy8gIzJCIHJlZ2lzdGVyIHRoZSBmb3J3YXJkaW5nIHJvdXRlXG4gICAgICAgICAgICB0aGlzLmZvcndhcmRzLmFkZFNvY2tldCh0aGlzLmZvcndhcmRzLmdldFNvY2tldCh7aWQ6aWR9KSwgbWVzc2FnZSk7XG4gICAgICAgICAgICAvLyAjMkMgc2VuZCB0aGUgdGlja2V0IHJlcXVlc3QgdG8gdGhlIG5laWdiaG9yXG4gICAgICAgICAgICB0aGlzLnNlbmQobWVzc2FnZSwgc2FtcGxlW2ldKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vICMzQSBpZiB0aGUgbmVpZ2Job3IgaXMgdGhlIGluaXRpYXRvciwgY3JlYXRlIGFuIG9mZmVyIHRpY2tldFxuICAgICAgICAgICAgLy8gb3Vyc2VsZiAgICAgICAgICAgIFxuICAgICAgICAgICAgdmFyIGlkVGlja2V0ID0gR1VJRCgpO1xuICAgICAgICAgICAgLy8gIzNCIHJlZ2lzdGVyIHRoZSBmb3J3YXJkaW5nIHJvdXRlIGZvciBvdXIgb3duIG9mZmVyIHRpY2tldFxuICAgICAgICAgICAgdGhpcy5mb3J3YXJkcy5hZGRTb2NrZXQodGhpcy5mb3J3YXJkcy5nZXRTb2NrZXQoe2lkOmlkfSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7aWQ6aWRUaWNrZXR9KTtcbiAgICAgICAgICAgIC8vICMzQyBjcmVhdGUgdGhlIG9mZmVyIHRpY2tldCBhbmQgc2VuZCBpdFxuICAgICAgICAgICAgdGhpcy5vblRpY2tldFJlcXVlc3QoaWRUaWNrZXQpO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgLy8gIzQgcmVtb3ZlIHRoZSBzYW1wbGUgZnJvbSBvdXIgcGFydGlhbCB2aWV3XG4gICAgdGhpcy5wYXJ0aWFsVmlldy5yZW1vdmVTYW1wbGUoc2FtcGxlKTtcbiAgICAvLyAjNSByZW1vdmUgdGhlIHNhbXBsZSBmcm9tIHRoZSBzb2NrZXRzIGRpY3Rpb25uYXJ5XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzYW1wbGUubGVuZ3RoOyArK2kpe1xuICAgICAgICAvLyAjNUEgY2hlY2sgaWYgdGhlIHBhcnRpYWwgdmlldyBzdGlsbCBjb250YWlucyByZWZlcmVuY2VzIHRvIHRoZSBzb2NrZXRcbiAgICAgICAgaWYgKCF0aGlzLnBhcnRpYWxWaWV3LmNvbnRhaW5zKHNhbXBsZVtpXSkpe1xuICAgICAgICAgICAgLy8gIzVCIG90aGVyd2lzZSByZW1vdmUgdGhlIHNvY2tldCBmcm9tIHRoZSBkaWN0aW9ubmFyeVxuICAgICAgICAgICAgdmFyIHNvY2tldCA9IHRoaXMuc29ja2V0cy5yZW1vdmVTb2NrZXQoc2FtcGxlW2ldKVxuICAgICAgICAgICAgLy8gIzVDIGNsb3NlIHRoZSBzb2NrZXQgYWZ0ZXIgYSB3aGlsZVxuICAgICAgICAgICAgaWYgKHNvY2tldCE9PW51bGwpe1xuICAgICAgICAgICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24ocyl7XG4gICAgICAgICAgICAgICAgICAgIHMuZGVzdHJveSgpO1xuICAgICAgICAgICAgICAgIH0sIHRoaXMuVElNRU9VVCwgc29ja2V0KTtcbiAgICAgICAgICAgIH07XG4gICAgICAgIH07XG4gICAgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiB0aGUgZnVuY3Rpb24gY2FsbGVkIHdoZW4gYSBuZWlnaGJvciBpcyB1bnJlYWNoYWJsZSBhbmQgc3VwcG9zZWRseVxuICogY3Jhc2hlZC9kZXBhcnRlZC4gSXQgcHJvYmFiaWxpc3RpY2FsbHkga2VlcHMgYW4gYXJjIHVwXG4gKiBcXHBhcmFtIHBlZXIgdGhlIHBlZXIgdGhhdCBjYW5ub3QgYmUgcmVhY2hlZFxuICovXG5TcHJheS5wcm90b3R5cGUub25QZWVyRG93biA9IGZ1bmN0aW9uKHBlZXIpe1xuICAgIGNvbnNvbGUubG9nKCd3cnRjOiBhIG5laWdoYm9yIGNyYXNoZWQvbGVmdCcpO1xuICAgIC8vICNBIHJlbW92ZSBhbGwgb2NjdXJyZW5jZXMgb2YgdGhlIHBlZXIgaW4gdGhlIHBhcnRpYWwgdmlld1xuICAgIHZhciBvY2MgPSB0aGlzLnBhcnRpYWxWaWV3LnJlbW92ZUFsbChwZWVyKTtcbiAgICB0aGlzLnNvY2tldHMucmVtb3ZlU29ja2V0KHBlZXIpO1xuICAgIC8vICNCIHByb2JhYmlsaXN0aWNhbGx5IHJlY3JlYXRlIGFuIGFyYyB0byBhIGtub3duIHBlZXJcbiAgICBpZiAodGhpcy5wYXJ0aWFsVmlldy5sZW5ndGgoKSA+IDApe1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IG9jYzsgKytpKXtcbiAgICAgICAgICAgIGlmIChNYXRoLnJhbmRvbSgpID4gKDEvKHRoaXMucGFydGlhbFZpZXcubGVuZ3RoKCkrb2NjKSkpe1xuICAgICAgICAgICAgICAgIHZhciBybiA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSp0aGlzLnBhcnRpYWxWaWV3Lmxlbmd0aCgpKTtcbiAgICAgICAgICAgICAgICB0aGlzLnBhcnRpYWxWaWV3LmFkZE5laWdoYm9yKHRoaXMucGFydGlhbFZpZXcuYXJyYXkuYXJyW3JuXSk7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coJ3dydGM6IGNyZWF0ZSBhIGR1cGxpY2F0ZScpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIHRoaXMudXBkYXRlU3RhdGUoKTtcbn07XG5cbi8qIVxuICogXFxicmllZiBhIGNvbm5lY3Rpb24gZmFpbGVkIHRvIGVzdGFibGlzaCBwcm9wZXJseSwgc3lzdGVtYXRpY2FsbHkgZHVwbGljYXRlc1xuICogYW4gZWxlbWVudCBvZiB0aGUgcGFydGlhbCB2aWV3LlxuICovXG5TcHJheS5wcm90b3R5cGUub25BcmNEb3duID0gZnVuY3Rpb24oKXtcbiAgICBjb25zb2xlLmxvZygnd3J0YzogYW4gYXJjIGRpZCBub3QgcHJvcGVybHkgZXN0YWJsaXNoZWQnKTtcbiAgICBpZiAodGhpcy5wYXJ0aWFsVmlldy5sZW5ndGgoKT4wKXtcbiAgICAgICAgdmFyIHJuID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKnRoaXMucGFydGlhbFZpZXcubGVuZ3RoKCkpO1xuICAgICAgICB0aGlzLnBhcnRpYWxWaWV3LmFkZE5laWdoYm9yKHRoaXMucGFydGlhbFZpZXcuYXJyYXkuYXJyW3JuXSk7XG4gICAgfTtcbiAgICB0aGlzLnVwZGF0ZVN0YXRlKCk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgV2ViUlRDIHNwZWNpZmljIGV2ZW50LiBBIG5laWdoYm9yIHdhbnRzIHVzIHRvIGNvbm5lY3QgdG8gYW5vdGhlciBwZWVyLlxuICogVG8gZG8gc28sIHRoZSBmb3JtZXIgcmVxdWVzdHMgYW4gb2ZmZXIgdGlja2V0IGl0IGNhbiBleGNoYW5nZSB3aXRoIG9uZSBvZlxuICogaXRzIG5laWdoYm9yLlxuICogXFxwYXJhbSBwZWVyIHRoZSBpZGVudGlmaWVyIG9mIHRoZSByZXF1ZXN0IG1lc3NhZ2VcbiAqL1xuU3ByYXkucHJvdG90eXBlLm9uVGlja2V0UmVxdWVzdCA9IGZ1bmN0aW9uKGlkKXtcbiAgICB2YXIgb3B0aW9ucz10aGlzLk9QVElPTlM7IG9wdGlvbnMuaW5pdGlhdG9yPXRydWU7IG9wdGlvbnMudHJpY2tsZT1mYWxzZTtcbiAgICB2YXIgc29ja2V0ID0gbmV3IFNvY2tldChvcHRpb25zKSxcbiAgICAgICAgc2VsZiA9IHRoaXM7XG4gICAgLy8gIzEgZ2V0IHRoZSBvZmZlciB0aWNrZXQgZnJvbSB0aGUgc3R1biBzZXJ2aWNlICAgIFxuICAgIHNvY2tldC5vbignc2lnbmFsJywgZnVuY3Rpb24oZGF0YSl7XG4gICAgICAgIC8vICNBIHJlZ2lzdGVyIHRoaXMgc29ja2V0IGluIHBlbmRpbmcgc29ja2V0cyBkaWN0aW9ubmFyeVxuICAgICAgICB2YXIgbWVzc2FnZSA9IG5ldyBNT2ZmZXJUaWNrZXQoaWQsIGRhdGEsIHtpZDogc2VsZi5JRH0pO1xuICAgICAgICBzZWxmLnBlbmRpbmcuYWRkU29ja2V0KHNvY2tldCwgbWVzc2FnZSk7XG4gICAgICAgIC8vICNCIHNlbmQgdGhlIG9mZmVyIHRpY2tldCB0byB0aGUgcmVxdWVzdGVyIGFsb25nIHdpdGggb3VyIGlkZW50aWZpZXJcbiAgICAgICAgc2VsZi5zZW5kKG1lc3NhZ2UsIG1lc3NhZ2UpO1xuICAgICAgICAvLyAjQyByZW1vdmUgdGhlIGZvcndhcmRpbmcgcm91dGUgXG4gICAgICAgIHNlbGYuZm9yd2FyZHMucmVtb3ZlU29ja2V0KG1lc3NhZ2UpO1xuICAgIH0pO1xuICAgIC8vICMyIHN1Y2Nlc3NmdWwgY29ubmVjdGlvbiBlc3RhYmxpc2htZW50XG4gICAgc29ja2V0Lm9uKCdjb25uZWN0JywgZnVuY3Rpb24oKXtcbiAgICAgICAgY29uc29sZS5sb2coJ3dydGM6IHN1Y2Nlc3NmdWwgY29ubmVjdGlvbiBlc3RhYmxpc2htZW50Jyk7XG4gICAgICAgIC8vICNBIHJlbW92ZSBmcm9tIHRoZSBwZW5kaW5nIHNvY2tldHMgZGljdGlvbm5hcnlcbiAgICAgICAgc2VsZi5wZW5kaW5nLnJlbW92ZVNvY2tldCh7aWQ6aWR9KTtcbiAgICB9KTtcbiAgICAvLyAjMyBjbG9zZWQgY29ubmVjdGlvblxuICAgIHNvY2tldC5vbignY2xvc2UnLCBmdW5jdGlvbigpe1xuICAgICAgICBjb25zb2xlLmxvZygnd3J0YzogYSBjb25uZWN0aW9uIGhhcyBiZWVuIGNsb3NlZCcpO1xuICAgIH0pO1xuICAgIC8vICM0IHJlY2VpdmUgYSBtZXNzYWdlXG4gICAgc29ja2V0Lm9uKCdkYXRhJywgZnVuY3Rpb24obWVzc2FnZSl7XG4gICAgICAgIHNlbGYucmVjZWl2ZShzb2NrZXQsIG1lc3NhZ2UpO1xuICAgIH0pO1xuICAgIHNvY2tldC5vbignc3RyZWFtJywgZnVuY3Rpb24oc3RyZWFtKXtcbiAgICAgICAgc2VsZi5lbWl0KCdzdHJlYW0nLCBzb2NrZXQsIHN0cmVhbSk7XG4gICAgfSk7XG4gICAgXG4gICAgLy8gIzUgdGltZW91dCBvbiBjb25uZWN0aW9uIGVzdGFibGlzaG1lbnRcbiAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7XG4gICAgICAgIC8vICNBIGNoZWNrIGlmIGl0IHRoZSBjb25uZWN0aW9uIGVzdGFibGlzaGVkLCBvdGhlcndpc2UsIGNsZWFuIHNvY2tldFxuICAgICAgICBpZiAoc2VsZi5wZW5kaW5nLmNvbnRhaW5zKHtpZDppZH0pKXtcbiAgICAgICAgICAgIHNlbGYucGVuZGluZy5yZW1vdmVTb2NrZXQoe2lkOmlkfSk7XG4gICAgICAgICAgICBzb2NrZXQuZGVzdHJveSgpO1xuICAgICAgICB9O1xuICAgIH0sIHRoaXMuVElNRU9VVCk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgV2ViUlRDIHNwZWNpZmljIGV2ZW50LiBBIG5laWdoYm9yIHNlbnQgYSB0aWNrZXQgdG8gc3RhbXAuIFdlIG11c3RcbiAqIHN0YW1wIGl0IGJhY2sgdG8gZXN0YWJsaXNoIGEgY29ubmVjdGlvbi5cbiAqIFxccGFyYW0gaWQgdGhlIGlkZW50aWZpZXIgb2YgdGhlIG1lc3NhZ2UgY2FycnlpbmcgdGhlIG9mZmVyIHRpY2tldFxuICogXFxwYXJhbSB0aWNrZXQgdGhlIG9mZmVyIHRpY2tldCB0byBzdGFtcFxuICogXFxwYXJhbSBwZWVyIHRoZSBlbWl0dGluZyBwZWVyIGNvbnRhaW5pbmcgaXRzIGlkZW50aWZpZXJcbiAqL1xuU3ByYXkucHJvdG90eXBlLm9uU3RhbXBlZFRpY2tldFJlcXVlc3QgPSBmdW5jdGlvbihpZCwgdGlja2V0LCBwZWVyKXtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgLy8gIzEgaWYgdGhlIHBhcnRpYWwgdmlldyBhbHJlYWR5IGNvbnRhaW5zIHRoaXMgbmVpZ2Job3IsIGR1cGxpY2F0ZSB0aGVcbiAgICAvLyBlbnRyeSBhbmQgc3RvcCB0aGUgcHJvY2Vzc3VzXG4gICAgaWYgKHRoaXMucGFydGlhbFZpZXcuY29udGFpbnMocGVlcikpe1xuICAgICAgICBjb25zb2xlLmxvZyhcIndydGM6IGNyZWF0ZSBhIGR1cGxpY2F0ZVwiKTtcbiAgICAgICAgdGhpcy5wYXJ0aWFsVmlldy5hZGROZWlnaGJvcihwZWVyKTtcbiAgICAgICAgLy8gIzIgc2VuZCBhbiBlbXB0eSBzdGFtcGVkIHRpY2tldCB0byBjbG9zZSB0aGUgcGVuZGluZyBhbmQgZm9yd2FyZGluZ3NcbiAgICAgICAgdmFyIG1lc3NhZ2UgPSBuZXcgTVN0YW1wZWRUaWNrZXQoaWQsIG51bGwsIHtpZDpzZWxmLklEfSk7XG4gICAgICAgIHNlbGYuc2VuZChtZXNzYWdlLCBtZXNzYWdlKTtcbiAgICAgICAgc2VsZi5mb3J3YXJkcy5yZW1vdmVTb2NrZXQoe2lkOmlkfSk7XG4gICAgICAgIHJldHVybjsgLy8gZG8gbm90aGluZyBlbHNlLiBVZ2x5IHJldHVyblxuICAgIH07XG4gICAgLy8gIzIgb3RoZXJ3aXNlIGNyZWF0ZXMgYW4gYW5zd2VyXG4gICAgdmFyIG9wdGlvbnM9dGhpcy5PUFRJT05TOyBvcHRpb25zLmluaXRpYXRvcj1mYWxzZTsgb3B0aW9ucy50cmlja2xlPWZhbHNlO1xuICAgIHZhciBzb2NrZXQgPSBuZXcgU29ja2V0KG9wdGlvbnMpO1xuICAgIC8vICMzIGdldCB0aGUgc3RhbXBlZCB0aWNrZXQgZnJvbSB0aGUgc3R1biBzZXJ2aWNlXG4gICAgc29ja2V0Lm9uKCdzaWduYWwnLCBmdW5jdGlvbihkYXRhKXtcbiAgICAgICAgLy8gI0EgY3JlYXRlIHRoZSBtZXNzYWdlIGNvbnRhaW5pbmcgdGhlIHN0YW1wZWQgdGlja2V0XG4gICAgICAgIHZhciBtZXNzYWdlID0gbmV3IE1TdGFtcGVkVGlja2V0KGlkLCBkYXRhLCB7aWQ6c2VsZi5JRH0pO1xuICAgICAgICAvLyAjQiBzZW5kIGl0IGJhY2sgZnJvbSB3aGVyZSBpdCBhcnJpdmVzXG4gICAgICAgIHNlbGYuc2VuZChtZXNzYWdlLCBtZXNzYWdlKTtcbiAgICAgICAgLy8gI0MgcmVtb3ZlIHRoZSBmb3J3YXJkaW5nIHJvdXRlXG4gICAgICAgIHNlbGYuZm9yd2FyZHMucmVtb3ZlU29ja2V0KG1lc3NhZ2UpO1xuICAgIH0pO1xuICAgIC8vICM0IHN1Y2Nlc3NmdWwgY29ubmVjdGlvbiBlc3RhYmxpc2htZW50XG4gICAgc29ja2V0Lm9uKCdjb25uZWN0JywgZnVuY3Rpb24oKXtcbiAgICAgICAgY29uc29sZS5sb2coJ3dydGM6IHN1Y2Nlc3NmdWwgY29ubmVjdGlvbiBlc3RhYmxpc2htZW50Jyk7XG4gICAgICAgIC8vICNBIHJlbW92ZSBmcm9tIHBlbmRpbmdcbiAgICAgICAgc2VsZi5wZW5kaW5nLnJlbW92ZVNvY2tldCh7aWQ6aWR9KTsgICAgICAgIFxuICAgICAgICAvLyAjQiBhZGQgdGhlIG5laWdiaG9yIHRvIG91ciBwYXJ0aWFsIHZpZXdcbiAgICAgICAgc2VsZi5wYXJ0aWFsVmlldy5hZGROZWlnaGJvcihwZWVyKTtcbiAgICAgICAgLy8gI0MgYWRkIHRoZSBuZWlnYmhvciB0byB0aGUgc29ja2V0IGRpY3Rpb25uYXJ5LCBpZiBpdCBkb2VzIG5vdCBleGlzdFxuICAgICAgICBpZiAoIXNlbGYuc29ja2V0cy5hZGRTb2NrZXQoc29ja2V0LCBwZWVyKSl7XG4gICAgICAgICAgICBzb2NrZXQuZGVzdHJveSgpO1xuICAgICAgICB9O1xuICAgICAgICBzZWxmLnVwZGF0ZVN0YXRlKCk7XG4gICAgfSk7XG4gICAgLy8gIzUgY2xvc2VkIGNvbm5lY3Rpb25cbiAgICBzb2NrZXQub24oJ2Nsb3NlJywgZnVuY3Rpb24oKXtcbiAgICAgICAgY29uc29sZS5sb2coJ3dydGM6IGEgY29ubmVjdGlvbiBoYXMgYmVlbiBjbG9zZWQnKTtcbiAgICAgICAgc2VsZi51cGRhdGVTdGF0ZSgpO1xuICAgIH0pO1xuICAgIC8vICM2IHJlY2VpdmUgYSBtZXNzYWdlXG4gICAgc29ja2V0Lm9uKCdkYXRhJywgZnVuY3Rpb24obWVzc2FnZSl7XG4gICAgICAgIHNlbGYucmVjZWl2ZShzb2NrZXQsIG1lc3NhZ2UpO1xuICAgIH0pO1xuICAgIHNvY2tldC5vbignc3RyZWFtJywgZnVuY3Rpb24oc3RyZWFtKXtcbiAgICAgICAgc2VsZi5lbWl0KCdzdHJlYW0nLCBzb2NrZXQsIHN0cmVhbSk7XG4gICAgfSk7XG4gICAgLy8gIzcgc2lnbmFsIHRoZSBvZmZlciB0aWNrZXQgdG8gdGhlIGZyZXNoIHNvY2tldFxuICAgIHNvY2tldC5zaWduYWwodGlja2V0KTtcbiAgICB0aGlzLnBlbmRpbmcuYWRkU29ja2V0KHNvY2tldCwge2lkOmlkfSk7XG4gICAgLy8gIzggYSB0aW1lb3V0IG9uIGNvbm5lY3Rpb24gZXN0YWJsaXNobWVudFxuICAgIHNldFRpbWVvdXQoZnVuY3Rpb24oKXtcbiAgICAgICAgaWYgKHNlbGYucGVuZGluZy5jb250YWlucyh7aWQ6aWR9KSl7XG4gICAgICAgICAgICAvLyAjQSBpZiB0aGUgY29ubmVjdGlvbiBpcyBub3Qgc3VjY2Vzc2Z1bCwgcmVtb3ZlIHRoZSBzb2NrZXQgYW5kXG4gICAgICAgICAgICAvLyBjcmVhdGUgYSBkdXBsaWNhdGVcbiAgICAgICAgICAgIHNlbGYucGVuZGluZy5yZW1vdmVTb2NrZXQoe2lkOmlkfSk7XG4gICAgICAgICAgICBzb2NrZXQuZGVzdHJveSgpO1xuICAgICAgICAgICAgc2VsZi5vbkFyY0Rvd24oKTtcbiAgICAgICAgfTtcbiAgICB9LCB0aGlzLlRJTUVPVVQpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHNlbmQgYSBtZXNzYWdlIHRvIGEgcGFydGljdWxhciBwZWVyLiBJZiBubyBwZWVyIGFyZSBwYXNzZWQgaW5cbiAqIGFyZ3VtZW50cywgaXQgd2lsbCB0cnkgdG8gZm9yd2FyZHMgaXQgdGhlIGFwcHJvcHJpYXRlIHBlZXIuXG4gKiBcXHBhcmFtIG1lc3NhZ2UgdGhlIG1lc3NhZ2UgdG8gc2VuZFxuICogXFxwYXJhbSBvYmplY3QgdGhlIG9iamVjdCBjb250YWluaW5nIHRoZSBpZCB0byBzZW5kIHRoZSBtZXNzYWdlXG4gKiBcXHBhcmFtIHJldHVybiB0cnVlIGlmIHRoZSBtZXNzYWdlIGFzIGJlZW4gc2VudCwgZmFsc2Ugb3RoZXJ3aXNlXG4gKi9cblNwcmF5LnByb3RvdHlwZS5zZW5kID0gZnVuY3Rpb24obWVzc2FnZSwgb2JqZWN0KXtcbiAgICB2YXIgc2VudCA9IGZhbHNlO1xuICAgIHZhciBpZCA9IChvYmplY3QgJiYgb2JqZWN0LmlkKSB8fCBtZXNzYWdlLmlkO1xuICAgIHZhciBzb2NrZXQgPSB0aGlzLnNvY2tldHMuZ2V0U29ja2V0KHtpZDppZH0pO1xuICAgIGlmIChzb2NrZXQgIT09IG51bGwpe1xuICAgICAgICBpZiAoc29ja2V0LmNvbm5lY3RlZCAmJlxuICAgICAgICAgICAgc29ja2V0Ll9jaGFubmVsICYmIHNvY2tldC5fY2hhbm5lbC5yZWFkeVN0YXRlID09PSAnb3Blbicpe1xuICAgICAgICAgICAgc29ja2V0LnNlbmQobWVzc2FnZSk7XG4gICAgICAgICAgICBzZW50ID0gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMub25QZWVyRG93bih7aWQ6aWR9KTsgICAgICAgICAgICBcbiAgICAgICAgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBzb2NrZXQgPSB0aGlzLmZvcndhcmRzLmdldFNvY2tldCh7aWQ6aWR9KTtcbiAgICAgICAgaWYgKHNvY2tldCAhPT0gbnVsbCAmJiBzb2NrZXQuY29ubmVjdGVkICYmXG4gICAgICAgICAgICBzb2NrZXQuX2NoYW5uZWwgJiYgc29ja2V0Ll9jaGFubmVsLnJlYWR5U3RhdGUgPT09ICdvcGVuJyl7XG4gICAgICAgICAgICBzb2NrZXQuc2VuZChtZXNzYWdlKTtcbiAgICAgICAgICAgIHNlbnQgPSB0cnVlO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgcmV0dXJuIHNlbnQ7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgcmVjZWl2ZSBhIG1lbWJlcnNoaXAgbWVzc2FnZSBhbmQgcHJvY2VzcyBpdCBhY2NvcmRpbmdseVxuICogXFxwYXJhbSBzb2NrZXQgdGhlIHNvY2tldCBmcm9tIHdoaWNoIHdlIHJlY2VpdmUgdGhlIG1lc3NhZ2VcbiAqIFxccGFyYW0gbWVzc2FnZSB0aGUgcmVjZWl2ZWQgbWVzc2FnZVxuICovXG5TcHJheS5wcm90b3R5cGUucmVjZWl2ZSA9IGZ1bmN0aW9uKHNvY2tldCwgbWVzc2FnZSl7XG4gICAgaWYgKG1lc3NhZ2UgJiYgbWVzc2FnZS5wcm90b2NvbCl7XG4gICAgICAgIHRoaXMuZW1pdChtZXNzYWdlLnByb3RvY29sKyctcmVjZWl2ZScsIHNvY2tldCwgbWVzc2FnZSk7XG4gICAgfTtcbn07XG5cblNwcmF5LnByb3RvdHlwZS5vblNwcmF5UmVjZWl2ZSA9IGZ1bmN0aW9uKHNvY2tldCwgbWVzc2FnZSl7XG4gICAgc3dpdGNoIChtZXNzYWdlLnR5cGUpe1xuICAgIGNhc2UgJ01Kb2luJzpcbiAgICAgICAgY29uc29sZS5sb2coJ3dydGM6IGEgbmV3IG1lbWJlciBqb2lucyB0aGUgbmV0d29yaycpO1xuICAgICAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24oKXtcbiAgICAgICAgICAgIHNlbGYuZm9yd2FyZHMuYWRkU29ja2V0KHNvY2tldCwgbWVzc2FnZSk7XG4gICAgICAgICAgICBzZWxmLm9uSm9pbihtZXNzYWdlLmlkKTtcbiAgICAgICAgICAgIHNlbGYuZm9yd2FyZHMucmVtb3ZlU29ja2V0KG1lc3NhZ2UpO1xuICAgICAgICB9LCAxMDAwKTsgLy8gbWFrZSBzdXJlIHRoYXQgdGhlIHNvY2tldCBpcyB1bmRvdWJ0ZWRseSBvcGVuZWRcbiAgICAgICAgYnJlYWs7XG4gICAgY2FzZSAnTVJlcXVlc3RUaWNrZXQnOlxuICAgICAgICBjb25zb2xlLmxvZygnd3J0YzogYSBtZW1iZXIgcmVxdWVzdCBhbiBvZmZlciB0aWNrZXQnKTtcbiAgICAgICAgdGhpcy5mb3J3YXJkcy5hZGRTb2NrZXQoc29ja2V0LCBtZXNzYWdlKTtcbiAgICAgICAgdGhpcy5vblRpY2tldFJlcXVlc3QobWVzc2FnZS5pZCk7XG4gICAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ01PZmZlclRpY2tldCc6XG4gICAgICAgIGNvbnNvbGUubG9nKCd3cnRjOiB5b3UgcmVjZWl2ZWQgYW4gb2ZmZXIgdGlja2V0Jyk7XG4gICAgICAgIGlmICghdGhpcy5mb3J3YXJkcy5jb250YWlucyhtZXNzYWdlKSl7XG4gICAgICAgICAgICAvLyAjMSBpZiB0aGVyZSBpcyBubyBmb3J3YXJkaW5nIHJvdXRlLCB0aGUgb2ZmZXIgdGlja2V0IGlzIGZvciB1cyB0b1xuICAgICAgICAgICAgLy8gc3RhbXBcbiAgICAgICAgICAgIHRoaXMuZm9yd2FyZHMuYWRkU29ja2V0KHNvY2tldCwgbWVzc2FnZSk7XG4gICAgICAgICAgICB0aGlzLm9uU3RhbXBlZFRpY2tldFJlcXVlc3QobWVzc2FnZS5pZCxtZXNzYWdlLnRpY2tldCxtZXNzYWdlLnBlZXIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gIzJBIG90aGVyd2lzZSwgd2UgZm9yd2FyZCB0aGUgb2ZmZXIgdGlja2V0IGFjY29yZGluZ2x5XG4gICAgICAgICAgICBpZiAodGhpcy5zZW5kKG1lc3NhZ2UsIG1lc3NhZ2UpKXtcbiAgICAgICAgICAgICAgICAvLyAjMkIgaW52ZXJ0IHRoZSBkaXJlY3Rpb24gb2YgZm9yd2FyZGluZyByb3V0ZSBpbiBvcmRlciB0b1xuICAgICAgICAgICAgICAgIC8vIGNvbnNpc3RlbnRseSByZWRpcmVjdCB0aGUgc3RhbXBlZCB0aWNrZXRcbiAgICAgICAgICAgICAgICB0aGlzLmZvcndhcmRzLnJlbW92ZVNvY2tldChtZXNzYWdlKTtcbiAgICAgICAgICAgICAgICB0aGlzLmZvcndhcmRzLmFkZFNvY2tldChzb2NrZXQsIG1lc3NhZ2UpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyAjMkMgaWYgdGhlIG1lc3NhZ2UgaGFzIG5vdCBiZWVuIHNlbnQsIHNpbXBseSByZW1vdmUgdGhlIHJvdXRlXG4gICAgICAgICAgICAgICAgdGhpcy5mb3J3YXJkcy5yZW1vdmVTb2NrZXQobWVzc2FnZSk7XG4gICAgICAgICAgICB9O1xuICAgICAgICB9O1xuICAgICAgICBicmVhaztcbiAgICBjYXNlICdNU3RhbXBlZFRpY2tldCc6XG4gICAgICAgIGNvbnNvbGUubG9nKCd3cnRjOiB5b3UgcmVjZWl2ZWQgYSBzdGFtcGVkIHRpY2tldCcpO1xuICAgICAgICBpZiAoIXRoaXMuZm9yd2FyZHMuY29udGFpbnMobWVzc2FnZSkpe1xuICAgICAgICAgICAgLy8gIzEgaWYgdGhlcmUgaXMgbm8gZm9yd2FyZGluZyByb3V0ZSwgdGhlIG1lc3NhZ2UgaXMgZm9yIHVzIHRvXG4gICAgICAgICAgICAvLyBmaW5hbGl6ZVxuICAgICAgICAgICAgaWYgKG1lc3NhZ2UudGlja2V0ID09PSBudWxsKXtcbiAgICAgICAgICAgICAgICAvLyAjMUEgZW1wdHkgdGlja2V0IG1lYW5pbmcgdGhlIHJlbW90ZSBwZWVyIGFscmVhZHkga25vd3MgdXMsXG4gICAgICAgICAgICAgICAgLy8gdGhlcmVmb3JlLCBzaW1wbHkgY2xvc2UgdGhlIHBlbmRpbmcgb2ZmZXJcbiAgICAgICAgICAgICAgICB2YXIgc29ja2V0ID0gdGhpcy5wZW5kaW5nLnJlbW92ZVNvY2tldChtZXNzYWdlKTtcbiAgICAgICAgICAgICAgICBzb2NrZXQuZGVzdHJveSgpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyAjMUIgb3RoZXJ3aXNlLCBmaW5hbGl6ZSB0aGUgY29ubmVjdGlvblxuICAgICAgICAgICAgICAgIHRoaXMucGVuZGluZy5nZXRTb2NrZXQobWVzc2FnZSkuc2lnbmFsKG1lc3NhZ2UudGlja2V0KTtcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyAjMkEgb3RoZXJ3aXNlLCB3ZSBmb3J3YXJkIHRoZSBzdGFtcGVkIHRpY2tldCBhY2NvcmRpbmdseVxuICAgICAgICAgICAgdGhpcy5zZW5kKG1lc3NhZ2UsIG1lc3NhZ2UpO1xuICAgICAgICAgICAgLy8gIzJCIHJlbW92ZSB0aGUgZGlyZWN0aW9uIGZyb20gdGhlIGtub3duIGZvcndhcmRpbmcgcm91dGVzXG4gICAgICAgICAgICB0aGlzLmZvcndhcmRzLnJlbW92ZVNvY2tldChtZXNzYWdlKTtcbiAgICAgICAgfTtcbiAgICAgICAgYnJlYWs7XG4gICAgY2FzZSAnTUV4Y2hhbmdlJzpcbiAgICAgICAgY29uc29sZS5sb2coJ3dydGM6IGEgcGVlciBzdGFydHMgdG8gZXhjaGFuZ2Ugd2l0aCB5b3UnKTtcbiAgICAgICAgdGhpcy5mb3J3YXJkcy5hZGRTb2NrZXQoc29ja2V0LCBtZXNzYWdlKTtcbiAgICAgICAgdGhpcy5vbkV4Y2hhbmdlKG1lc3NhZ2UuaWQsIG1lc3NhZ2UucGVlcik7XG4gICAgICAgIHRoaXMuZm9yd2FyZHMucmVtb3ZlU29ja2V0KG1lc3NhZ2UpO1xuICAgICAgICBicmVhaztcbiAgICB9O1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBTcHJheTtcbiIsIihmdW5jdGlvbiAoQnVmZmVyKXtcbi8qIGdsb2JhbCBCbG9iICovXG5cbm1vZHVsZS5leHBvcnRzID0gUGVlclxuXG52YXIgZGVidWcgPSByZXF1aXJlKCdkZWJ1ZycpKCdzaW1wbGUtcGVlcicpXG52YXIgaGF0ID0gcmVxdWlyZSgnaGF0JylcbnZhciBpbmhlcml0cyA9IHJlcXVpcmUoJ2luaGVyaXRzJylcbnZhciBpc1R5cGVkQXJyYXkgPSByZXF1aXJlKCdpcy10eXBlZGFycmF5JylcbnZhciBvbmNlID0gcmVxdWlyZSgnb25jZScpXG52YXIgc3RyZWFtID0gcmVxdWlyZSgnc3RyZWFtJylcbnZhciB0b0J1ZmZlciA9IHJlcXVpcmUoJ3R5cGVkYXJyYXktdG8tYnVmZmVyJylcblxuaW5oZXJpdHMoUGVlciwgc3RyZWFtLkR1cGxleClcblxuLyoqXG4gKiBXZWJSVEMgcGVlciBjb25uZWN0aW9uLiBTYW1lIEFQSSBhcyBub2RlIGNvcmUgYG5ldC5Tb2NrZXRgLCBwbHVzIGEgZmV3IGV4dHJhIG1ldGhvZHMuXG4gKiBEdXBsZXggc3RyZWFtLlxuICogQHBhcmFtIHtPYmplY3R9IG9wdHNcbiAqL1xuZnVuY3Rpb24gUGVlciAob3B0cykge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgaWYgKCEoc2VsZiBpbnN0YW5jZW9mIFBlZXIpKSByZXR1cm4gbmV3IFBlZXIob3B0cylcbiAgc2VsZi5fZGVidWcoJ25ldyBwZWVyICVvJywgb3B0cylcblxuICBpZiAoIW9wdHMpIG9wdHMgPSB7fVxuICBvcHRzLmFsbG93SGFsZk9wZW4gPSBmYWxzZVxuICBpZiAob3B0cy5oaWdoV2F0ZXJNYXJrID09IG51bGwpIG9wdHMuaGlnaFdhdGVyTWFyayA9IDEwMjQgKiAxMDI0XG5cbiAgc3RyZWFtLkR1cGxleC5jYWxsKHNlbGYsIG9wdHMpXG5cbiAgc2VsZi5pbml0aWF0b3IgPSBvcHRzLmluaXRpYXRvciB8fCBmYWxzZVxuICBzZWxmLmNoYW5uZWxDb25maWcgPSBvcHRzLmNoYW5uZWxDb25maWcgfHwgUGVlci5jaGFubmVsQ29uZmlnXG4gIHNlbGYuY2hhbm5lbE5hbWUgPSBvcHRzLmNoYW5uZWxOYW1lIHx8IGhhdCgxNjApXG4gIGlmICghb3B0cy5pbml0aWF0b3IpIHNlbGYuY2hhbm5lbE5hbWUgPSBudWxsXG4gIHNlbGYuY29uZmlnID0gb3B0cy5jb25maWcgfHwgUGVlci5jb25maWdcbiAgc2VsZi5jb25zdHJhaW50cyA9IG9wdHMuY29uc3RyYWludHMgfHwgUGVlci5jb25zdHJhaW50c1xuICBzZWxmLnJlY29ubmVjdFRpbWVyID0gb3B0cy5yZWNvbm5lY3RUaW1lciB8fCAwXG4gIHNlbGYuc2RwVHJhbnNmb3JtID0gb3B0cy5zZHBUcmFuc2Zvcm0gfHwgZnVuY3Rpb24gKHNkcCkgeyByZXR1cm4gc2RwIH1cbiAgc2VsZi5zdHJlYW0gPSBvcHRzLnN0cmVhbSB8fCBmYWxzZVxuICBzZWxmLnRyaWNrbGUgPSBvcHRzLnRyaWNrbGUgIT09IHVuZGVmaW5lZCA/IG9wdHMudHJpY2tsZSA6IHRydWVcblxuICBzZWxmLmRlc3Ryb3llZCA9IGZhbHNlXG4gIHNlbGYuY29ubmVjdGVkID0gZmFsc2VcblxuICAvLyBzbyBQZWVyIG9iamVjdCBhbHdheXMgaGFzIHNhbWUgc2hhcGUgKFY4IG9wdGltaXphdGlvbilcbiAgc2VsZi5yZW1vdGVBZGRyZXNzID0gdW5kZWZpbmVkXG4gIHNlbGYucmVtb3RlRmFtaWx5ID0gdW5kZWZpbmVkXG4gIHNlbGYucmVtb3RlUG9ydCA9IHVuZGVmaW5lZFxuICBzZWxmLmxvY2FsQWRkcmVzcyA9IHVuZGVmaW5lZFxuICBzZWxmLmxvY2FsUG9ydCA9IHVuZGVmaW5lZFxuXG4gIHNlbGYuX3dydGMgPSBvcHRzLndydGMgfHwgZ2V0QnJvd3NlclJUQygpXG4gIGlmICghc2VsZi5fd3J0Yykge1xuICAgIGlmICh0eXBlb2Ygd2luZG93ID09PSAndW5kZWZpbmVkJykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdObyBXZWJSVEMgc3VwcG9ydDogU3BlY2lmeSBgb3B0cy53cnRjYCBvcHRpb24gaW4gdGhpcyBlbnZpcm9ubWVudCcpXG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignTm8gV2ViUlRDIHN1cHBvcnQ6IE5vdCBhIHN1cHBvcnRlZCBicm93c2VyJylcbiAgICB9XG4gIH1cblxuICBzZWxmLl9tYXhCdWZmZXJlZEFtb3VudCA9IG9wdHMuaGlnaFdhdGVyTWFya1xuICBzZWxmLl9wY1JlYWR5ID0gZmFsc2VcbiAgc2VsZi5fY2hhbm5lbFJlYWR5ID0gZmFsc2VcbiAgc2VsZi5faWNlQ29tcGxldGUgPSBmYWxzZSAvLyBpY2UgY2FuZGlkYXRlIHRyaWNrbGUgZG9uZSAoZ290IG51bGwgY2FuZGlkYXRlKVxuICBzZWxmLl9jaGFubmVsID0gbnVsbFxuXG4gIHNlbGYuX2NodW5rID0gbnVsbFxuICBzZWxmLl9jYiA9IG51bGxcbiAgc2VsZi5faW50ZXJ2YWwgPSBudWxsXG4gIHNlbGYuX3JlY29ubmVjdFRpbWVvdXQgPSBudWxsXG5cbiAgc2VsZi5fcGMgPSBuZXcgKHNlbGYuX3dydGMuUlRDUGVlckNvbm5lY3Rpb24pKHNlbGYuY29uZmlnLCBzZWxmLmNvbnN0cmFpbnRzKVxuICBzZWxmLl9wYy5vbmljZWNvbm5lY3Rpb25zdGF0ZWNoYW5nZSA9IHNlbGYuX29uSWNlQ29ubmVjdGlvblN0YXRlQ2hhbmdlLmJpbmQoc2VsZilcbiAgc2VsZi5fcGMub25zaWduYWxpbmdzdGF0ZWNoYW5nZSA9IHNlbGYuX29uU2lnbmFsaW5nU3RhdGVDaGFuZ2UuYmluZChzZWxmKVxuICBzZWxmLl9wYy5vbmljZWNhbmRpZGF0ZSA9IHNlbGYuX29uSWNlQ2FuZGlkYXRlLmJpbmQoc2VsZilcblxuICBpZiAoc2VsZi5zdHJlYW0pIHNlbGYuX3BjLmFkZFN0cmVhbShzZWxmLnN0cmVhbSlcbiAgc2VsZi5fcGMub25hZGRzdHJlYW0gPSBzZWxmLl9vbkFkZFN0cmVhbS5iaW5kKHNlbGYpXG5cbiAgaWYgKHNlbGYuaW5pdGlhdG9yKSB7XG4gICAgc2VsZi5fc2V0dXBEYXRhKHsgY2hhbm5lbDogc2VsZi5fcGMuY3JlYXRlRGF0YUNoYW5uZWwoc2VsZi5jaGFubmVsTmFtZSwgc2VsZi5jaGFubmVsQ29uZmlnKSB9KVxuICAgIHNlbGYuX3BjLm9ubmVnb3RpYXRpb25uZWVkZWQgPSBvbmNlKHNlbGYuX2NyZWF0ZU9mZmVyLmJpbmQoc2VsZikpXG4gICAgLy8gT25seSBDaHJvbWUgdHJpZ2dlcnMgXCJuZWdvdGlhdGlvbm5lZWRlZFwiOyB0aGlzIGlzIGEgd29ya2Fyb3VuZCBmb3Igb3RoZXJcbiAgICAvLyBpbXBsZW1lbnRhdGlvbnNcbiAgICBpZiAodHlwZW9mIHdpbmRvdyA9PT0gJ3VuZGVmaW5lZCcgfHwgIXdpbmRvdy53ZWJraXRSVENQZWVyQ29ubmVjdGlvbikge1xuICAgICAgc2VsZi5fcGMub25uZWdvdGlhdGlvbm5lZWRlZCgpXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHNlbGYuX3BjLm9uZGF0YWNoYW5uZWwgPSBzZWxmLl9zZXR1cERhdGEuYmluZChzZWxmKVxuICB9XG5cbiAgc2VsZi5vbignZmluaXNoJywgZnVuY3Rpb24gKCkge1xuICAgIGlmIChzZWxmLmNvbm5lY3RlZCkge1xuICAgICAgLy8gV2hlbiBsb2NhbCBwZWVyIGlzIGZpbmlzaGVkIHdyaXRpbmcsIGNsb3NlIGNvbm5lY3Rpb24gdG8gcmVtb3RlIHBlZXIuXG4gICAgICAvLyBIYWxmIG9wZW4gY29ubmVjdGlvbnMgYXJlIGN1cnJlbnRseSBub3Qgc3VwcG9ydGVkLlxuICAgICAgLy8gV2FpdCBhIGJpdCBiZWZvcmUgZGVzdHJveWluZyBzbyB0aGUgZGF0YWNoYW5uZWwgZmx1c2hlcy5cbiAgICAgIC8vIFRPRE86IGlzIHRoZXJlIGEgbW9yZSByZWxpYWJsZSB3YXkgdG8gYWNjb21wbGlzaCB0aGlzP1xuICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgIHNlbGYuX2Rlc3Ryb3koKVxuICAgICAgfSwgMTAwKVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBJZiBkYXRhIGNoYW5uZWwgaXMgbm90IGNvbm5lY3RlZCB3aGVuIGxvY2FsIHBlZXIgaXMgZmluaXNoZWQgd3JpdGluZywgd2FpdCB1bnRpbFxuICAgICAgLy8gZGF0YSBpcyBmbHVzaGVkIHRvIG5ldHdvcmsgYXQgXCJjb25uZWN0XCIgZXZlbnQuXG4gICAgICAvLyBUT0RPOiBpcyB0aGVyZSBhIG1vcmUgcmVsaWFibGUgd2F5IHRvIGFjY29tcGxpc2ggdGhpcz9cbiAgICAgIHNlbGYub25jZSgnY29ubmVjdCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgc2VsZi5fZGVzdHJveSgpXG4gICAgICAgIH0sIDEwMClcbiAgICAgIH0pXG4gICAgfVxuICB9KVxufVxuXG5QZWVyLldFQlJUQ19TVVBQT1JUID0gISFnZXRCcm93c2VyUlRDKClcblxuLyoqXG4gKiBFeHBvc2UgY29uZmlnLCBjb25zdHJhaW50cywgYW5kIGRhdGEgY2hhbm5lbCBjb25maWcgZm9yIG92ZXJyaWRpbmcgYWxsIFBlZXJcbiAqIGluc3RhbmNlcy4gT3RoZXJ3aXNlLCBqdXN0IHNldCBvcHRzLmNvbmZpZywgb3B0cy5jb25zdHJhaW50cywgb3Igb3B0cy5jaGFubmVsQ29uZmlnXG4gKiB3aGVuIGNvbnN0cnVjdGluZyBhIFBlZXIuXG4gKi9cblBlZXIuY29uZmlnID0ge1xuICBpY2VTZXJ2ZXJzOiBbXG4gICAge1xuICAgICAgdXJsOiAnc3R1bjoyMy4yMS4xNTAuMTIxJywgLy8gZGVwcmVjYXRlZCwgcmVwbGFjZWQgYnkgYHVybHNgXG4gICAgICB1cmxzOiAnc3R1bjoyMy4yMS4xNTAuMTIxJ1xuICAgIH1cbiAgXVxufVxuUGVlci5jb25zdHJhaW50cyA9IHt9XG5QZWVyLmNoYW5uZWxDb25maWcgPSB7fVxuXG5PYmplY3QuZGVmaW5lUHJvcGVydHkoUGVlci5wcm90b3R5cGUsICdidWZmZXJTaXplJywge1xuICBnZXQ6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXNcbiAgICByZXR1cm4gKHNlbGYuX2NoYW5uZWwgJiYgc2VsZi5fY2hhbm5lbC5idWZmZXJlZEFtb3VudCkgfHwgMFxuICB9XG59KVxuXG5QZWVyLnByb3RvdHlwZS5hZGRyZXNzID0gZnVuY3Rpb24gKCkge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgcmV0dXJuIHsgcG9ydDogc2VsZi5sb2NhbFBvcnQsIGZhbWlseTogJ0lQdjQnLCBhZGRyZXNzOiBzZWxmLmxvY2FsQWRkcmVzcyB9XG59XG5cblBlZXIucHJvdG90eXBlLnNpZ25hbCA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBpZiAoc2VsZi5kZXN0cm95ZWQpIHRocm93IG5ldyBFcnJvcignY2Fubm90IHNpZ25hbCBhZnRlciBwZWVyIGlzIGRlc3Ryb3llZCcpXG4gIGlmICh0eXBlb2YgZGF0YSA9PT0gJ3N0cmluZycpIHtcbiAgICB0cnkge1xuICAgICAgZGF0YSA9IEpTT04ucGFyc2UoZGF0YSlcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGRhdGEgPSB7fVxuICAgIH1cbiAgfVxuICBzZWxmLl9kZWJ1Zygnc2lnbmFsKCknKVxuICBpZiAoZGF0YS5zZHApIHtcbiAgICBzZWxmLl9wYy5zZXRSZW1vdGVEZXNjcmlwdGlvbihuZXcgKHNlbGYuX3dydGMuUlRDU2Vzc2lvbkRlc2NyaXB0aW9uKShkYXRhKSwgZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKHNlbGYuZGVzdHJveWVkKSByZXR1cm5cbiAgICAgIGlmIChzZWxmLl9wYy5yZW1vdGVEZXNjcmlwdGlvbi50eXBlID09PSAnb2ZmZXInKSBzZWxmLl9jcmVhdGVBbnN3ZXIoKVxuICAgIH0sIHNlbGYuX29uRXJyb3IuYmluZChzZWxmKSlcbiAgfVxuICBpZiAoZGF0YS5jYW5kaWRhdGUpIHtcbiAgICB0cnkge1xuICAgICAgc2VsZi5fcGMuYWRkSWNlQ2FuZGlkYXRlKFxuICAgICAgICBuZXcgKHNlbGYuX3dydGMuUlRDSWNlQ2FuZGlkYXRlKShkYXRhLmNhbmRpZGF0ZSksIG5vb3AsIHNlbGYuX29uRXJyb3IuYmluZChzZWxmKVxuICAgICAgKVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgc2VsZi5fZGVzdHJveShuZXcgRXJyb3IoJ2Vycm9yIGFkZGluZyBjYW5kaWRhdGU6ICcgKyBlcnIubWVzc2FnZSkpXG4gICAgfVxuICB9XG4gIGlmICghZGF0YS5zZHAgJiYgIWRhdGEuY2FuZGlkYXRlKSB7XG4gICAgc2VsZi5fZGVzdHJveShuZXcgRXJyb3IoJ3NpZ25hbCgpIGNhbGxlZCB3aXRoIGludmFsaWQgc2lnbmFsIGRhdGEnKSlcbiAgfVxufVxuXG4vKipcbiAqIFNlbmQgdGV4dC9iaW5hcnkgZGF0YSB0byB0aGUgcmVtb3RlIHBlZXIuXG4gKiBAcGFyYW0ge1R5cGVkQXJyYXlWaWV3fEFycmF5QnVmZmVyfEJ1ZmZlcnxzdHJpbmd8QmxvYnxPYmplY3R9IGNodW5rXG4gKi9cblBlZXIucHJvdG90eXBlLnNlbmQgPSBmdW5jdGlvbiAoY2h1bmspIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG5cbiAgaWYgKCFpc1R5cGVkQXJyYXkuc3RyaWN0KGNodW5rKSAmJiAhKGNodW5rIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpICYmXG4gICAgIUJ1ZmZlci5pc0J1ZmZlcihjaHVuaykgJiYgdHlwZW9mIGNodW5rICE9PSAnc3RyaW5nJyAmJlxuICAgICh0eXBlb2YgQmxvYiA9PT0gJ3VuZGVmaW5lZCcgfHwgIShjaHVuayBpbnN0YW5jZW9mIEJsb2IpKSkge1xuICAgIGNodW5rID0gSlNPTi5zdHJpbmdpZnkoY2h1bmspXG4gIH1cblxuICAvLyBgd3J0Y2AgbW9kdWxlIGRvZXNuJ3QgYWNjZXB0IG5vZGUuanMgYnVmZmVyXG4gIGlmIChCdWZmZXIuaXNCdWZmZXIoY2h1bmspICYmICFpc1R5cGVkQXJyYXkuc3RyaWN0KGNodW5rKSkge1xuICAgIGNodW5rID0gbmV3IFVpbnQ4QXJyYXkoY2h1bmspXG4gIH1cblxuICB2YXIgbGVuID0gY2h1bmsubGVuZ3RoIHx8IGNodW5rLmJ5dGVMZW5ndGggfHwgY2h1bmsuc2l6ZVxuICBzZWxmLl9jaGFubmVsLnNlbmQoY2h1bmspXG4gIHNlbGYuX2RlYnVnKCd3cml0ZTogJWQgYnl0ZXMnLCBsZW4pXG59XG5cblBlZXIucHJvdG90eXBlLmRlc3Ryb3kgPSBmdW5jdGlvbiAob25jbG9zZSkge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgc2VsZi5fZGVzdHJveShudWxsLCBvbmNsb3NlKVxufVxuXG5QZWVyLnByb3RvdHlwZS5fZGVzdHJveSA9IGZ1bmN0aW9uIChlcnIsIG9uY2xvc2UpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG4gIGlmIChvbmNsb3NlKSBzZWxmLm9uY2UoJ2Nsb3NlJywgb25jbG9zZSlcblxuICBzZWxmLl9kZWJ1ZygnZGVzdHJveSAoZXJyb3I6ICVzKScsIGVyciAmJiBlcnIubWVzc2FnZSlcblxuICBzZWxmLnJlYWRhYmxlID0gc2VsZi53cml0YWJsZSA9IGZhbHNlXG5cbiAgaWYgKCFzZWxmLl9yZWFkYWJsZVN0YXRlLmVuZGVkKSBzZWxmLnB1c2gobnVsbClcbiAgaWYgKCFzZWxmLl93cml0YWJsZVN0YXRlLmZpbmlzaGVkKSBzZWxmLmVuZCgpXG5cbiAgc2VsZi5kZXN0cm95ZWQgPSB0cnVlXG4gIHNlbGYuY29ubmVjdGVkID0gZmFsc2VcbiAgc2VsZi5fcGNSZWFkeSA9IGZhbHNlXG4gIHNlbGYuX2NoYW5uZWxSZWFkeSA9IGZhbHNlXG5cbiAgc2VsZi5fY2h1bmsgPSBudWxsXG4gIHNlbGYuX2NiID0gbnVsbFxuICBjbGVhckludGVydmFsKHNlbGYuX2ludGVydmFsKVxuICBjbGVhclRpbWVvdXQoc2VsZi5fcmVjb25uZWN0VGltZW91dClcblxuICBpZiAoc2VsZi5fcGMpIHtcbiAgICB0cnkge1xuICAgICAgc2VsZi5fcGMuY2xvc2UoKVxuICAgIH0gY2F0Y2ggKGVycikge31cblxuICAgIHNlbGYuX3BjLm9uaWNlY29ubmVjdGlvbnN0YXRlY2hhbmdlID0gbnVsbFxuICAgIHNlbGYuX3BjLm9uc2lnbmFsaW5nc3RhdGVjaGFuZ2UgPSBudWxsXG4gICAgc2VsZi5fcGMub25pY2VjYW5kaWRhdGUgPSBudWxsXG4gIH1cblxuICBpZiAoc2VsZi5fY2hhbm5lbCkge1xuICAgIHRyeSB7XG4gICAgICBzZWxmLl9jaGFubmVsLmNsb3NlKClcbiAgICB9IGNhdGNoIChlcnIpIHt9XG5cbiAgICBzZWxmLl9jaGFubmVsLm9ubWVzc2FnZSA9IG51bGxcbiAgICBzZWxmLl9jaGFubmVsLm9ub3BlbiA9IG51bGxcbiAgICBzZWxmLl9jaGFubmVsLm9uY2xvc2UgPSBudWxsXG4gIH1cbiAgc2VsZi5fcGMgPSBudWxsXG4gIHNlbGYuX2NoYW5uZWwgPSBudWxsXG5cbiAgaWYgKGVycikgc2VsZi5lbWl0KCdlcnJvcicsIGVycilcbiAgc2VsZi5lbWl0KCdjbG9zZScpXG59XG5cblBlZXIucHJvdG90eXBlLl9zZXR1cERhdGEgPSBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIHNlbGYuX2NoYW5uZWwgPSBldmVudC5jaGFubmVsXG4gIHNlbGYuY2hhbm5lbE5hbWUgPSBzZWxmLl9jaGFubmVsLmxhYmVsXG5cbiAgc2VsZi5fY2hhbm5lbC5iaW5hcnlUeXBlID0gJ2FycmF5YnVmZmVyJ1xuICBzZWxmLl9jaGFubmVsLm9ubWVzc2FnZSA9IHNlbGYuX29uQ2hhbm5lbE1lc3NhZ2UuYmluZChzZWxmKVxuICBzZWxmLl9jaGFubmVsLm9ub3BlbiA9IHNlbGYuX29uQ2hhbm5lbE9wZW4uYmluZChzZWxmKVxuICBzZWxmLl9jaGFubmVsLm9uY2xvc2UgPSBzZWxmLl9vbkNoYW5uZWxDbG9zZS5iaW5kKHNlbGYpXG59XG5cblBlZXIucHJvdG90eXBlLl9yZWFkID0gZnVuY3Rpb24gKCkge31cblxuUGVlci5wcm90b3R5cGUuX3dyaXRlID0gZnVuY3Rpb24gKGNodW5rLCBlbmNvZGluZywgY2IpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuIGNiKG5ldyBFcnJvcignY2Fubm90IHdyaXRlIGFmdGVyIHBlZXIgaXMgZGVzdHJveWVkJykpXG5cbiAgaWYgKHNlbGYuY29ubmVjdGVkKSB7XG4gICAgc2VsZi5zZW5kKGNodW5rKVxuICAgIGlmIChzZWxmLl9jaGFubmVsLmJ1ZmZlcmVkQW1vdW50ID4gc2VsZi5fbWF4QnVmZmVyZWRBbW91bnQpIHtcbiAgICAgIHNlbGYuX2RlYnVnKCdzdGFydCBiYWNrcHJlc3N1cmU6IGJ1ZmZlcmVkQW1vdW50ICVkJywgc2VsZi5fY2hhbm5lbC5idWZmZXJlZEFtb3VudClcbiAgICAgIHNlbGYuX2NiID0gY2JcbiAgICB9IGVsc2Uge1xuICAgICAgY2IobnVsbClcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgc2VsZi5fZGVidWcoJ3dyaXRlIGJlZm9yZSBjb25uZWN0JylcbiAgICBzZWxmLl9jaHVuayA9IGNodW5rXG4gICAgc2VsZi5fY2IgPSBjYlxuICB9XG59XG5cblBlZXIucHJvdG90eXBlLl9jcmVhdGVPZmZlciA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG5cbiAgc2VsZi5fcGMuY3JlYXRlT2ZmZXIoZnVuY3Rpb24gKG9mZmVyKSB7XG4gICAgaWYgKHNlbGYuZGVzdHJveWVkKSByZXR1cm5cbiAgICBzcGVlZEhhY2sob2ZmZXIpXG4gICAgb2ZmZXIuc2RwID0gc2VsZi5zZHBUcmFuc2Zvcm0ob2ZmZXIuc2RwKVxuICAgIHNlbGYuX3BjLnNldExvY2FsRGVzY3JpcHRpb24ob2ZmZXIsIG5vb3AsIHNlbGYuX29uRXJyb3IuYmluZChzZWxmKSlcbiAgICB2YXIgc2VuZE9mZmVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fZGVidWcoJ3NpZ25hbCcpXG4gICAgICBzZWxmLmVtaXQoJ3NpZ25hbCcsIHNlbGYuX3BjLmxvY2FsRGVzY3JpcHRpb24gfHwgb2ZmZXIpXG4gICAgfVxuICAgIGlmIChzZWxmLnRyaWNrbGUgfHwgc2VsZi5faWNlQ29tcGxldGUpIHNlbmRPZmZlcigpXG4gICAgZWxzZSBzZWxmLm9uY2UoJ19pY2VDb21wbGV0ZScsIHNlbmRPZmZlcikgLy8gd2FpdCBmb3IgY2FuZGlkYXRlc1xuICB9LCBzZWxmLl9vbkVycm9yLmJpbmQoc2VsZiksIHNlbGYub2ZmZXJDb25zdHJhaW50cylcbn1cblxuUGVlci5wcm90b3R5cGUuX2NyZWF0ZUFuc3dlciA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG5cbiAgc2VsZi5fcGMuY3JlYXRlQW5zd2VyKGZ1bmN0aW9uIChhbnN3ZXIpIHtcbiAgICBpZiAoc2VsZi5kZXN0cm95ZWQpIHJldHVyblxuICAgIHNwZWVkSGFjayhhbnN3ZXIpXG4gICAgYW5zd2VyLnNkcCA9IHNlbGYuc2RwVHJhbnNmb3JtKGFuc3dlci5zZHApXG4gICAgc2VsZi5fcGMuc2V0TG9jYWxEZXNjcmlwdGlvbihhbnN3ZXIsIG5vb3AsIHNlbGYuX29uRXJyb3IuYmluZChzZWxmKSlcbiAgICB2YXIgc2VuZEFuc3dlciA9IGZ1bmN0aW9uICgpIHtcbiAgICAgIHNlbGYuX2RlYnVnKCdzaWduYWwnKVxuICAgICAgc2VsZi5lbWl0KCdzaWduYWwnLCBzZWxmLl9wYy5sb2NhbERlc2NyaXB0aW9uIHx8IGFuc3dlcilcbiAgICB9XG4gICAgaWYgKHNlbGYudHJpY2tsZSB8fCBzZWxmLl9pY2VDb21wbGV0ZSkgc2VuZEFuc3dlcigpXG4gICAgZWxzZSBzZWxmLm9uY2UoJ19pY2VDb21wbGV0ZScsIHNlbmRBbnN3ZXIpXG4gIH0sIHNlbGYuX29uRXJyb3IuYmluZChzZWxmKSwgc2VsZi5hbnN3ZXJDb25zdHJhaW50cylcbn1cblxuUGVlci5wcm90b3R5cGUuX29uSWNlQ29ubmVjdGlvblN0YXRlQ2hhbmdlID0gZnVuY3Rpb24gKCkge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgaWYgKHNlbGYuZGVzdHJveWVkKSByZXR1cm5cbiAgdmFyIGljZUdhdGhlcmluZ1N0YXRlID0gc2VsZi5fcGMuaWNlR2F0aGVyaW5nU3RhdGVcbiAgdmFyIGljZUNvbm5lY3Rpb25TdGF0ZSA9IHNlbGYuX3BjLmljZUNvbm5lY3Rpb25TdGF0ZVxuICBzZWxmLl9kZWJ1ZygnaWNlQ29ubmVjdGlvblN0YXRlQ2hhbmdlICVzICVzJywgaWNlR2F0aGVyaW5nU3RhdGUsIGljZUNvbm5lY3Rpb25TdGF0ZSlcbiAgc2VsZi5lbWl0KCdpY2VDb25uZWN0aW9uU3RhdGVDaGFuZ2UnLCBpY2VHYXRoZXJpbmdTdGF0ZSwgaWNlQ29ubmVjdGlvblN0YXRlKVxuICBpZiAoaWNlQ29ubmVjdGlvblN0YXRlID09PSAnY29ubmVjdGVkJyB8fCBpY2VDb25uZWN0aW9uU3RhdGUgPT09ICdjb21wbGV0ZWQnKSB7XG4gICAgY2xlYXJUaW1lb3V0KHNlbGYuX3JlY29ubmVjdFRpbWVvdXQpXG4gICAgc2VsZi5fcGNSZWFkeSA9IHRydWVcbiAgICBzZWxmLl9tYXliZVJlYWR5KClcbiAgfVxuICBpZiAoaWNlQ29ubmVjdGlvblN0YXRlID09PSAnZGlzY29ubmVjdGVkJykge1xuICAgIGlmIChzZWxmLnJlY29ubmVjdFRpbWVyKSB7XG4gICAgICAvLyBJZiB1c2VyIGhhcyBzZXQgYG9wdC5yZWNvbm5lY3RUaW1lcmAsIGFsbG93IHRpbWUgZm9yIElDRSB0byBhdHRlbXB0IGEgcmVjb25uZWN0XG4gICAgICBjbGVhclRpbWVvdXQoc2VsZi5fcmVjb25uZWN0VGltZW91dClcbiAgICAgIHNlbGYuX3JlY29ubmVjdFRpbWVvdXQgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgc2VsZi5fZGVzdHJveSgpXG4gICAgICB9LCBzZWxmLnJlY29ubmVjdFRpbWVyKVxuICAgIH0gZWxzZSB7XG4gICAgICBzZWxmLl9kZXN0cm95KClcbiAgICB9XG4gIH1cbiAgaWYgKGljZUNvbm5lY3Rpb25TdGF0ZSA9PT0gJ2Nsb3NlZCcpIHtcbiAgICBzZWxmLl9kZXN0cm95KClcbiAgfVxufVxuXG5QZWVyLnByb3RvdHlwZS5fbWF5YmVSZWFkeSA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIHNlbGYuX2RlYnVnKCdtYXliZVJlYWR5IHBjICVzIGNoYW5uZWwgJXMnLCBzZWxmLl9wY1JlYWR5LCBzZWxmLl9jaGFubmVsUmVhZHkpXG4gIGlmIChzZWxmLmNvbm5lY3RlZCB8fCBzZWxmLl9jb25uZWN0aW5nIHx8ICFzZWxmLl9wY1JlYWR5IHx8ICFzZWxmLl9jaGFubmVsUmVhZHkpIHJldHVyblxuICBzZWxmLl9jb25uZWN0aW5nID0gdHJ1ZVxuXG4gIGlmICh0eXBlb2Ygd2luZG93ICE9PSAndW5kZWZpbmVkJyAmJiAhIXdpbmRvdy5tb3pSVENQZWVyQ29ubmVjdGlvbikge1xuICAgIHNlbGYuX3BjLmdldFN0YXRzKG51bGwsIGZ1bmN0aW9uIChyZXMpIHtcbiAgICAgIHZhciBpdGVtcyA9IFtdXG4gICAgICByZXMuZm9yRWFjaChmdW5jdGlvbiAoaXRlbSkge1xuICAgICAgICBpdGVtcy5wdXNoKGl0ZW0pXG4gICAgICB9KVxuICAgICAgb25TdGF0cyhpdGVtcylcbiAgICB9LCBzZWxmLl9vbkVycm9yLmJpbmQoc2VsZikpXG4gIH0gZWxzZSB7XG4gICAgc2VsZi5fcGMuZ2V0U3RhdHMoZnVuY3Rpb24gKHJlcykge1xuICAgICAgdmFyIGl0ZW1zID0gW11cbiAgICAgIHJlcy5yZXN1bHQoKS5mb3JFYWNoKGZ1bmN0aW9uIChyZXN1bHQpIHtcbiAgICAgICAgdmFyIGl0ZW0gPSB7fVxuICAgICAgICByZXN1bHQubmFtZXMoKS5mb3JFYWNoKGZ1bmN0aW9uIChuYW1lKSB7XG4gICAgICAgICAgaXRlbVtuYW1lXSA9IHJlc3VsdC5zdGF0KG5hbWUpXG4gICAgICAgIH0pXG4gICAgICAgIGl0ZW0uaWQgPSByZXN1bHQuaWRcbiAgICAgICAgaXRlbS50eXBlID0gcmVzdWx0LnR5cGVcbiAgICAgICAgaXRlbS50aW1lc3RhbXAgPSByZXN1bHQudGltZXN0YW1wXG4gICAgICAgIGl0ZW1zLnB1c2goaXRlbSlcbiAgICAgIH0pXG4gICAgICBvblN0YXRzKGl0ZW1zKVxuICAgIH0pXG4gIH1cblxuICBmdW5jdGlvbiBvblN0YXRzIChpdGVtcykge1xuICAgIGl0ZW1zLmZvckVhY2goZnVuY3Rpb24gKGl0ZW0pIHtcbiAgICAgIGlmIChpdGVtLnR5cGUgPT09ICdyZW1vdGVjYW5kaWRhdGUnKSB7XG4gICAgICAgIHNlbGYucmVtb3RlQWRkcmVzcyA9IGl0ZW0uaXBBZGRyZXNzXG4gICAgICAgIHNlbGYucmVtb3RlRmFtaWx5ID0gJ0lQdjQnXG4gICAgICAgIHNlbGYucmVtb3RlUG9ydCA9IE51bWJlcihpdGVtLnBvcnROdW1iZXIpXG4gICAgICAgIHNlbGYuX2RlYnVnKFxuICAgICAgICAgICdjb25uZWN0IHJlbW90ZTogJXM6JXMgKCVzKScsXG4gICAgICAgICAgc2VsZi5yZW1vdGVBZGRyZXNzLCBzZWxmLnJlbW90ZVBvcnQsIHNlbGYucmVtb3RlRmFtaWx5XG4gICAgICAgIClcbiAgICAgIH0gZWxzZSBpZiAoaXRlbS50eXBlID09PSAnbG9jYWxjYW5kaWRhdGUnICYmIGl0ZW0uY2FuZGlkYXRlVHlwZSA9PT0gJ2hvc3QnKSB7XG4gICAgICAgIHNlbGYubG9jYWxBZGRyZXNzID0gaXRlbS5pcEFkZHJlc3NcbiAgICAgICAgc2VsZi5sb2NhbFBvcnQgPSBOdW1iZXIoaXRlbS5wb3J0TnVtYmVyKVxuICAgICAgICBzZWxmLl9kZWJ1ZygnY29ubmVjdCBsb2NhbDogJXM6JXMnLCBzZWxmLmxvY2FsQWRkcmVzcywgc2VsZi5sb2NhbFBvcnQpXG4gICAgICB9XG4gICAgfSlcblxuICAgIHNlbGYuX2Nvbm5lY3RpbmcgPSBmYWxzZVxuICAgIHNlbGYuY29ubmVjdGVkID0gdHJ1ZVxuXG4gICAgaWYgKHNlbGYuX2NodW5rKSB7XG4gICAgICBzZWxmLnNlbmQoc2VsZi5fY2h1bmspXG4gICAgICBzZWxmLl9jaHVuayA9IG51bGxcbiAgICAgIHNlbGYuX2RlYnVnKCdzZW50IGNodW5rIGZyb20gXCJ3cml0ZSBiZWZvcmUgY29ubmVjdFwiJylcblxuICAgICAgdmFyIGNiID0gc2VsZi5fY2JcbiAgICAgIHNlbGYuX2NiID0gbnVsbFxuICAgICAgY2IobnVsbClcbiAgICB9XG5cbiAgICBzZWxmLl9pbnRlcnZhbCA9IHNldEludGVydmFsKGZ1bmN0aW9uICgpIHtcbiAgICAgIGlmICghc2VsZi5fY2IgfHwgIXNlbGYuX2NoYW5uZWwgfHwgc2VsZi5fY2hhbm5lbC5idWZmZXJlZEFtb3VudCA+IHNlbGYuX21heEJ1ZmZlcmVkQW1vdW50KSByZXR1cm5cbiAgICAgIHNlbGYuX2RlYnVnKCdlbmRpbmcgYmFja3ByZXNzdXJlOiBidWZmZXJlZEFtb3VudCAlZCcsIHNlbGYuX2NoYW5uZWwuYnVmZmVyZWRBbW91bnQpXG4gICAgICB2YXIgY2IgPSBzZWxmLl9jYlxuICAgICAgc2VsZi5fY2IgPSBudWxsXG4gICAgICBjYihudWxsKVxuICAgIH0sIDE1MClcbiAgICBpZiAoc2VsZi5faW50ZXJ2YWwudW5yZWYpIHNlbGYuX2ludGVydmFsLnVucmVmKClcblxuICAgIHNlbGYuX2RlYnVnKCdjb25uZWN0JylcbiAgICBzZWxmLmVtaXQoJ2Nvbm5lY3QnKVxuICB9XG59XG5cblBlZXIucHJvdG90eXBlLl9vblNpZ25hbGluZ1N0YXRlQ2hhbmdlID0gZnVuY3Rpb24gKCkge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgaWYgKHNlbGYuZGVzdHJveWVkKSByZXR1cm5cbiAgc2VsZi5fZGVidWcoJ3NpZ25hbGluZ1N0YXRlQ2hhbmdlICVzJywgc2VsZi5fcGMuc2lnbmFsaW5nU3RhdGUpXG4gIHNlbGYuZW1pdCgnc2lnbmFsaW5nU3RhdGVDaGFuZ2UnLCBzZWxmLl9wYy5zaWduYWxpbmdTdGF0ZSlcbn1cblxuUGVlci5wcm90b3R5cGUuX29uSWNlQ2FuZGlkYXRlID0gZnVuY3Rpb24gKGV2ZW50KSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBpZiAoc2VsZi5kZXN0cm95ZWQpIHJldHVyblxuICBpZiAoZXZlbnQuY2FuZGlkYXRlICYmIHNlbGYudHJpY2tsZSkge1xuICAgIHNlbGYuZW1pdCgnc2lnbmFsJywgeyBjYW5kaWRhdGU6IGV2ZW50LmNhbmRpZGF0ZSB9KVxuICB9IGVsc2UgaWYgKCFldmVudC5jYW5kaWRhdGUpIHtcbiAgICBzZWxmLl9pY2VDb21wbGV0ZSA9IHRydWVcbiAgICBzZWxmLmVtaXQoJ19pY2VDb21wbGV0ZScpXG4gIH1cbn1cblxuUGVlci5wcm90b3R5cGUuX29uQ2hhbm5lbE1lc3NhZ2UgPSBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG4gIHZhciBkYXRhID0gZXZlbnQuZGF0YVxuICBzZWxmLl9kZWJ1ZygncmVhZDogJWQgYnl0ZXMnLCBkYXRhLmJ5dGVMZW5ndGggfHwgZGF0YS5sZW5ndGgpXG5cbiAgaWYgKGRhdGEgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikge1xuICAgIGRhdGEgPSB0b0J1ZmZlcihuZXcgVWludDhBcnJheShkYXRhKSlcbiAgICBzZWxmLnB1c2goZGF0YSlcbiAgfSBlbHNlIHtcbiAgICB0cnkge1xuICAgICAgZGF0YSA9IEpTT04ucGFyc2UoZGF0YSlcbiAgICB9IGNhdGNoIChlcnIpIHt9XG4gICAgc2VsZi5lbWl0KCdkYXRhJywgZGF0YSlcbiAgfVxufVxuXG5QZWVyLnByb3RvdHlwZS5fb25DaGFubmVsT3BlbiA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmIChzZWxmLmNvbm5lY3RlZCB8fCBzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG4gIHNlbGYuX2RlYnVnKCdvbiBjaGFubmVsIG9wZW4nKVxuICBzZWxmLl9jaGFubmVsUmVhZHkgPSB0cnVlXG4gIHNlbGYuX21heWJlUmVhZHkoKVxufVxuXG5QZWVyLnByb3RvdHlwZS5fb25DaGFubmVsQ2xvc2UgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBpZiAoc2VsZi5kZXN0cm95ZWQpIHJldHVyblxuICBzZWxmLl9kZWJ1Zygnb24gY2hhbm5lbCBjbG9zZScpXG4gIHNlbGYuX2Rlc3Ryb3koKVxufVxuXG5QZWVyLnByb3RvdHlwZS5fb25BZGRTdHJlYW0gPSBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG4gIHNlbGYuX2RlYnVnKCdvbiBhZGQgc3RyZWFtJylcbiAgc2VsZi5lbWl0KCdzdHJlYW0nLCBldmVudC5zdHJlYW0pXG59XG5cblBlZXIucHJvdG90eXBlLl9vbkVycm9yID0gZnVuY3Rpb24gKGVycikge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgaWYgKHNlbGYuZGVzdHJveWVkKSByZXR1cm5cbiAgc2VsZi5fZGVidWcoJ2Vycm9yICVzJywgZXJyLm1lc3NhZ2UgfHwgZXJyKVxuICBzZWxmLl9kZXN0cm95KGVycilcbn1cblxuUGVlci5wcm90b3R5cGUuX2RlYnVnID0gZnVuY3Rpb24gKCkge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgdmFyIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cylcbiAgdmFyIGlkID0gc2VsZi5jaGFubmVsTmFtZSAmJiBzZWxmLmNoYW5uZWxOYW1lLnN1YnN0cmluZygwLCA3KVxuICBhcmdzWzBdID0gJ1snICsgaWQgKyAnXSAnICsgYXJnc1swXVxuICBkZWJ1Zy5hcHBseShudWxsLCBhcmdzKVxufVxuXG5mdW5jdGlvbiBnZXRCcm93c2VyUlRDICgpIHtcbiAgaWYgKHR5cGVvZiB3aW5kb3cgPT09ICd1bmRlZmluZWQnKSByZXR1cm4gbnVsbFxuICB2YXIgd3J0YyA9IHtcbiAgICBSVENQZWVyQ29ubmVjdGlvbjogd2luZG93Lm1velJUQ1BlZXJDb25uZWN0aW9uIHx8IHdpbmRvdy5SVENQZWVyQ29ubmVjdGlvbiB8fFxuICAgICAgd2luZG93LndlYmtpdFJUQ1BlZXJDb25uZWN0aW9uLFxuICAgIFJUQ1Nlc3Npb25EZXNjcmlwdGlvbjogd2luZG93Lm1velJUQ1Nlc3Npb25EZXNjcmlwdGlvbiB8fFxuICAgICAgd2luZG93LlJUQ1Nlc3Npb25EZXNjcmlwdGlvbiB8fCB3aW5kb3cud2Via2l0UlRDU2Vzc2lvbkRlc2NyaXB0aW9uLFxuICAgIFJUQ0ljZUNhbmRpZGF0ZTogd2luZG93Lm1velJUQ0ljZUNhbmRpZGF0ZSB8fCB3aW5kb3cuUlRDSWNlQ2FuZGlkYXRlIHx8XG4gICAgICB3aW5kb3cud2Via2l0UlRDSWNlQ2FuZGlkYXRlXG4gIH1cbiAgaWYgKCF3cnRjLlJUQ1BlZXJDb25uZWN0aW9uKSByZXR1cm4gbnVsbFxuICByZXR1cm4gd3J0Y1xufVxuXG5mdW5jdGlvbiBzcGVlZEhhY2sgKG9iaikge1xuICB2YXIgcyA9IG9iai5zZHAuc3BsaXQoJ2I9QVM6MzAnKVxuICBpZiAocy5sZW5ndGggPiAxKSBvYmouc2RwID0gc1swXSArICdiPUFTOjE2Mzg0MDAnICsgc1sxXVxufVxuXG5mdW5jdGlvbiBub29wICgpIHt9XG5cbn0pLmNhbGwodGhpcyxyZXF1aXJlKFwiYnVmZmVyXCIpLkJ1ZmZlcikiLCJcbi8qKlxuICogVGhpcyBpcyB0aGUgd2ViIGJyb3dzZXIgaW1wbGVtZW50YXRpb24gb2YgYGRlYnVnKClgLlxuICpcbiAqIEV4cG9zZSBgZGVidWcoKWAgYXMgdGhlIG1vZHVsZS5cbiAqL1xuXG5leHBvcnRzID0gbW9kdWxlLmV4cG9ydHMgPSByZXF1aXJlKCcuL2RlYnVnJyk7XG5leHBvcnRzLmxvZyA9IGxvZztcbmV4cG9ydHMuZm9ybWF0QXJncyA9IGZvcm1hdEFyZ3M7XG5leHBvcnRzLnNhdmUgPSBzYXZlO1xuZXhwb3J0cy5sb2FkID0gbG9hZDtcbmV4cG9ydHMudXNlQ29sb3JzID0gdXNlQ29sb3JzO1xuZXhwb3J0cy5zdG9yYWdlID0gJ3VuZGVmaW5lZCcgIT0gdHlwZW9mIGNocm9tZVxuICAgICAgICAgICAgICAgJiYgJ3VuZGVmaW5lZCcgIT0gdHlwZW9mIGNocm9tZS5zdG9yYWdlXG4gICAgICAgICAgICAgICAgICA/IGNocm9tZS5zdG9yYWdlLmxvY2FsXG4gICAgICAgICAgICAgICAgICA6IGxvY2Fsc3RvcmFnZSgpO1xuXG4vKipcbiAqIENvbG9ycy5cbiAqL1xuXG5leHBvcnRzLmNvbG9ycyA9IFtcbiAgJ2xpZ2h0c2VhZ3JlZW4nLFxuICAnZm9yZXN0Z3JlZW4nLFxuICAnZ29sZGVucm9kJyxcbiAgJ2RvZGdlcmJsdWUnLFxuICAnZGFya29yY2hpZCcsXG4gICdjcmltc29uJ1xuXTtcblxuLyoqXG4gKiBDdXJyZW50bHkgb25seSBXZWJLaXQtYmFzZWQgV2ViIEluc3BlY3RvcnMsIEZpcmVmb3ggPj0gdjMxLFxuICogYW5kIHRoZSBGaXJlYnVnIGV4dGVuc2lvbiAoYW55IEZpcmVmb3ggdmVyc2lvbikgYXJlIGtub3duXG4gKiB0byBzdXBwb3J0IFwiJWNcIiBDU1MgY3VzdG9taXphdGlvbnMuXG4gKlxuICogVE9ETzogYWRkIGEgYGxvY2FsU3RvcmFnZWAgdmFyaWFibGUgdG8gZXhwbGljaXRseSBlbmFibGUvZGlzYWJsZSBjb2xvcnNcbiAqL1xuXG5mdW5jdGlvbiB1c2VDb2xvcnMoKSB7XG4gIC8vIGlzIHdlYmtpdD8gaHR0cDovL3N0YWNrb3ZlcmZsb3cuY29tL2EvMTY0NTk2MDYvMzc2NzczXG4gIHJldHVybiAoJ1dlYmtpdEFwcGVhcmFuY2UnIGluIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5zdHlsZSkgfHxcbiAgICAvLyBpcyBmaXJlYnVnPyBodHRwOi8vc3RhY2tvdmVyZmxvdy5jb20vYS8zOTgxMjAvMzc2NzczXG4gICAgKHdpbmRvdy5jb25zb2xlICYmIChjb25zb2xlLmZpcmVidWcgfHwgKGNvbnNvbGUuZXhjZXB0aW9uICYmIGNvbnNvbGUudGFibGUpKSkgfHxcbiAgICAvLyBpcyBmaXJlZm94ID49IHYzMT9cbiAgICAvLyBodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1Rvb2xzL1dlYl9Db25zb2xlI1N0eWxpbmdfbWVzc2FnZXNcbiAgICAobmF2aWdhdG9yLnVzZXJBZ2VudC50b0xvd2VyQ2FzZSgpLm1hdGNoKC9maXJlZm94XFwvKFxcZCspLykgJiYgcGFyc2VJbnQoUmVnRXhwLiQxLCAxMCkgPj0gMzEpO1xufVxuXG4vKipcbiAqIE1hcCAlaiB0byBgSlNPTi5zdHJpbmdpZnkoKWAsIHNpbmNlIG5vIFdlYiBJbnNwZWN0b3JzIGRvIHRoYXQgYnkgZGVmYXVsdC5cbiAqL1xuXG5leHBvcnRzLmZvcm1hdHRlcnMuaiA9IGZ1bmN0aW9uKHYpIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHYpO1xufTtcblxuXG4vKipcbiAqIENvbG9yaXplIGxvZyBhcmd1bWVudHMgaWYgZW5hYmxlZC5cbiAqXG4gKiBAYXBpIHB1YmxpY1xuICovXG5cbmZ1bmN0aW9uIGZvcm1hdEFyZ3MoKSB7XG4gIHZhciBhcmdzID0gYXJndW1lbnRzO1xuICB2YXIgdXNlQ29sb3JzID0gdGhpcy51c2VDb2xvcnM7XG5cbiAgYXJnc1swXSA9ICh1c2VDb2xvcnMgPyAnJWMnIDogJycpXG4gICAgKyB0aGlzLm5hbWVzcGFjZVxuICAgICsgKHVzZUNvbG9ycyA/ICcgJWMnIDogJyAnKVxuICAgICsgYXJnc1swXVxuICAgICsgKHVzZUNvbG9ycyA/ICclYyAnIDogJyAnKVxuICAgICsgJysnICsgZXhwb3J0cy5odW1hbml6ZSh0aGlzLmRpZmYpO1xuXG4gIGlmICghdXNlQ29sb3JzKSByZXR1cm4gYXJncztcblxuICB2YXIgYyA9ICdjb2xvcjogJyArIHRoaXMuY29sb3I7XG4gIGFyZ3MgPSBbYXJnc1swXSwgYywgJ2NvbG9yOiBpbmhlcml0J10uY29uY2F0KEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3MsIDEpKTtcblxuICAvLyB0aGUgZmluYWwgXCIlY1wiIGlzIHNvbWV3aGF0IHRyaWNreSwgYmVjYXVzZSB0aGVyZSBjb3VsZCBiZSBvdGhlclxuICAvLyBhcmd1bWVudHMgcGFzc2VkIGVpdGhlciBiZWZvcmUgb3IgYWZ0ZXIgdGhlICVjLCBzbyB3ZSBuZWVkIHRvXG4gIC8vIGZpZ3VyZSBvdXQgdGhlIGNvcnJlY3QgaW5kZXggdG8gaW5zZXJ0IHRoZSBDU1MgaW50b1xuICB2YXIgaW5kZXggPSAwO1xuICB2YXIgbGFzdEMgPSAwO1xuICBhcmdzWzBdLnJlcGxhY2UoLyVbYS16JV0vZywgZnVuY3Rpb24obWF0Y2gpIHtcbiAgICBpZiAoJyUlJyA9PT0gbWF0Y2gpIHJldHVybjtcbiAgICBpbmRleCsrO1xuICAgIGlmICgnJWMnID09PSBtYXRjaCkge1xuICAgICAgLy8gd2Ugb25seSBhcmUgaW50ZXJlc3RlZCBpbiB0aGUgKmxhc3QqICVjXG4gICAgICAvLyAodGhlIHVzZXIgbWF5IGhhdmUgcHJvdmlkZWQgdGhlaXIgb3duKVxuICAgICAgbGFzdEMgPSBpbmRleDtcbiAgICB9XG4gIH0pO1xuXG4gIGFyZ3Muc3BsaWNlKGxhc3RDLCAwLCBjKTtcbiAgcmV0dXJuIGFyZ3M7XG59XG5cbi8qKlxuICogSW52b2tlcyBgY29uc29sZS5sb2coKWAgd2hlbiBhdmFpbGFibGUuXG4gKiBOby1vcCB3aGVuIGBjb25zb2xlLmxvZ2AgaXMgbm90IGEgXCJmdW5jdGlvblwiLlxuICpcbiAqIEBhcGkgcHVibGljXG4gKi9cblxuZnVuY3Rpb24gbG9nKCkge1xuICAvLyB0aGlzIGhhY2tlcnkgaXMgcmVxdWlyZWQgZm9yIElFOC85LCB3aGVyZVxuICAvLyB0aGUgYGNvbnNvbGUubG9nYCBmdW5jdGlvbiBkb2Vzbid0IGhhdmUgJ2FwcGx5J1xuICByZXR1cm4gJ29iamVjdCcgPT09IHR5cGVvZiBjb25zb2xlXG4gICAgJiYgY29uc29sZS5sb2dcbiAgICAmJiBGdW5jdGlvbi5wcm90b3R5cGUuYXBwbHkuY2FsbChjb25zb2xlLmxvZywgY29uc29sZSwgYXJndW1lbnRzKTtcbn1cblxuLyoqXG4gKiBTYXZlIGBuYW1lc3BhY2VzYC5cbiAqXG4gKiBAcGFyYW0ge1N0cmluZ30gbmFtZXNwYWNlc1xuICogQGFwaSBwcml2YXRlXG4gKi9cblxuZnVuY3Rpb24gc2F2ZShuYW1lc3BhY2VzKSB7XG4gIHRyeSB7XG4gICAgaWYgKG51bGwgPT0gbmFtZXNwYWNlcykge1xuICAgICAgZXhwb3J0cy5zdG9yYWdlLnJlbW92ZUl0ZW0oJ2RlYnVnJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGV4cG9ydHMuc3RvcmFnZS5kZWJ1ZyA9IG5hbWVzcGFjZXM7XG4gICAgfVxuICB9IGNhdGNoKGUpIHt9XG59XG5cbi8qKlxuICogTG9hZCBgbmFtZXNwYWNlc2AuXG4gKlxuICogQHJldHVybiB7U3RyaW5nfSByZXR1cm5zIHRoZSBwcmV2aW91c2x5IHBlcnNpc3RlZCBkZWJ1ZyBtb2Rlc1xuICogQGFwaSBwcml2YXRlXG4gKi9cblxuZnVuY3Rpb24gbG9hZCgpIHtcbiAgdmFyIHI7XG4gIHRyeSB7XG4gICAgciA9IGV4cG9ydHMuc3RvcmFnZS5kZWJ1ZztcbiAgfSBjYXRjaChlKSB7fVxuICByZXR1cm4gcjtcbn1cblxuLyoqXG4gKiBFbmFibGUgbmFtZXNwYWNlcyBsaXN0ZWQgaW4gYGxvY2FsU3RvcmFnZS5kZWJ1Z2AgaW5pdGlhbGx5LlxuICovXG5cbmV4cG9ydHMuZW5hYmxlKGxvYWQoKSk7XG5cbi8qKlxuICogTG9jYWxzdG9yYWdlIGF0dGVtcHRzIHRvIHJldHVybiB0aGUgbG9jYWxzdG9yYWdlLlxuICpcbiAqIFRoaXMgaXMgbmVjZXNzYXJ5IGJlY2F1c2Ugc2FmYXJpIHRocm93c1xuICogd2hlbiBhIHVzZXIgZGlzYWJsZXMgY29va2llcy9sb2NhbHN0b3JhZ2VcbiAqIGFuZCB5b3UgYXR0ZW1wdCB0byBhY2Nlc3MgaXQuXG4gKlxuICogQHJldHVybiB7TG9jYWxTdG9yYWdlfVxuICogQGFwaSBwcml2YXRlXG4gKi9cblxuZnVuY3Rpb24gbG9jYWxzdG9yYWdlKCl7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHdpbmRvdy5sb2NhbFN0b3JhZ2U7XG4gIH0gY2F0Y2ggKGUpIHt9XG59XG4iLCJcbi8qKlxuICogVGhpcyBpcyB0aGUgY29tbW9uIGxvZ2ljIGZvciBib3RoIHRoZSBOb2RlLmpzIGFuZCB3ZWIgYnJvd3NlclxuICogaW1wbGVtZW50YXRpb25zIG9mIGBkZWJ1ZygpYC5cbiAqXG4gKiBFeHBvc2UgYGRlYnVnKClgIGFzIHRoZSBtb2R1bGUuXG4gKi9cblxuZXhwb3J0cyA9IG1vZHVsZS5leHBvcnRzID0gZGVidWc7XG5leHBvcnRzLmNvZXJjZSA9IGNvZXJjZTtcbmV4cG9ydHMuZGlzYWJsZSA9IGRpc2FibGU7XG5leHBvcnRzLmVuYWJsZSA9IGVuYWJsZTtcbmV4cG9ydHMuZW5hYmxlZCA9IGVuYWJsZWQ7XG5leHBvcnRzLmh1bWFuaXplID0gcmVxdWlyZSgnbXMnKTtcblxuLyoqXG4gKiBUaGUgY3VycmVudGx5IGFjdGl2ZSBkZWJ1ZyBtb2RlIG5hbWVzLCBhbmQgbmFtZXMgdG8gc2tpcC5cbiAqL1xuXG5leHBvcnRzLm5hbWVzID0gW107XG5leHBvcnRzLnNraXBzID0gW107XG5cbi8qKlxuICogTWFwIG9mIHNwZWNpYWwgXCIlblwiIGhhbmRsaW5nIGZ1bmN0aW9ucywgZm9yIHRoZSBkZWJ1ZyBcImZvcm1hdFwiIGFyZ3VtZW50LlxuICpcbiAqIFZhbGlkIGtleSBuYW1lcyBhcmUgYSBzaW5nbGUsIGxvd2VyY2FzZWQgbGV0dGVyLCBpLmUuIFwiblwiLlxuICovXG5cbmV4cG9ydHMuZm9ybWF0dGVycyA9IHt9O1xuXG4vKipcbiAqIFByZXZpb3VzbHkgYXNzaWduZWQgY29sb3IuXG4gKi9cblxudmFyIHByZXZDb2xvciA9IDA7XG5cbi8qKlxuICogUHJldmlvdXMgbG9nIHRpbWVzdGFtcC5cbiAqL1xuXG52YXIgcHJldlRpbWU7XG5cbi8qKlxuICogU2VsZWN0IGEgY29sb3IuXG4gKlxuICogQHJldHVybiB7TnVtYmVyfVxuICogQGFwaSBwcml2YXRlXG4gKi9cblxuZnVuY3Rpb24gc2VsZWN0Q29sb3IoKSB7XG4gIHJldHVybiBleHBvcnRzLmNvbG9yc1twcmV2Q29sb3IrKyAlIGV4cG9ydHMuY29sb3JzLmxlbmd0aF07XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgZGVidWdnZXIgd2l0aCB0aGUgZ2l2ZW4gYG5hbWVzcGFjZWAuXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IG5hbWVzcGFjZVxuICogQHJldHVybiB7RnVuY3Rpb259XG4gKiBAYXBpIHB1YmxpY1xuICovXG5cbmZ1bmN0aW9uIGRlYnVnKG5hbWVzcGFjZSkge1xuXG4gIC8vIGRlZmluZSB0aGUgYGRpc2FibGVkYCB2ZXJzaW9uXG4gIGZ1bmN0aW9uIGRpc2FibGVkKCkge1xuICB9XG4gIGRpc2FibGVkLmVuYWJsZWQgPSBmYWxzZTtcblxuICAvLyBkZWZpbmUgdGhlIGBlbmFibGVkYCB2ZXJzaW9uXG4gIGZ1bmN0aW9uIGVuYWJsZWQoKSB7XG5cbiAgICB2YXIgc2VsZiA9IGVuYWJsZWQ7XG5cbiAgICAvLyBzZXQgYGRpZmZgIHRpbWVzdGFtcFxuICAgIHZhciBjdXJyID0gK25ldyBEYXRlKCk7XG4gICAgdmFyIG1zID0gY3VyciAtIChwcmV2VGltZSB8fCBjdXJyKTtcbiAgICBzZWxmLmRpZmYgPSBtcztcbiAgICBzZWxmLnByZXYgPSBwcmV2VGltZTtcbiAgICBzZWxmLmN1cnIgPSBjdXJyO1xuICAgIHByZXZUaW1lID0gY3VycjtcblxuICAgIC8vIGFkZCB0aGUgYGNvbG9yYCBpZiBub3Qgc2V0XG4gICAgaWYgKG51bGwgPT0gc2VsZi51c2VDb2xvcnMpIHNlbGYudXNlQ29sb3JzID0gZXhwb3J0cy51c2VDb2xvcnMoKTtcbiAgICBpZiAobnVsbCA9PSBzZWxmLmNvbG9yICYmIHNlbGYudXNlQ29sb3JzKSBzZWxmLmNvbG9yID0gc2VsZWN0Q29sb3IoKTtcblxuICAgIHZhciBhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzKTtcblxuICAgIGFyZ3NbMF0gPSBleHBvcnRzLmNvZXJjZShhcmdzWzBdKTtcblxuICAgIGlmICgnc3RyaW5nJyAhPT0gdHlwZW9mIGFyZ3NbMF0pIHtcbiAgICAgIC8vIGFueXRoaW5nIGVsc2UgbGV0J3MgaW5zcGVjdCB3aXRoICVvXG4gICAgICBhcmdzID0gWyclbyddLmNvbmNhdChhcmdzKTtcbiAgICB9XG5cbiAgICAvLyBhcHBseSBhbnkgYGZvcm1hdHRlcnNgIHRyYW5zZm9ybWF0aW9uc1xuICAgIHZhciBpbmRleCA9IDA7XG4gICAgYXJnc1swXSA9IGFyZ3NbMF0ucmVwbGFjZSgvJShbYS16JV0pL2csIGZ1bmN0aW9uKG1hdGNoLCBmb3JtYXQpIHtcbiAgICAgIC8vIGlmIHdlIGVuY291bnRlciBhbiBlc2NhcGVkICUgdGhlbiBkb24ndCBpbmNyZWFzZSB0aGUgYXJyYXkgaW5kZXhcbiAgICAgIGlmIChtYXRjaCA9PT0gJyUlJykgcmV0dXJuIG1hdGNoO1xuICAgICAgaW5kZXgrKztcbiAgICAgIHZhciBmb3JtYXR0ZXIgPSBleHBvcnRzLmZvcm1hdHRlcnNbZm9ybWF0XTtcbiAgICAgIGlmICgnZnVuY3Rpb24nID09PSB0eXBlb2YgZm9ybWF0dGVyKSB7XG4gICAgICAgIHZhciB2YWwgPSBhcmdzW2luZGV4XTtcbiAgICAgICAgbWF0Y2ggPSBmb3JtYXR0ZXIuY2FsbChzZWxmLCB2YWwpO1xuXG4gICAgICAgIC8vIG5vdyB3ZSBuZWVkIHRvIHJlbW92ZSBgYXJnc1tpbmRleF1gIHNpbmNlIGl0J3MgaW5saW5lZCBpbiB0aGUgYGZvcm1hdGBcbiAgICAgICAgYXJncy5zcGxpY2UoaW5kZXgsIDEpO1xuICAgICAgICBpbmRleC0tO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG1hdGNoO1xuICAgIH0pO1xuXG4gICAgaWYgKCdmdW5jdGlvbicgPT09IHR5cGVvZiBleHBvcnRzLmZvcm1hdEFyZ3MpIHtcbiAgICAgIGFyZ3MgPSBleHBvcnRzLmZvcm1hdEFyZ3MuYXBwbHkoc2VsZiwgYXJncyk7XG4gICAgfVxuICAgIHZhciBsb2dGbiA9IGVuYWJsZWQubG9nIHx8IGV4cG9ydHMubG9nIHx8IGNvbnNvbGUubG9nLmJpbmQoY29uc29sZSk7XG4gICAgbG9nRm4uYXBwbHkoc2VsZiwgYXJncyk7XG4gIH1cbiAgZW5hYmxlZC5lbmFibGVkID0gdHJ1ZTtcblxuICB2YXIgZm4gPSBleHBvcnRzLmVuYWJsZWQobmFtZXNwYWNlKSA/IGVuYWJsZWQgOiBkaXNhYmxlZDtcblxuICBmbi5uYW1lc3BhY2UgPSBuYW1lc3BhY2U7XG5cbiAgcmV0dXJuIGZuO1xufVxuXG4vKipcbiAqIEVuYWJsZXMgYSBkZWJ1ZyBtb2RlIGJ5IG5hbWVzcGFjZXMuIFRoaXMgY2FuIGluY2x1ZGUgbW9kZXNcbiAqIHNlcGFyYXRlZCBieSBhIGNvbG9uIGFuZCB3aWxkY2FyZHMuXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IG5hbWVzcGFjZXNcbiAqIEBhcGkgcHVibGljXG4gKi9cblxuZnVuY3Rpb24gZW5hYmxlKG5hbWVzcGFjZXMpIHtcbiAgZXhwb3J0cy5zYXZlKG5hbWVzcGFjZXMpO1xuXG4gIHZhciBzcGxpdCA9IChuYW1lc3BhY2VzIHx8ICcnKS5zcGxpdCgvW1xccyxdKy8pO1xuICB2YXIgbGVuID0gc3BsaXQubGVuZ3RoO1xuXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuOyBpKyspIHtcbiAgICBpZiAoIXNwbGl0W2ldKSBjb250aW51ZTsgLy8gaWdub3JlIGVtcHR5IHN0cmluZ3NcbiAgICBuYW1lc3BhY2VzID0gc3BsaXRbaV0ucmVwbGFjZSgvXFwqL2csICcuKj8nKTtcbiAgICBpZiAobmFtZXNwYWNlc1swXSA9PT0gJy0nKSB7XG4gICAgICBleHBvcnRzLnNraXBzLnB1c2gobmV3IFJlZ0V4cCgnXicgKyBuYW1lc3BhY2VzLnN1YnN0cigxKSArICckJykpO1xuICAgIH0gZWxzZSB7XG4gICAgICBleHBvcnRzLm5hbWVzLnB1c2gobmV3IFJlZ0V4cCgnXicgKyBuYW1lc3BhY2VzICsgJyQnKSk7XG4gICAgfVxuICB9XG59XG5cbi8qKlxuICogRGlzYWJsZSBkZWJ1ZyBvdXRwdXQuXG4gKlxuICogQGFwaSBwdWJsaWNcbiAqL1xuXG5mdW5jdGlvbiBkaXNhYmxlKCkge1xuICBleHBvcnRzLmVuYWJsZSgnJyk7XG59XG5cbi8qKlxuICogUmV0dXJucyB0cnVlIGlmIHRoZSBnaXZlbiBtb2RlIG5hbWUgaXMgZW5hYmxlZCwgZmFsc2Ugb3RoZXJ3aXNlLlxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSBuYW1lXG4gKiBAcmV0dXJuIHtCb29sZWFufVxuICogQGFwaSBwdWJsaWNcbiAqL1xuXG5mdW5jdGlvbiBlbmFibGVkKG5hbWUpIHtcbiAgdmFyIGksIGxlbjtcbiAgZm9yIChpID0gMCwgbGVuID0gZXhwb3J0cy5za2lwcy5sZW5ndGg7IGkgPCBsZW47IGkrKykge1xuICAgIGlmIChleHBvcnRzLnNraXBzW2ldLnRlc3QobmFtZSkpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cbiAgZm9yIChpID0gMCwgbGVuID0gZXhwb3J0cy5uYW1lcy5sZW5ndGg7IGkgPCBsZW47IGkrKykge1xuICAgIGlmIChleHBvcnRzLm5hbWVzW2ldLnRlc3QobmFtZSkpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKlxuICogQ29lcmNlIGB2YWxgLlxuICpcbiAqIEBwYXJhbSB7TWl4ZWR9IHZhbFxuICogQHJldHVybiB7TWl4ZWR9XG4gKiBAYXBpIHByaXZhdGVcbiAqL1xuXG5mdW5jdGlvbiBjb2VyY2UodmFsKSB7XG4gIGlmICh2YWwgaW5zdGFuY2VvZiBFcnJvcikgcmV0dXJuIHZhbC5zdGFjayB8fCB2YWwubWVzc2FnZTtcbiAgcmV0dXJuIHZhbDtcbn1cbiIsIi8qKlxuICogSGVscGVycy5cbiAqL1xuXG52YXIgcyA9IDEwMDA7XG52YXIgbSA9IHMgKiA2MDtcbnZhciBoID0gbSAqIDYwO1xudmFyIGQgPSBoICogMjQ7XG52YXIgeSA9IGQgKiAzNjUuMjU7XG5cbi8qKlxuICogUGFyc2Ugb3IgZm9ybWF0IHRoZSBnaXZlbiBgdmFsYC5cbiAqXG4gKiBPcHRpb25zOlxuICpcbiAqICAtIGBsb25nYCB2ZXJib3NlIGZvcm1hdHRpbmcgW2ZhbHNlXVxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfE51bWJlcn0gdmFsXG4gKiBAcGFyYW0ge09iamVjdH0gb3B0aW9uc1xuICogQHJldHVybiB7U3RyaW5nfE51bWJlcn1cbiAqIEBhcGkgcHVibGljXG4gKi9cblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbih2YWwsIG9wdGlvbnMpe1xuICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgaWYgKCdzdHJpbmcnID09IHR5cGVvZiB2YWwpIHJldHVybiBwYXJzZSh2YWwpO1xuICByZXR1cm4gb3B0aW9ucy5sb25nXG4gICAgPyBsb25nKHZhbClcbiAgICA6IHNob3J0KHZhbCk7XG59O1xuXG4vKipcbiAqIFBhcnNlIHRoZSBnaXZlbiBgc3RyYCBhbmQgcmV0dXJuIG1pbGxpc2Vjb25kcy5cbiAqXG4gKiBAcGFyYW0ge1N0cmluZ30gc3RyXG4gKiBAcmV0dXJuIHtOdW1iZXJ9XG4gKiBAYXBpIHByaXZhdGVcbiAqL1xuXG5mdW5jdGlvbiBwYXJzZShzdHIpIHtcbiAgc3RyID0gJycgKyBzdHI7XG4gIGlmIChzdHIubGVuZ3RoID4gMTAwMDApIHJldHVybjtcbiAgdmFyIG1hdGNoID0gL14oKD86XFxkKyk/XFwuP1xcZCspICoobWlsbGlzZWNvbmRzP3xtc2Vjcz98bXN8c2Vjb25kcz98c2Vjcz98c3xtaW51dGVzP3xtaW5zP3xtfGhvdXJzP3xocnM/fGh8ZGF5cz98ZHx5ZWFycz98eXJzP3x5KT8kL2kuZXhlYyhzdHIpO1xuICBpZiAoIW1hdGNoKSByZXR1cm47XG4gIHZhciBuID0gcGFyc2VGbG9hdChtYXRjaFsxXSk7XG4gIHZhciB0eXBlID0gKG1hdGNoWzJdIHx8ICdtcycpLnRvTG93ZXJDYXNlKCk7XG4gIHN3aXRjaCAodHlwZSkge1xuICAgIGNhc2UgJ3llYXJzJzpcbiAgICBjYXNlICd5ZWFyJzpcbiAgICBjYXNlICd5cnMnOlxuICAgIGNhc2UgJ3lyJzpcbiAgICBjYXNlICd5JzpcbiAgICAgIHJldHVybiBuICogeTtcbiAgICBjYXNlICdkYXlzJzpcbiAgICBjYXNlICdkYXknOlxuICAgIGNhc2UgJ2QnOlxuICAgICAgcmV0dXJuIG4gKiBkO1xuICAgIGNhc2UgJ2hvdXJzJzpcbiAgICBjYXNlICdob3VyJzpcbiAgICBjYXNlICdocnMnOlxuICAgIGNhc2UgJ2hyJzpcbiAgICBjYXNlICdoJzpcbiAgICAgIHJldHVybiBuICogaDtcbiAgICBjYXNlICdtaW51dGVzJzpcbiAgICBjYXNlICdtaW51dGUnOlxuICAgIGNhc2UgJ21pbnMnOlxuICAgIGNhc2UgJ21pbic6XG4gICAgY2FzZSAnbSc6XG4gICAgICByZXR1cm4gbiAqIG07XG4gICAgY2FzZSAnc2Vjb25kcyc6XG4gICAgY2FzZSAnc2Vjb25kJzpcbiAgICBjYXNlICdzZWNzJzpcbiAgICBjYXNlICdzZWMnOlxuICAgIGNhc2UgJ3MnOlxuICAgICAgcmV0dXJuIG4gKiBzO1xuICAgIGNhc2UgJ21pbGxpc2Vjb25kcyc6XG4gICAgY2FzZSAnbWlsbGlzZWNvbmQnOlxuICAgIGNhc2UgJ21zZWNzJzpcbiAgICBjYXNlICdtc2VjJzpcbiAgICBjYXNlICdtcyc6XG4gICAgICByZXR1cm4gbjtcbiAgfVxufVxuXG4vKipcbiAqIFNob3J0IGZvcm1hdCBmb3IgYG1zYC5cbiAqXG4gKiBAcGFyYW0ge051bWJlcn0gbXNcbiAqIEByZXR1cm4ge1N0cmluZ31cbiAqIEBhcGkgcHJpdmF0ZVxuICovXG5cbmZ1bmN0aW9uIHNob3J0KG1zKSB7XG4gIGlmIChtcyA+PSBkKSByZXR1cm4gTWF0aC5yb3VuZChtcyAvIGQpICsgJ2QnO1xuICBpZiAobXMgPj0gaCkgcmV0dXJuIE1hdGgucm91bmQobXMgLyBoKSArICdoJztcbiAgaWYgKG1zID49IG0pIHJldHVybiBNYXRoLnJvdW5kKG1zIC8gbSkgKyAnbSc7XG4gIGlmIChtcyA+PSBzKSByZXR1cm4gTWF0aC5yb3VuZChtcyAvIHMpICsgJ3MnO1xuICByZXR1cm4gbXMgKyAnbXMnO1xufVxuXG4vKipcbiAqIExvbmcgZm9ybWF0IGZvciBgbXNgLlxuICpcbiAqIEBwYXJhbSB7TnVtYmVyfSBtc1xuICogQHJldHVybiB7U3RyaW5nfVxuICogQGFwaSBwcml2YXRlXG4gKi9cblxuZnVuY3Rpb24gbG9uZyhtcykge1xuICByZXR1cm4gcGx1cmFsKG1zLCBkLCAnZGF5JylcbiAgICB8fCBwbHVyYWwobXMsIGgsICdob3VyJylcbiAgICB8fCBwbHVyYWwobXMsIG0sICdtaW51dGUnKVxuICAgIHx8IHBsdXJhbChtcywgcywgJ3NlY29uZCcpXG4gICAgfHwgbXMgKyAnIG1zJztcbn1cblxuLyoqXG4gKiBQbHVyYWxpemF0aW9uIGhlbHBlci5cbiAqL1xuXG5mdW5jdGlvbiBwbHVyYWwobXMsIG4sIG5hbWUpIHtcbiAgaWYgKG1zIDwgbikgcmV0dXJuO1xuICBpZiAobXMgPCBuICogMS41KSByZXR1cm4gTWF0aC5mbG9vcihtcyAvIG4pICsgJyAnICsgbmFtZTtcbiAgcmV0dXJuIE1hdGguY2VpbChtcyAvIG4pICsgJyAnICsgbmFtZSArICdzJztcbn1cbiIsInZhciBoYXQgPSBtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChiaXRzLCBiYXNlKSB7XG4gICAgaWYgKCFiYXNlKSBiYXNlID0gMTY7XG4gICAgaWYgKGJpdHMgPT09IHVuZGVmaW5lZCkgYml0cyA9IDEyODtcbiAgICBpZiAoYml0cyA8PSAwKSByZXR1cm4gJzAnO1xuICAgIFxuICAgIHZhciBkaWdpdHMgPSBNYXRoLmxvZyhNYXRoLnBvdygyLCBiaXRzKSkgLyBNYXRoLmxvZyhiYXNlKTtcbiAgICBmb3IgKHZhciBpID0gMjsgZGlnaXRzID09PSBJbmZpbml0eTsgaSAqPSAyKSB7XG4gICAgICAgIGRpZ2l0cyA9IE1hdGgubG9nKE1hdGgucG93KDIsIGJpdHMgLyBpKSkgLyBNYXRoLmxvZyhiYXNlKSAqIGk7XG4gICAgfVxuICAgIFxuICAgIHZhciByZW0gPSBkaWdpdHMgLSBNYXRoLmZsb29yKGRpZ2l0cyk7XG4gICAgXG4gICAgdmFyIHJlcyA9ICcnO1xuICAgIFxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgTWF0aC5mbG9vcihkaWdpdHMpOyBpKyspIHtcbiAgICAgICAgdmFyIHggPSBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBiYXNlKS50b1N0cmluZyhiYXNlKTtcbiAgICAgICAgcmVzID0geCArIHJlcztcbiAgICB9XG4gICAgXG4gICAgaWYgKHJlbSkge1xuICAgICAgICB2YXIgYiA9IE1hdGgucG93KGJhc2UsIHJlbSk7XG4gICAgICAgIHZhciB4ID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogYikudG9TdHJpbmcoYmFzZSk7XG4gICAgICAgIHJlcyA9IHggKyByZXM7XG4gICAgfVxuICAgIFxuICAgIHZhciBwYXJzZWQgPSBwYXJzZUludChyZXMsIGJhc2UpO1xuICAgIGlmIChwYXJzZWQgIT09IEluZmluaXR5ICYmIHBhcnNlZCA+PSBNYXRoLnBvdygyLCBiaXRzKSkge1xuICAgICAgICByZXR1cm4gaGF0KGJpdHMsIGJhc2UpXG4gICAgfVxuICAgIGVsc2UgcmV0dXJuIHJlcztcbn07XG5cbmhhdC5yYWNrID0gZnVuY3Rpb24gKGJpdHMsIGJhc2UsIGV4cGFuZEJ5KSB7XG4gICAgdmFyIGZuID0gZnVuY3Rpb24gKGRhdGEpIHtcbiAgICAgICAgdmFyIGl0ZXJzID0gMDtcbiAgICAgICAgZG8ge1xuICAgICAgICAgICAgaWYgKGl0ZXJzICsrID4gMTApIHtcbiAgICAgICAgICAgICAgICBpZiAoZXhwYW5kQnkpIGJpdHMgKz0gZXhwYW5kQnk7XG4gICAgICAgICAgICAgICAgZWxzZSB0aHJvdyBuZXcgRXJyb3IoJ3RvbyBtYW55IElEIGNvbGxpc2lvbnMsIHVzZSBtb3JlIGJpdHMnKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICB2YXIgaWQgPSBoYXQoYml0cywgYmFzZSk7XG4gICAgICAgIH0gd2hpbGUgKE9iamVjdC5oYXNPd25Qcm9wZXJ0eS5jYWxsKGhhdHMsIGlkKSk7XG4gICAgICAgIFxuICAgICAgICBoYXRzW2lkXSA9IGRhdGE7XG4gICAgICAgIHJldHVybiBpZDtcbiAgICB9O1xuICAgIHZhciBoYXRzID0gZm4uaGF0cyA9IHt9O1xuICAgIFxuICAgIGZuLmdldCA9IGZ1bmN0aW9uIChpZCkge1xuICAgICAgICByZXR1cm4gZm4uaGF0c1tpZF07XG4gICAgfTtcbiAgICBcbiAgICBmbi5zZXQgPSBmdW5jdGlvbiAoaWQsIHZhbHVlKSB7XG4gICAgICAgIGZuLmhhdHNbaWRdID0gdmFsdWU7XG4gICAgICAgIHJldHVybiBmbjtcbiAgICB9O1xuICAgIFxuICAgIGZuLmJpdHMgPSBiaXRzIHx8IDEyODtcbiAgICBmbi5iYXNlID0gYmFzZSB8fCAxNjtcbiAgICByZXR1cm4gZm47XG59O1xuIiwiaWYgKHR5cGVvZiBPYmplY3QuY3JlYXRlID09PSAnZnVuY3Rpb24nKSB7XG4gIC8vIGltcGxlbWVudGF0aW9uIGZyb20gc3RhbmRhcmQgbm9kZS5qcyAndXRpbCcgbW9kdWxlXG4gIG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gaW5oZXJpdHMoY3Rvciwgc3VwZXJDdG9yKSB7XG4gICAgY3Rvci5zdXBlcl8gPSBzdXBlckN0b3JcbiAgICBjdG9yLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoc3VwZXJDdG9yLnByb3RvdHlwZSwge1xuICAgICAgY29uc3RydWN0b3I6IHtcbiAgICAgICAgdmFsdWU6IGN0b3IsXG4gICAgICAgIGVudW1lcmFibGU6IGZhbHNlLFxuICAgICAgICB3cml0YWJsZTogdHJ1ZSxcbiAgICAgICAgY29uZmlndXJhYmxlOiB0cnVlXG4gICAgICB9XG4gICAgfSk7XG4gIH07XG59IGVsc2Uge1xuICAvLyBvbGQgc2Nob29sIHNoaW0gZm9yIG9sZCBicm93c2Vyc1xuICBtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIGluaGVyaXRzKGN0b3IsIHN1cGVyQ3Rvcikge1xuICAgIGN0b3Iuc3VwZXJfID0gc3VwZXJDdG9yXG4gICAgdmFyIFRlbXBDdG9yID0gZnVuY3Rpb24gKCkge31cbiAgICBUZW1wQ3Rvci5wcm90b3R5cGUgPSBzdXBlckN0b3IucHJvdG90eXBlXG4gICAgY3Rvci5wcm90b3R5cGUgPSBuZXcgVGVtcEN0b3IoKVxuICAgIGN0b3IucHJvdG90eXBlLmNvbnN0cnVjdG9yID0gY3RvclxuICB9XG59XG4iLCJtb2R1bGUuZXhwb3J0cyAgICAgID0gaXNUeXBlZEFycmF5XG5pc1R5cGVkQXJyYXkuc3RyaWN0ID0gaXNTdHJpY3RUeXBlZEFycmF5XG5pc1R5cGVkQXJyYXkubG9vc2UgID0gaXNMb29zZVR5cGVkQXJyYXlcblxudmFyIHRvU3RyaW5nID0gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZ1xudmFyIG5hbWVzID0ge1xuICAgICdbb2JqZWN0IEludDhBcnJheV0nOiB0cnVlXG4gICwgJ1tvYmplY3QgSW50MTZBcnJheV0nOiB0cnVlXG4gICwgJ1tvYmplY3QgSW50MzJBcnJheV0nOiB0cnVlXG4gICwgJ1tvYmplY3QgVWludDhBcnJheV0nOiB0cnVlXG4gICwgJ1tvYmplY3QgVWludDhDbGFtcGVkQXJyYXldJzogdHJ1ZVxuICAsICdbb2JqZWN0IFVpbnQxNkFycmF5XSc6IHRydWVcbiAgLCAnW29iamVjdCBVaW50MzJBcnJheV0nOiB0cnVlXG4gICwgJ1tvYmplY3QgRmxvYXQzMkFycmF5XSc6IHRydWVcbiAgLCAnW29iamVjdCBGbG9hdDY0QXJyYXldJzogdHJ1ZVxufVxuXG5mdW5jdGlvbiBpc1R5cGVkQXJyYXkoYXJyKSB7XG4gIHJldHVybiAoXG4gICAgICAgaXNTdHJpY3RUeXBlZEFycmF5KGFycilcbiAgICB8fCBpc0xvb3NlVHlwZWRBcnJheShhcnIpXG4gIClcbn1cblxuZnVuY3Rpb24gaXNTdHJpY3RUeXBlZEFycmF5KGFycikge1xuICByZXR1cm4gKFxuICAgICAgIGFyciBpbnN0YW5jZW9mIEludDhBcnJheVxuICAgIHx8IGFyciBpbnN0YW5jZW9mIEludDE2QXJyYXlcbiAgICB8fCBhcnIgaW5zdGFuY2VvZiBJbnQzMkFycmF5XG4gICAgfHwgYXJyIGluc3RhbmNlb2YgVWludDhBcnJheVxuICAgIHx8IGFyciBpbnN0YW5jZW9mIFVpbnQ4Q2xhbXBlZEFycmF5XG4gICAgfHwgYXJyIGluc3RhbmNlb2YgVWludDE2QXJyYXlcbiAgICB8fCBhcnIgaW5zdGFuY2VvZiBVaW50MzJBcnJheVxuICAgIHx8IGFyciBpbnN0YW5jZW9mIEZsb2F0MzJBcnJheVxuICAgIHx8IGFyciBpbnN0YW5jZW9mIEZsb2F0NjRBcnJheVxuICApXG59XG5cbmZ1bmN0aW9uIGlzTG9vc2VUeXBlZEFycmF5KGFycikge1xuICByZXR1cm4gbmFtZXNbdG9TdHJpbmcuY2FsbChhcnIpXVxufVxuIiwiLy8gUmV0dXJucyBhIHdyYXBwZXIgZnVuY3Rpb24gdGhhdCByZXR1cm5zIGEgd3JhcHBlZCBjYWxsYmFja1xuLy8gVGhlIHdyYXBwZXIgZnVuY3Rpb24gc2hvdWxkIGRvIHNvbWUgc3R1ZmYsIGFuZCByZXR1cm4gYVxuLy8gcHJlc3VtYWJseSBkaWZmZXJlbnQgY2FsbGJhY2sgZnVuY3Rpb24uXG4vLyBUaGlzIG1ha2VzIHN1cmUgdGhhdCBvd24gcHJvcGVydGllcyBhcmUgcmV0YWluZWQsIHNvIHRoYXRcbi8vIGRlY29yYXRpb25zIGFuZCBzdWNoIGFyZSBub3QgbG9zdCBhbG9uZyB0aGUgd2F5LlxubW9kdWxlLmV4cG9ydHMgPSB3cmFwcHlcbmZ1bmN0aW9uIHdyYXBweSAoZm4sIGNiKSB7XG4gIGlmIChmbiAmJiBjYikgcmV0dXJuIHdyYXBweShmbikoY2IpXG5cbiAgaWYgKHR5cGVvZiBmbiAhPT0gJ2Z1bmN0aW9uJylcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCduZWVkIHdyYXBwZXIgZnVuY3Rpb24nKVxuXG4gIE9iamVjdC5rZXlzKGZuKS5mb3JFYWNoKGZ1bmN0aW9uIChrKSB7XG4gICAgd3JhcHBlcltrXSA9IGZuW2tdXG4gIH0pXG5cbiAgcmV0dXJuIHdyYXBwZXJcblxuICBmdW5jdGlvbiB3cmFwcGVyKCkge1xuICAgIHZhciBhcmdzID0gbmV3IEFycmF5KGFyZ3VtZW50cy5sZW5ndGgpXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBhcmdzW2ldID0gYXJndW1lbnRzW2ldXG4gICAgfVxuICAgIHZhciByZXQgPSBmbi5hcHBseSh0aGlzLCBhcmdzKVxuICAgIHZhciBjYiA9IGFyZ3NbYXJncy5sZW5ndGgtMV1cbiAgICBpZiAodHlwZW9mIHJldCA9PT0gJ2Z1bmN0aW9uJyAmJiByZXQgIT09IGNiKSB7XG4gICAgICBPYmplY3Qua2V5cyhjYikuZm9yRWFjaChmdW5jdGlvbiAoaykge1xuICAgICAgICByZXRba10gPSBjYltrXVxuICAgICAgfSlcbiAgICB9XG4gICAgcmV0dXJuIHJldFxuICB9XG59XG4iLCJ2YXIgd3JhcHB5ID0gcmVxdWlyZSgnd3JhcHB5Jylcbm1vZHVsZS5leHBvcnRzID0gd3JhcHB5KG9uY2UpXG5cbm9uY2UucHJvdG8gPSBvbmNlKGZ1bmN0aW9uICgpIHtcbiAgT2JqZWN0LmRlZmluZVByb3BlcnR5KEZ1bmN0aW9uLnByb3RvdHlwZSwgJ29uY2UnLCB7XG4gICAgdmFsdWU6IGZ1bmN0aW9uICgpIHtcbiAgICAgIHJldHVybiBvbmNlKHRoaXMpXG4gICAgfSxcbiAgICBjb25maWd1cmFibGU6IHRydWVcbiAgfSlcbn0pXG5cbmZ1bmN0aW9uIG9uY2UgKGZuKSB7XG4gIHZhciBmID0gZnVuY3Rpb24gKCkge1xuICAgIGlmIChmLmNhbGxlZCkgcmV0dXJuIGYudmFsdWVcbiAgICBmLmNhbGxlZCA9IHRydWVcbiAgICByZXR1cm4gZi52YWx1ZSA9IGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cylcbiAgfVxuICBmLmNhbGxlZCA9IGZhbHNlXG4gIHJldHVybiBmXG59XG4iLCIoZnVuY3Rpb24gKEJ1ZmZlcil7XG4vKipcbiAqIENvbnZlcnQgYSB0eXBlZCBhcnJheSB0byBhIEJ1ZmZlciB3aXRob3V0IGEgY29weVxuICpcbiAqIEF1dGhvcjogICBGZXJvc3MgQWJvdWtoYWRpamVoIDxmZXJvc3NAZmVyb3NzLm9yZz4gPGh0dHA6Ly9mZXJvc3Mub3JnPlxuICogTGljZW5zZTogIE1JVFxuICpcbiAqIGBucG0gaW5zdGFsbCB0eXBlZGFycmF5LXRvLWJ1ZmZlcmBcbiAqL1xuXG52YXIgaXNUeXBlZEFycmF5ID0gcmVxdWlyZSgnaXMtdHlwZWRhcnJheScpLnN0cmljdFxuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChhcnIpIHtcbiAgLy8gSWYgYEJ1ZmZlcmAgaXMgdGhlIGJyb3dzZXIgYGJ1ZmZlcmAgbW9kdWxlLCBhbmQgdGhlIGJyb3dzZXIgc3VwcG9ydHMgdHlwZWQgYXJyYXlzLFxuICAvLyB0aGVuIGF2b2lkIGEgY29weS4gT3RoZXJ3aXNlLCBjcmVhdGUgYSBgQnVmZmVyYCB3aXRoIGEgY29weS5cbiAgdmFyIGNvbnN0cnVjdG9yID0gQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlRcbiAgICA/IEJ1ZmZlci5fYXVnbWVudFxuICAgIDogZnVuY3Rpb24gKGFycikgeyByZXR1cm4gbmV3IEJ1ZmZlcihhcnIpIH1cblxuICBpZiAoYXJyIGluc3RhbmNlb2YgVWludDhBcnJheSkge1xuICAgIHJldHVybiBjb25zdHJ1Y3RvcihhcnIpXG4gIH0gZWxzZSBpZiAoYXJyIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpIHtcbiAgICByZXR1cm4gY29uc3RydWN0b3IobmV3IFVpbnQ4QXJyYXkoYXJyKSlcbiAgfSBlbHNlIGlmIChpc1R5cGVkQXJyYXkoYXJyKSkge1xuICAgIC8vIFVzZSB0aGUgdHlwZWQgYXJyYXkncyB1bmRlcmx5aW5nIEFycmF5QnVmZmVyIHRvIGJhY2sgbmV3IEJ1ZmZlci4gVGhpcyByZXNwZWN0c1xuICAgIC8vIHRoZSBcInZpZXdcIiBvbiB0aGUgQXJyYXlCdWZmZXIsIGkuZS4gYnl0ZU9mZnNldCBhbmQgYnl0ZUxlbmd0aC4gTm8gY29weS5cbiAgICByZXR1cm4gY29uc3RydWN0b3IobmV3IFVpbnQ4QXJyYXkoYXJyLmJ1ZmZlciwgYXJyLmJ5dGVPZmZzZXQsIGFyci5ieXRlTGVuZ3RoKSlcbiAgfSBlbHNlIHtcbiAgICAvLyBVbnN1cHBvcnRlZCB0eXBlLCBqdXN0IHBhc3MgaXQgdGhyb3VnaCB0byB0aGUgYEJ1ZmZlcmAgY29uc3RydWN0b3IuXG4gICAgcmV0dXJuIG5ldyBCdWZmZXIoYXJyKVxuICB9XG59XG5cbn0pLmNhbGwodGhpcyxyZXF1aXJlKFwiYnVmZmVyXCIpLkJ1ZmZlcikiLCIndXNlIHN0cmljdCc7XG5tb2R1bGUuZXhwb3J0cyA9IFNvcnRlZEFycmF5XG52YXIgc2VhcmNoID0gcmVxdWlyZSgnYmluYXJ5LXNlYXJjaCcpXG5cbmZ1bmN0aW9uIFNvcnRlZEFycmF5KGNtcCwgYXJyKSB7XG4gIGlmICh0eXBlb2YgY21wICE9ICdmdW5jdGlvbicpXG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignY29tcGFyYXRvciBtdXN0IGJlIGEgZnVuY3Rpb24nKVxuXG4gIHRoaXMuYXJyID0gYXJyIHx8IFtdXG4gIHRoaXMuY21wID0gY21wXG59XG5cblNvcnRlZEFycmF5LnByb3RvdHlwZS5pbnNlcnQgPSBmdW5jdGlvbihlbGVtZW50KSB7XG4gIHZhciBpbmRleCA9IHNlYXJjaCh0aGlzLmFyciwgZWxlbWVudCwgdGhpcy5jbXApXG4gIGlmIChpbmRleCA8IDApXG4gICAgaW5kZXggPSB+aW5kZXhcblxuICB0aGlzLmFyci5zcGxpY2UoaW5kZXgsIDAsIGVsZW1lbnQpXG59XG5cblNvcnRlZEFycmF5LnByb3RvdHlwZS5pbmRleE9mID0gZnVuY3Rpb24oZWxlbWVudCkge1xuICB2YXIgaW5kZXggPSBzZWFyY2godGhpcy5hcnIsIGVsZW1lbnQsIHRoaXMuY21wKVxuICByZXR1cm4gaW5kZXggPj0gMFxuICAgID8gaW5kZXhcbiAgICA6IC0xXG59XG5cblNvcnRlZEFycmF5LnByb3RvdHlwZS5yZW1vdmUgPSBmdW5jdGlvbihlbGVtZW50KSB7XG4gIHZhciBpbmRleCA9IHNlYXJjaCh0aGlzLmFyciwgZWxlbWVudCwgdGhpcy5jbXApXG4gIGlmIChpbmRleCA8IDApXG4gICAgcmV0dXJuIGZhbHNlXG5cbiAgdGhpcy5hcnIuc3BsaWNlKGluZGV4LCAxKVxuICByZXR1cm4gdHJ1ZVxufVxuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihoYXlzdGFjaywgbmVlZGxlLCBjb21wYXJhdG9yLCBsb3csIGhpZ2gpIHtcbiAgdmFyIG1pZCwgY21wO1xuXG4gIGlmKGxvdyA9PT0gdW5kZWZpbmVkKVxuICAgIGxvdyA9IDA7XG5cbiAgZWxzZSB7XG4gICAgbG93ID0gbG93fDA7XG4gICAgaWYobG93IDwgMCB8fCBsb3cgPj0gaGF5c3RhY2subGVuZ3RoKVxuICAgICAgdGhyb3cgbmV3IFJhbmdlRXJyb3IoXCJpbnZhbGlkIGxvd2VyIGJvdW5kXCIpO1xuICB9XG5cbiAgaWYoaGlnaCA9PT0gdW5kZWZpbmVkKVxuICAgIGhpZ2ggPSBoYXlzdGFjay5sZW5ndGggLSAxO1xuXG4gIGVsc2Uge1xuICAgIGhpZ2ggPSBoaWdofDA7XG4gICAgaWYoaGlnaCA8IGxvdyB8fCBoaWdoID49IGhheXN0YWNrLmxlbmd0aClcbiAgICAgIHRocm93IG5ldyBSYW5nZUVycm9yKFwiaW52YWxpZCB1cHBlciBib3VuZFwiKTtcbiAgfVxuXG4gIHdoaWxlKGxvdyA8PSBoaWdoKSB7XG4gICAgLyogTm90ZSB0aGF0IFwiKGxvdyArIGhpZ2gpID4+PiAxXCIgbWF5IG92ZXJmbG93LCBhbmQgcmVzdWx0cyBpbiBhIHR5cGVjYXN0XG4gICAgICogdG8gZG91YmxlICh3aGljaCBnaXZlcyB0aGUgd3JvbmcgcmVzdWx0cykuICovXG4gICAgbWlkID0gbG93ICsgKGhpZ2ggLSBsb3cgPj4gMSk7XG4gICAgY21wID0gK2NvbXBhcmF0b3IoaGF5c3RhY2tbbWlkXSwgbmVlZGxlKTtcblxuICAgIC8qIFRvbyBsb3cuICovXG4gICAgaWYoY21wIDwgMC4wKSBcbiAgICAgIGxvdyAgPSBtaWQgKyAxO1xuXG4gICAgLyogVG9vIGhpZ2guICovXG4gICAgZWxzZSBpZihjbXAgPiAwLjApXG4gICAgICBoaWdoID0gbWlkIC0gMTtcbiAgICBcbiAgICAvKiBLZXkgZm91bmQuICovXG4gICAgZWxzZVxuICAgICAgcmV0dXJuIG1pZDtcbiAgfVxuXG4gIC8qIEtleSBub3QgZm91bmQuICovXG4gIHJldHVybiB+bG93O1xufVxuIiwidmFyIFNvcnRlZEFycmF5ID0gcmVxdWlyZSgnc29ydGVkLWNtcC1hcnJheScpO1xudmFyIENvbXBhcmF0b3IgPSByZXF1aXJlKCcuL3Z2d2VlbnRyeS5qcycpLkNvbXBhcmF0b3I7XG52YXIgVlZ3RUVudHJ5ID0gcmVxdWlyZSgnLi92dndlZW50cnkuanMnKTtcblxuLyoqXG4gKiBcXGNsYXNzIFZWd0VcbiAqIFxcYnJpZWYgY2xhc3MgdmVyc2lvbiB2ZWN0b3Igd2l0aCBleGNlcHRpb24ga2VlcHMgdHJhY2sgb2YgZXZlbnRzIGluIGEgXG4gKiBjb25jaXNlIHdheVxuICogXFxwYXJhbSBlIHRoZSBlbnRyeSBjaG9zZW4gYnkgdGhlIGxvY2FsIHNpdGUgKDEgZW50cnkgPC0+IDEgc2l0ZSlcbiAqL1xuZnVuY3Rpb24gVlZ3RShlKXtcbiAgICB0aGlzLmxvY2FsID0gbmV3IFZWd0VFbnRyeShlKTtcbiAgICB0aGlzLnZlY3RvciA9IG5ldyBTb3J0ZWRBcnJheShDb21wYXJhdG9yKTtcbiAgICB0aGlzLnZlY3Rvci5pbnNlcnQodGhpcy5sb2NhbCk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgY2xvbmUgb2YgdGhpcyB2dndlXG4gKi9cblZWd0UucHJvdG90eXBlLmNsb25lID0gZnVuY3Rpb24oKXtcbiAgICB2YXIgY2xvbmVWVndFID0gbmV3IFZWd0UodGhpcy5sb2NhbC5lKTtcbiAgICBmb3IgKHZhciBpPTA7IGk8dGhpcy52ZWN0b3IuYXJyLmxlbmd0aDsgKytpKXtcbiAgICAgICAgY2xvbmVWVndFLnZlY3Rvci5hcnJbaV0gPSBuZXcgVlZ3RUVudHJ5KHRoaXMudmVjdG9yLmFycltpXS5lKTtcbiAgICAgICAgY2xvbmVWVndFLnZlY3Rvci5hcnJbaV0udiA9IHRoaXMudmVjdG9yLmFycltpXS52O1xuICAgICAgICBmb3IgKHZhciBqPTA7IGo8dGhpcy52ZWN0b3IuYXJyW2ldLngubGVuZ3RoOyArK2ope1xuICAgICAgICAgICAgY2xvbmVWVndFLnZlY3Rvci5hcnJbaV0ueC5wdXNoKHRoaXMudmVjdG9yLmFycltpXS54W2pdKTtcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKGNsb25lVlZ3RS52ZWN0b3IuYXJyW2ldLmUgPT09IHRoaXMubG9jYWwuZSl7XG4gICAgICAgICAgICBjbG9uZVZWd0UubG9jYWwgPSBjbG9uZVZWd0UudmVjdG9yLmFycltpXTtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIHJldHVybiBjbG9uZVZWd0U7XG59O1xuXG5WVndFLnByb3RvdHlwZS5mcm9tSlNPTiA9IGZ1bmN0aW9uKG9iamVjdCl7XG4gICAgZm9yICh2YXIgaT0wOyBpPG9iamVjdC52ZWN0b3IuYXJyLmxlbmd0aDsgKytpKXtcbiAgICAgICAgdGhpcy52ZWN0b3IuYXJyW2ldID0gbmV3IFZWd0VFbnRyeShvYmplY3QudmVjdG9yLmFycltpXS5lKTtcbiAgICAgICAgdGhpcy52ZWN0b3IuYXJyW2ldLnYgPSBvYmplY3QudmVjdG9yLmFycltpXS52O1xuICAgICAgICBmb3IgKHZhciBqPTA7IGo8b2JqZWN0LnZlY3Rvci5hcnJbaV0ueC5sZW5ndGg7ICsrail7XG4gICAgICAgICAgICB0aGlzLnZlY3Rvci5hcnJbaV0ueC5wdXNoKG9iamVjdC52ZWN0b3IuYXJyW2ldLnhbal0pO1xuICAgICAgICB9O1xuICAgICAgICBpZiAob2JqZWN0LnZlY3Rvci5hcnJbaV0uZSA9PT0gb2JqZWN0LmxvY2FsLmUpe1xuICAgICAgICAgICAgdGhpcy5sb2NhbCA9IHRoaXMudmVjdG9yLmFycltpXTtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIHJldHVybiB0aGlzO1xufTtcblxuLyoqXG4gKiBcXGJyaWVmIGluY3JlbWVudCB0aGUgZW50cnkgb2YgdGhlIHZlY3RvciBvbiBsb2NhbCB1cGRhdGVcbiAqIFxccmV0dXJuIHtfZTogZW50cnksIF9jOiBjb3VudGVyfSB1bmlxdWVseSBpZGVudGlmeWluZyB0aGUgb3BlcmF0aW9uXG4gKi9cblZWd0UucHJvdG90eXBlLmluY3JlbWVudCA9IGZ1bmN0aW9uKCl7XG4gICAgdGhpcy5sb2NhbC5pbmNyZW1lbnQoKTtcbiAgICByZXR1cm4ge19lOiB0aGlzLmxvY2FsLmUsIF9jOnRoaXMubG9jYWwudn07IFxufTtcblxuXG4vKipcbiAqIFxcYnJpZWYgaW5jcmVtZW50IGZyb20gYSByZW1vdGUgb3BlcmF0aW9uXG4gKiBcXHBhcmFtIGVjIHRoZSBlbnRyeSBhbmQgY2xvY2sgb2YgdGhlIHJlY2VpdmVkIGV2ZW50IHRvIGFkZCBzdXBwb3NlZGx5IHJkeVxuICogdGhlIHR5cGUgaXMge19lOiBlbnRyeSwgX2M6IGNvdW50ZXJ9XG4gKi9cblZWd0UucHJvdG90eXBlLmluY3JlbWVudEZyb20gPSBmdW5jdGlvbiAoZWMpe1xuICAgIGlmICghZWMgfHwgKGVjICYmICFlYy5fZSkgfHwgKGVjICYmICFlYy5fYykpIHtyZXR1cm47fVxuICAgIC8vICMwIGZpbmQgdGhlIGVudHJ5IHdpdGhpbiB0aGUgYXJyYXkgb2YgVlZ3RW50cmllc1xuICAgIHZhciBpbmRleCA9IHRoaXMudmVjdG9yLmluZGV4T2YoZWMuX2UpO1xuICAgIGlmIChpbmRleCA8IDApe1xuICAgICAgICAvLyAjMSBpZiB0aGUgZW50cnkgZG9lcyBub3QgZXhpc3QsIGluaXRpYWxpemUgYW5kIGluY3JlbWVudFxuICAgICAgICB0aGlzLnZlY3Rvci5pbnNlcnQobmV3IFZWd0VFbnRyeShlYy5fZSkpO1xuICAgICAgICB0aGlzLnZlY3Rvci5hcnJbdGhpcy52ZWN0b3IuaW5kZXhPZihlYy5fZSldLmluY3JlbWVudEZyb20oZWMuX2MpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIC8vICMyIG90aGVyd2lzZSwgb25seSBpbmNyZW1lbnRcbiAgICAgICAgdGhpcy52ZWN0b3IuYXJyW2luZGV4XS5pbmNyZW1lbnRGcm9tKGVjLl9jKTtcbiAgICB9O1xufTtcblxuXG4vKipcbiAqIFxcYnJpZWYgY2hlY2sgaWYgdGhlIGFyZ3VtZW50IGFyZSBjYXVzYWxseSByZWFkeSByZWdhcmRzIHRvIHRoaXMgdmVjdG9yXG4gKiBcXHBhcmFtIGVjIHRoZSBzaXRlIGNsb2NrIHRoYXQgaGFwcGVuLWJlZm9yZSB0aGUgY3VycmVudCBldmVudFxuICovXG5WVndFLnByb3RvdHlwZS5pc1JlYWR5ID0gZnVuY3Rpb24oZWMpe1xuICAgIHZhciByZWFkeSA9ICFlYztcbiAgICBpZiAoIXJlYWR5KXtcbiAgICAgICAgdmFyIGluZGV4ID0gdGhpcy52ZWN0b3IuaW5kZXhPZihlYy5fZSk7XG4gICAgICAgIHJlYWR5ID0gaW5kZXggPj0wICYmIGVjLl9jIDw9IHRoaXMudmVjdG9yLmFycltpbmRleF0udiAmJlxuICAgICAgICAgICAgdGhpcy52ZWN0b3IuYXJyW2luZGV4XS54LmluZGV4T2YoZWMuX2MpPDA7XG4gICAgfTtcbiAgICByZXR1cm4gcmVhZHk7XG59O1xuXG4vKipcbiAqIFxcYnJpZWYgY2hlY2sgaWYgdGhlIG1lc3NhZ2UgY29udGFpbnMgaW5mb3JtYXRpb24gYWxyZWFkeSBkZWxpdmVyZWRcbiAqIFxccGFyYW0gZWMgdGhlIHNpdGUgY2xvY2sgdG8gY2hlY2tcbiAqL1xuVlZ3RS5wcm90b3R5cGUuaXNMb3dlciA9IGZ1bmN0aW9uKGVjKXtcbiAgICByZXR1cm4gKGVjICYmIHRoaXMuaXNSZWFkeShlYykpO1xufTtcblxuLyoqXG4gKiBcXGJyaWVmIG1lcmdlIHRoZSB2ZXJzaW9uIHZlY3RvciBpbiBhcmd1bWVudCB3aXRoIHRoaXNcbiAqIFxccGFyYW0gb3RoZXIgdGhlIG90aGVyIHZlcnNpb24gdmVjdG9yIHRvIG1lcmdlXG4gKi9cblZWd0UucHJvdG90eXBlLm1lcmdlID0gZnVuY3Rpb24ob3RoZXIpe1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgb3RoZXIudmVjdG9yLmFyci5sZW5ndGg7ICsraSl7XG4gICAgICAgIHZhciBlbnRyeSA9IG90aGVyLnZlY3Rvci5hcnJbaV07XG4gICAgICAgIHZhciBpbmRleCA9IHRoaXMudmVjdG9yLmluZGV4T2YoZW50cnkpO1xuICAgICAgICBpZiAoaW5kZXggPCAwKXtcbiAgICAgICAgICAgIC8vICMxIGVudHJ5IGRvZXMgbm90IGV4aXN0LCBmdWxseSBjb3B5IGl0XG4gICAgICAgICAgICB2YXIgbmV3RW50cnkgPSBuZXcgVlZ3RUVudHJ5KGVudHJ5LmUpO1xuICAgICAgICAgICAgbmV3RW50cnkudiA9IGVudHJ5LnY7XG4gICAgICAgICAgICBmb3IgKHZhciBqID0gMDsgaiA8IGVudHJ5LngubGVuZ3RoOyArK2ope1xuICAgICAgICAgICAgICAgIG5ld0VudHJ5LngucHVzaChlbnRyeS54W2pdKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICB0aGlzLnZlY3Rvci5pbnNlcnQobmV3RW50cnkpO1xuICAgICAgICB9ZWxzZXtcbiAgICAgICAgICAgIC8vICMyIG90aGVyd2lzZSBtZXJnZSB0aGUgZW50cmllc1xuICAgICAgICAgICAgdmFyIGN1cnJFbnRyeSA9IHRoaXMudmVjdG9yLmFycltpXTtcbiAgICAgICAgICAgIC8vICMyQSByZW1vdmUgdGhlIGV4Y2VwdGlvbiBmcm9tIG91ciB2ZWN0b3JcbiAgICAgICAgICAgIHZhciBqID0gMDtcbiAgICAgICAgICAgIHdoaWxlIChqPGN1cnJFbnRyeS54Lmxlbmd0aCl7XG4gICAgICAgICAgICAgICAgaWYgKGN1cnJFbnRyeS54W2pdPGVudHJ5LnYgJiZcbiAgICAgICAgICAgICAgICAgICAgZW50cnkueC5pbmRleE9mKGN1cnJFbnRyeS54W2pdKTwwKXtcbiAgICAgICAgICAgICAgICAgICAgY3VyckVudHJ5Lnguc3BsaWNlKGosIDEpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICsrajtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIC8vICMyQiBhZGQgdGhlIG5ldyBleGNlcHRpb25zXG4gICAgICAgICAgICBqID0gMDtcbiAgICAgICAgICAgIHdoaWxlIChqPGVudHJ5LngubGVuZ3RoKXtcbiAgICAgICAgICAgICAgICBpZiAoZW50cnkueFtqXSA+IGN1cnJFbnRyeS52ICYmXG4gICAgICAgICAgICAgICAgICAgIGN1cnJFbnRyeS54LmluZGV4T2YoZW50cnkueFtqXSk8MCl7XG4gICAgICAgICAgICAgICAgICAgIGN1cnJFbnRyeS54LnB1c2goZW50cnkueFtqXSk7XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICArK2o7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgY3VyckVudHJ5LnYgPSBNYXRoLm1heChjdXJyRW50cnkudiwgZW50cnkudik7XG4gICAgICAgIH07XG4gICAgfTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gVlZ3RTtcblxuIiwiXG4vKiFcbiAgXFxicmllZiBjcmVhdGUgYW4gZW50cnkgb2YgdGhlIHZlcnNpb24gdmVjdG9yIHdpdGggZXhjZXB0aW9ucyBjb250YWluaW5nIHRoZVxuICBpbmRleCBvZiB0aGUgZW50cnksIHRoZSB2YWx1ZSB2IHRoYXQgY3JlYXRlcyBhIGNvbnRpZ3VvdXMgaW50ZXJ2YWxcbiAgZnJvbSAwIHRvIHYsIGFuIGFycmF5IG9mIGludGVnZXJzIHRoYXQgY29udGFpbiB0aGUgb3BlcmF0aW9ucyBsb3dlciB0byB2IHRoYXRcbiAgaGF2ZSBub3QgYmVlbiByZWNlaXZlZCB5ZXRcbiAgXFxwYXJhbSBlIHRoZSBlbnRyeSBpbiB0aGUgaW50ZXJ2YWwgdmVyc2lvbiB2ZWN0b3JcbiovXG5mdW5jdGlvbiBWVndFRW50cnkoZSl7XG4gICAgdGhpcy5lID0gZTsgICBcbiAgICB0aGlzLnYgPSAwO1xuICAgIHRoaXMueCA9IFtdO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGxvY2FsIGNvdW50ZXIgaW5jcmVtZW50ZWRcbiAqL1xuVlZ3RUVudHJ5LnByb3RvdHlwZS5pbmNyZW1lbnQgPSBmdW5jdGlvbigpe1xuICAgIHRoaXMudiArPSAxO1xufTtcblxuLyoqXG4gKiBcXGJyaWVmIGluY3JlbWVudCBmcm9tIGEgcmVtb3RlIG9wZXJhdGlvblxuICogXFxwYXJhbSBjIHRoZSBjb3VudGVyIG9mIHRoZSBvcGVyYXRpb24gdG8gYWRkIHRvIHRoaXMgXG4gKi9cblZWd0VFbnRyeS5wcm90b3R5cGUuaW5jcmVtZW50RnJvbSA9IGZ1bmN0aW9uKGMpe1xuICAgIC8vICMxIGNoZWNrIGlmIHRoZSBjb3VudGVyIGlzIGluY2x1ZGVkIGluIHRoZSBleGNlcHRpb25zXG4gICAgaWYgKGMgPCB0aGlzLnYpe1xuICAgICAgICB2YXIgaW5kZXggPSB0aGlzLnguaW5kZXhPZihjKTtcbiAgICAgICAgaWYgKGluZGV4Pj0wKXsgLy8gdGhlIGV4Y2VwdGlvbiBpcyBmb3VuZFxuICAgICAgICAgICAgdGhpcy54LnNwbGljZShpbmRleCwgMSk7XG4gICAgICAgIH07XG4gICAgfTtcbiAgICAvLyAjMiBpZiB0aGUgdmFsdWUgaXMgKzEgY29tcGFyZWQgdG8gdGhlIGN1cnJlbnQgdmFsdWUgb2YgdGhlIHZlY3RvclxuICAgIGlmIChjID09ICh0aGlzLnYgKyAxKSl7XG4gICAgICAgIHRoaXMudiArPSAxO1xuICAgIH07XG4gICAgLy8gIzMgb3RoZXJ3aXNlIGV4Y2VwdGlvbiBhcmUgbWFkZVxuICAgIGlmIChjID4gKHRoaXMudiArIDEpKXtcbiAgICAgICAgZm9yICh2YXIgaSA9ICh0aGlzLnYgKyAxKTsgaTxjOyArK2kpe1xuICAgICAgICAgICAgdGhpcy54LnB1c2goaSk7XG4gICAgICAgIH07XG4gICAgICAgIHRoaXMudiA9IGM7XG4gICAgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiBjb21wYXJpc29uIGZ1bmN0aW9uIGJldHdlZW4gdHdvIFZWd0UgZW50cmllc1xuICogXFxwYXJhbSBhIHRoZSBmaXJzdCBlbGVtZW50XG4gKiBcXHBhcmFtIGIgdGhlIHNlY29uZCBlbGVtZW50XG4gKiBcXHJldHVybiAtMSBpZiBhIDwgYiwgMSBpZiBhID4gYiwgMCBvdGhlcndpc2VcbiAqL1xuZnVuY3Rpb24gQ29tcGFyYXRvciAoYSwgYil7XG4gICAgdmFyIGFFbnRyeSA9IChhLmUpIHx8IGE7XG4gICAgdmFyIGJFbnRyeSA9IChiLmUpIHx8IGI7XG4gICAgaWYgKGFFbnRyeSA8IGJFbnRyeSl7IHJldHVybiAtMTsgfTtcbiAgICBpZiAoYUVudHJ5ID4gYkVudHJ5KXsgcmV0dXJuICAxOyB9O1xuICAgIHJldHVybiAwO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBWVndFRW50cnk7XG5tb2R1bGUuZXhwb3J0cy5Db21wYXJhdG9yID0gQ29tcGFyYXRvcjtcbiIsIi8qIVxuICogVGhlIGJ1ZmZlciBtb2R1bGUgZnJvbSBub2RlLmpzLCBmb3IgdGhlIGJyb3dzZXIuXG4gKlxuICogQGF1dGhvciAgIEZlcm9zcyBBYm91a2hhZGlqZWggPGZlcm9zc0BmZXJvc3Mub3JnPiA8aHR0cDovL2Zlcm9zcy5vcmc+XG4gKiBAbGljZW5zZSAgTUlUXG4gKi9cblxudmFyIGJhc2U2NCA9IHJlcXVpcmUoJ2Jhc2U2NC1qcycpXG52YXIgaWVlZTc1NCA9IHJlcXVpcmUoJ2llZWU3NTQnKVxudmFyIGlzQXJyYXkgPSByZXF1aXJlKCdpcy1hcnJheScpXG5cbmV4cG9ydHMuQnVmZmVyID0gQnVmZmVyXG5leHBvcnRzLlNsb3dCdWZmZXIgPSBCdWZmZXJcbmV4cG9ydHMuSU5TUEVDVF9NQVhfQllURVMgPSA1MFxuQnVmZmVyLnBvb2xTaXplID0gODE5MiAvLyBub3QgdXNlZCBieSB0aGlzIGltcGxlbWVudGF0aW9uXG5cbnZhciBrTWF4TGVuZ3RoID0gMHgzZmZmZmZmZlxuXG4vKipcbiAqIElmIGBCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVGA6XG4gKiAgID09PSB0cnVlICAgIFVzZSBVaW50OEFycmF5IGltcGxlbWVudGF0aW9uIChmYXN0ZXN0KVxuICogICA9PT0gZmFsc2UgICBVc2UgT2JqZWN0IGltcGxlbWVudGF0aW9uIChtb3N0IGNvbXBhdGlibGUsIGV2ZW4gSUU2KVxuICpcbiAqIEJyb3dzZXJzIHRoYXQgc3VwcG9ydCB0eXBlZCBhcnJheXMgYXJlIElFIDEwKywgRmlyZWZveCA0KywgQ2hyb21lIDcrLCBTYWZhcmkgNS4xKyxcbiAqIE9wZXJhIDExLjYrLCBpT1MgNC4yKy5cbiAqXG4gKiBOb3RlOlxuICpcbiAqIC0gSW1wbGVtZW50YXRpb24gbXVzdCBzdXBwb3J0IGFkZGluZyBuZXcgcHJvcGVydGllcyB0byBgVWludDhBcnJheWAgaW5zdGFuY2VzLlxuICogICBGaXJlZm94IDQtMjkgbGFja2VkIHN1cHBvcnQsIGZpeGVkIGluIEZpcmVmb3ggMzArLlxuICogICBTZWU6IGh0dHBzOi8vYnVnemlsbGEubW96aWxsYS5vcmcvc2hvd19idWcuY2dpP2lkPTY5NTQzOC5cbiAqXG4gKiAgLSBDaHJvbWUgOS0xMCBpcyBtaXNzaW5nIHRoZSBgVHlwZWRBcnJheS5wcm90b3R5cGUuc3ViYXJyYXlgIGZ1bmN0aW9uLlxuICpcbiAqICAtIElFMTAgaGFzIGEgYnJva2VuIGBUeXBlZEFycmF5LnByb3RvdHlwZS5zdWJhcnJheWAgZnVuY3Rpb24gd2hpY2ggcmV0dXJucyBhcnJheXMgb2ZcbiAqICAgIGluY29ycmVjdCBsZW5ndGggaW4gc29tZSBzaXR1YXRpb25zLlxuICpcbiAqIFdlIGRldGVjdCB0aGVzZSBidWdneSBicm93c2VycyBhbmQgc2V0IGBCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVGAgdG8gYGZhbHNlYCBzbyB0aGV5IHdpbGxcbiAqIGdldCB0aGUgT2JqZWN0IGltcGxlbWVudGF0aW9uLCB3aGljaCBpcyBzbG93ZXIgYnV0IHdpbGwgd29yayBjb3JyZWN0bHkuXG4gKi9cbkJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUID0gKGZ1bmN0aW9uICgpIHtcbiAgdHJ5IHtcbiAgICB2YXIgYnVmID0gbmV3IEFycmF5QnVmZmVyKDApXG4gICAgdmFyIGFyciA9IG5ldyBVaW50OEFycmF5KGJ1ZilcbiAgICBhcnIuZm9vID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gNDIgfVxuICAgIHJldHVybiA0MiA9PT0gYXJyLmZvbygpICYmIC8vIHR5cGVkIGFycmF5IGluc3RhbmNlcyBjYW4gYmUgYXVnbWVudGVkXG4gICAgICAgIHR5cGVvZiBhcnIuc3ViYXJyYXkgPT09ICdmdW5jdGlvbicgJiYgLy8gY2hyb21lIDktMTAgbGFjayBgc3ViYXJyYXlgXG4gICAgICAgIG5ldyBVaW50OEFycmF5KDEpLnN1YmFycmF5KDEsIDEpLmJ5dGVMZW5ndGggPT09IDAgLy8gaWUxMCBoYXMgYnJva2VuIGBzdWJhcnJheWBcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiBmYWxzZVxuICB9XG59KSgpXG5cbi8qKlxuICogQ2xhc3M6IEJ1ZmZlclxuICogPT09PT09PT09PT09PVxuICpcbiAqIFRoZSBCdWZmZXIgY29uc3RydWN0b3IgcmV0dXJucyBpbnN0YW5jZXMgb2YgYFVpbnQ4QXJyYXlgIHRoYXQgYXJlIGF1Z21lbnRlZFxuICogd2l0aCBmdW5jdGlvbiBwcm9wZXJ0aWVzIGZvciBhbGwgdGhlIG5vZGUgYEJ1ZmZlcmAgQVBJIGZ1bmN0aW9ucy4gV2UgdXNlXG4gKiBgVWludDhBcnJheWAgc28gdGhhdCBzcXVhcmUgYnJhY2tldCBub3RhdGlvbiB3b3JrcyBhcyBleHBlY3RlZCAtLSBpdCByZXR1cm5zXG4gKiBhIHNpbmdsZSBvY3RldC5cbiAqXG4gKiBCeSBhdWdtZW50aW5nIHRoZSBpbnN0YW5jZXMsIHdlIGNhbiBhdm9pZCBtb2RpZnlpbmcgdGhlIGBVaW50OEFycmF5YFxuICogcHJvdG90eXBlLlxuICovXG5mdW5jdGlvbiBCdWZmZXIgKHN1YmplY3QsIGVuY29kaW5nLCBub1plcm8pIHtcbiAgaWYgKCEodGhpcyBpbnN0YW5jZW9mIEJ1ZmZlcikpXG4gICAgcmV0dXJuIG5ldyBCdWZmZXIoc3ViamVjdCwgZW5jb2RpbmcsIG5vWmVybylcblxuICB2YXIgdHlwZSA9IHR5cGVvZiBzdWJqZWN0XG5cbiAgLy8gRmluZCB0aGUgbGVuZ3RoXG4gIHZhciBsZW5ndGhcbiAgaWYgKHR5cGUgPT09ICdudW1iZXInKVxuICAgIGxlbmd0aCA9IHN1YmplY3QgPiAwID8gc3ViamVjdCA+Pj4gMCA6IDBcbiAgZWxzZSBpZiAodHlwZSA9PT0gJ3N0cmluZycpIHtcbiAgICBpZiAoZW5jb2RpbmcgPT09ICdiYXNlNjQnKVxuICAgICAgc3ViamVjdCA9IGJhc2U2NGNsZWFuKHN1YmplY3QpXG4gICAgbGVuZ3RoID0gQnVmZmVyLmJ5dGVMZW5ndGgoc3ViamVjdCwgZW5jb2RpbmcpXG4gIH0gZWxzZSBpZiAodHlwZSA9PT0gJ29iamVjdCcgJiYgc3ViamVjdCAhPT0gbnVsbCkgeyAvLyBhc3N1bWUgb2JqZWN0IGlzIGFycmF5LWxpa2VcbiAgICBpZiAoc3ViamVjdC50eXBlID09PSAnQnVmZmVyJyAmJiBpc0FycmF5KHN1YmplY3QuZGF0YSkpXG4gICAgICBzdWJqZWN0ID0gc3ViamVjdC5kYXRhXG4gICAgbGVuZ3RoID0gK3N1YmplY3QubGVuZ3RoID4gMCA/IE1hdGguZmxvb3IoK3N1YmplY3QubGVuZ3RoKSA6IDBcbiAgfSBlbHNlXG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignbXVzdCBzdGFydCB3aXRoIG51bWJlciwgYnVmZmVyLCBhcnJheSBvciBzdHJpbmcnKVxuXG4gIGlmICh0aGlzLmxlbmd0aCA+IGtNYXhMZW5ndGgpXG4gICAgdGhyb3cgbmV3IFJhbmdlRXJyb3IoJ0F0dGVtcHQgdG8gYWxsb2NhdGUgQnVmZmVyIGxhcmdlciB0aGFuIG1heGltdW0gJyArXG4gICAgICAnc2l6ZTogMHgnICsga01heExlbmd0aC50b1N0cmluZygxNikgKyAnIGJ5dGVzJylcblxuICB2YXIgYnVmXG4gIGlmIChCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkge1xuICAgIC8vIFByZWZlcnJlZDogUmV0dXJuIGFuIGF1Z21lbnRlZCBgVWludDhBcnJheWAgaW5zdGFuY2UgZm9yIGJlc3QgcGVyZm9ybWFuY2VcbiAgICBidWYgPSBCdWZmZXIuX2F1Z21lbnQobmV3IFVpbnQ4QXJyYXkobGVuZ3RoKSlcbiAgfSBlbHNlIHtcbiAgICAvLyBGYWxsYmFjazogUmV0dXJuIFRISVMgaW5zdGFuY2Ugb2YgQnVmZmVyIChjcmVhdGVkIGJ5IGBuZXdgKVxuICAgIGJ1ZiA9IHRoaXNcbiAgICBidWYubGVuZ3RoID0gbGVuZ3RoXG4gICAgYnVmLl9pc0J1ZmZlciA9IHRydWVcbiAgfVxuXG4gIHZhciBpXG4gIGlmIChCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCAmJiB0eXBlb2Ygc3ViamVjdC5ieXRlTGVuZ3RoID09PSAnbnVtYmVyJykge1xuICAgIC8vIFNwZWVkIG9wdGltaXphdGlvbiAtLSB1c2Ugc2V0IGlmIHdlJ3JlIGNvcHlpbmcgZnJvbSBhIHR5cGVkIGFycmF5XG4gICAgYnVmLl9zZXQoc3ViamVjdClcbiAgfSBlbHNlIGlmIChpc0FycmF5aXNoKHN1YmplY3QpKSB7XG4gICAgLy8gVHJlYXQgYXJyYXktaXNoIG9iamVjdHMgYXMgYSBieXRlIGFycmF5XG4gICAgaWYgKEJ1ZmZlci5pc0J1ZmZlcihzdWJqZWN0KSkge1xuICAgICAgZm9yIChpID0gMDsgaSA8IGxlbmd0aDsgaSsrKVxuICAgICAgICBidWZbaV0gPSBzdWJqZWN0LnJlYWRVSW50OChpKVxuICAgIH0gZWxzZSB7XG4gICAgICBmb3IgKGkgPSAwOyBpIDwgbGVuZ3RoOyBpKyspXG4gICAgICAgIGJ1ZltpXSA9ICgoc3ViamVjdFtpXSAlIDI1NikgKyAyNTYpICUgMjU2XG4gICAgfVxuICB9IGVsc2UgaWYgKHR5cGUgPT09ICdzdHJpbmcnKSB7XG4gICAgYnVmLndyaXRlKHN1YmplY3QsIDAsIGVuY29kaW5nKVxuICB9IGVsc2UgaWYgKHR5cGUgPT09ICdudW1iZXInICYmICFCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCAmJiAhbm9aZXJvKSB7XG4gICAgZm9yIChpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgICBidWZbaV0gPSAwXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGJ1ZlxufVxuXG5CdWZmZXIuaXNCdWZmZXIgPSBmdW5jdGlvbiAoYikge1xuICByZXR1cm4gISEoYiAhPSBudWxsICYmIGIuX2lzQnVmZmVyKVxufVxuXG5CdWZmZXIuY29tcGFyZSA9IGZ1bmN0aW9uIChhLCBiKSB7XG4gIGlmICghQnVmZmVyLmlzQnVmZmVyKGEpIHx8ICFCdWZmZXIuaXNCdWZmZXIoYikpXG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignQXJndW1lbnRzIG11c3QgYmUgQnVmZmVycycpXG5cbiAgdmFyIHggPSBhLmxlbmd0aFxuICB2YXIgeSA9IGIubGVuZ3RoXG4gIGZvciAodmFyIGkgPSAwLCBsZW4gPSBNYXRoLm1pbih4LCB5KTsgaSA8IGxlbiAmJiBhW2ldID09PSBiW2ldOyBpKyspIHt9XG4gIGlmIChpICE9PSBsZW4pIHtcbiAgICB4ID0gYVtpXVxuICAgIHkgPSBiW2ldXG4gIH1cbiAgaWYgKHggPCB5KSByZXR1cm4gLTFcbiAgaWYgKHkgPCB4KSByZXR1cm4gMVxuICByZXR1cm4gMFxufVxuXG5CdWZmZXIuaXNFbmNvZGluZyA9IGZ1bmN0aW9uIChlbmNvZGluZykge1xuICBzd2l0Y2ggKFN0cmluZyhlbmNvZGluZykudG9Mb3dlckNhc2UoKSkge1xuICAgIGNhc2UgJ2hleCc6XG4gICAgY2FzZSAndXRmOCc6XG4gICAgY2FzZSAndXRmLTgnOlxuICAgIGNhc2UgJ2FzY2lpJzpcbiAgICBjYXNlICdiaW5hcnknOlxuICAgIGNhc2UgJ2Jhc2U2NCc6XG4gICAgY2FzZSAncmF3JzpcbiAgICBjYXNlICd1Y3MyJzpcbiAgICBjYXNlICd1Y3MtMic6XG4gICAgY2FzZSAndXRmMTZsZSc6XG4gICAgY2FzZSAndXRmLTE2bGUnOlxuICAgICAgcmV0dXJuIHRydWVcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIGZhbHNlXG4gIH1cbn1cblxuQnVmZmVyLmNvbmNhdCA9IGZ1bmN0aW9uIChsaXN0LCB0b3RhbExlbmd0aCkge1xuICBpZiAoIWlzQXJyYXkobGlzdCkpIHRocm93IG5ldyBUeXBlRXJyb3IoJ1VzYWdlOiBCdWZmZXIuY29uY2F0KGxpc3RbLCBsZW5ndGhdKScpXG5cbiAgaWYgKGxpc3QubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIG5ldyBCdWZmZXIoMClcbiAgfSBlbHNlIGlmIChsaXN0Lmxlbmd0aCA9PT0gMSkge1xuICAgIHJldHVybiBsaXN0WzBdXG4gIH1cblxuICB2YXIgaVxuICBpZiAodG90YWxMZW5ndGggPT09IHVuZGVmaW5lZCkge1xuICAgIHRvdGFsTGVuZ3RoID0gMFxuICAgIGZvciAoaSA9IDA7IGkgPCBsaXN0Lmxlbmd0aDsgaSsrKSB7XG4gICAgICB0b3RhbExlbmd0aCArPSBsaXN0W2ldLmxlbmd0aFxuICAgIH1cbiAgfVxuXG4gIHZhciBidWYgPSBuZXcgQnVmZmVyKHRvdGFsTGVuZ3RoKVxuICB2YXIgcG9zID0gMFxuICBmb3IgKGkgPSAwOyBpIDwgbGlzdC5sZW5ndGg7IGkrKykge1xuICAgIHZhciBpdGVtID0gbGlzdFtpXVxuICAgIGl0ZW0uY29weShidWYsIHBvcylcbiAgICBwb3MgKz0gaXRlbS5sZW5ndGhcbiAgfVxuICByZXR1cm4gYnVmXG59XG5cbkJ1ZmZlci5ieXRlTGVuZ3RoID0gZnVuY3Rpb24gKHN0ciwgZW5jb2RpbmcpIHtcbiAgdmFyIHJldFxuICBzdHIgPSBzdHIgKyAnJ1xuICBzd2l0Y2ggKGVuY29kaW5nIHx8ICd1dGY4Jykge1xuICAgIGNhc2UgJ2FzY2lpJzpcbiAgICBjYXNlICdiaW5hcnknOlxuICAgIGNhc2UgJ3Jhdyc6XG4gICAgICByZXQgPSBzdHIubGVuZ3RoXG4gICAgICBicmVha1xuICAgIGNhc2UgJ3VjczInOlxuICAgIGNhc2UgJ3Vjcy0yJzpcbiAgICBjYXNlICd1dGYxNmxlJzpcbiAgICBjYXNlICd1dGYtMTZsZSc6XG4gICAgICByZXQgPSBzdHIubGVuZ3RoICogMlxuICAgICAgYnJlYWtcbiAgICBjYXNlICdoZXgnOlxuICAgICAgcmV0ID0gc3RyLmxlbmd0aCA+Pj4gMVxuICAgICAgYnJlYWtcbiAgICBjYXNlICd1dGY4JzpcbiAgICBjYXNlICd1dGYtOCc6XG4gICAgICByZXQgPSB1dGY4VG9CeXRlcyhzdHIpLmxlbmd0aFxuICAgICAgYnJlYWtcbiAgICBjYXNlICdiYXNlNjQnOlxuICAgICAgcmV0ID0gYmFzZTY0VG9CeXRlcyhzdHIpLmxlbmd0aFxuICAgICAgYnJlYWtcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0ID0gc3RyLmxlbmd0aFxuICB9XG4gIHJldHVybiByZXRcbn1cblxuLy8gcHJlLXNldCBmb3IgdmFsdWVzIHRoYXQgbWF5IGV4aXN0IGluIHRoZSBmdXR1cmVcbkJ1ZmZlci5wcm90b3R5cGUubGVuZ3RoID0gdW5kZWZpbmVkXG5CdWZmZXIucHJvdG90eXBlLnBhcmVudCA9IHVuZGVmaW5lZFxuXG4vLyB0b1N0cmluZyhlbmNvZGluZywgc3RhcnQ9MCwgZW5kPWJ1ZmZlci5sZW5ndGgpXG5CdWZmZXIucHJvdG90eXBlLnRvU3RyaW5nID0gZnVuY3Rpb24gKGVuY29kaW5nLCBzdGFydCwgZW5kKSB7XG4gIHZhciBsb3dlcmVkQ2FzZSA9IGZhbHNlXG5cbiAgc3RhcnQgPSBzdGFydCA+Pj4gMFxuICBlbmQgPSBlbmQgPT09IHVuZGVmaW5lZCB8fCBlbmQgPT09IEluZmluaXR5ID8gdGhpcy5sZW5ndGggOiBlbmQgPj4+IDBcblxuICBpZiAoIWVuY29kaW5nKSBlbmNvZGluZyA9ICd1dGY4J1xuICBpZiAoc3RhcnQgPCAwKSBzdGFydCA9IDBcbiAgaWYgKGVuZCA+IHRoaXMubGVuZ3RoKSBlbmQgPSB0aGlzLmxlbmd0aFxuICBpZiAoZW5kIDw9IHN0YXJ0KSByZXR1cm4gJydcblxuICB3aGlsZSAodHJ1ZSkge1xuICAgIHN3aXRjaCAoZW5jb2RpbmcpIHtcbiAgICAgIGNhc2UgJ2hleCc6XG4gICAgICAgIHJldHVybiBoZXhTbGljZSh0aGlzLCBzdGFydCwgZW5kKVxuXG4gICAgICBjYXNlICd1dGY4JzpcbiAgICAgIGNhc2UgJ3V0Zi04JzpcbiAgICAgICAgcmV0dXJuIHV0ZjhTbGljZSh0aGlzLCBzdGFydCwgZW5kKVxuXG4gICAgICBjYXNlICdhc2NpaSc6XG4gICAgICAgIHJldHVybiBhc2NpaVNsaWNlKHRoaXMsIHN0YXJ0LCBlbmQpXG5cbiAgICAgIGNhc2UgJ2JpbmFyeSc6XG4gICAgICAgIHJldHVybiBiaW5hcnlTbGljZSh0aGlzLCBzdGFydCwgZW5kKVxuXG4gICAgICBjYXNlICdiYXNlNjQnOlxuICAgICAgICByZXR1cm4gYmFzZTY0U2xpY2UodGhpcywgc3RhcnQsIGVuZClcblxuICAgICAgY2FzZSAndWNzMic6XG4gICAgICBjYXNlICd1Y3MtMic6XG4gICAgICBjYXNlICd1dGYxNmxlJzpcbiAgICAgIGNhc2UgJ3V0Zi0xNmxlJzpcbiAgICAgICAgcmV0dXJuIHV0ZjE2bGVTbGljZSh0aGlzLCBzdGFydCwgZW5kKVxuXG4gICAgICBkZWZhdWx0OlxuICAgICAgICBpZiAobG93ZXJlZENhc2UpXG4gICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignVW5rbm93biBlbmNvZGluZzogJyArIGVuY29kaW5nKVxuICAgICAgICBlbmNvZGluZyA9IChlbmNvZGluZyArICcnKS50b0xvd2VyQ2FzZSgpXG4gICAgICAgIGxvd2VyZWRDYXNlID0gdHJ1ZVxuICAgIH1cbiAgfVxufVxuXG5CdWZmZXIucHJvdG90eXBlLmVxdWFscyA9IGZ1bmN0aW9uIChiKSB7XG4gIGlmKCFCdWZmZXIuaXNCdWZmZXIoYikpIHRocm93IG5ldyBUeXBlRXJyb3IoJ0FyZ3VtZW50IG11c3QgYmUgYSBCdWZmZXInKVxuICByZXR1cm4gQnVmZmVyLmNvbXBhcmUodGhpcywgYikgPT09IDBcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5pbnNwZWN0ID0gZnVuY3Rpb24gKCkge1xuICB2YXIgc3RyID0gJydcbiAgdmFyIG1heCA9IGV4cG9ydHMuSU5TUEVDVF9NQVhfQllURVNcbiAgaWYgKHRoaXMubGVuZ3RoID4gMCkge1xuICAgIHN0ciA9IHRoaXMudG9TdHJpbmcoJ2hleCcsIDAsIG1heCkubWF0Y2goLy57Mn0vZykuam9pbignICcpXG4gICAgaWYgKHRoaXMubGVuZ3RoID4gbWF4KVxuICAgICAgc3RyICs9ICcgLi4uICdcbiAgfVxuICByZXR1cm4gJzxCdWZmZXIgJyArIHN0ciArICc+J1xufVxuXG5CdWZmZXIucHJvdG90eXBlLmNvbXBhcmUgPSBmdW5jdGlvbiAoYikge1xuICBpZiAoIUJ1ZmZlci5pc0J1ZmZlcihiKSkgdGhyb3cgbmV3IFR5cGVFcnJvcignQXJndW1lbnQgbXVzdCBiZSBhIEJ1ZmZlcicpXG4gIHJldHVybiBCdWZmZXIuY29tcGFyZSh0aGlzLCBiKVxufVxuXG4vLyBgZ2V0YCB3aWxsIGJlIHJlbW92ZWQgaW4gTm9kZSAwLjEzK1xuQnVmZmVyLnByb3RvdHlwZS5nZXQgPSBmdW5jdGlvbiAob2Zmc2V0KSB7XG4gIGNvbnNvbGUubG9nKCcuZ2V0KCkgaXMgZGVwcmVjYXRlZC4gQWNjZXNzIHVzaW5nIGFycmF5IGluZGV4ZXMgaW5zdGVhZC4nKVxuICByZXR1cm4gdGhpcy5yZWFkVUludDgob2Zmc2V0KVxufVxuXG4vLyBgc2V0YCB3aWxsIGJlIHJlbW92ZWQgaW4gTm9kZSAwLjEzK1xuQnVmZmVyLnByb3RvdHlwZS5zZXQgPSBmdW5jdGlvbiAodiwgb2Zmc2V0KSB7XG4gIGNvbnNvbGUubG9nKCcuc2V0KCkgaXMgZGVwcmVjYXRlZC4gQWNjZXNzIHVzaW5nIGFycmF5IGluZGV4ZXMgaW5zdGVhZC4nKVxuICByZXR1cm4gdGhpcy53cml0ZVVJbnQ4KHYsIG9mZnNldClcbn1cblxuZnVuY3Rpb24gaGV4V3JpdGUgKGJ1Ziwgc3RyaW5nLCBvZmZzZXQsIGxlbmd0aCkge1xuICBvZmZzZXQgPSBOdW1iZXIob2Zmc2V0KSB8fCAwXG4gIHZhciByZW1haW5pbmcgPSBidWYubGVuZ3RoIC0gb2Zmc2V0XG4gIGlmICghbGVuZ3RoKSB7XG4gICAgbGVuZ3RoID0gcmVtYWluaW5nXG4gIH0gZWxzZSB7XG4gICAgbGVuZ3RoID0gTnVtYmVyKGxlbmd0aClcbiAgICBpZiAobGVuZ3RoID4gcmVtYWluaW5nKSB7XG4gICAgICBsZW5ndGggPSByZW1haW5pbmdcbiAgICB9XG4gIH1cblxuICAvLyBtdXN0IGJlIGFuIGV2ZW4gbnVtYmVyIG9mIGRpZ2l0c1xuICB2YXIgc3RyTGVuID0gc3RyaW5nLmxlbmd0aFxuICBpZiAoc3RyTGVuICUgMiAhPT0gMCkgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIGhleCBzdHJpbmcnKVxuXG4gIGlmIChsZW5ndGggPiBzdHJMZW4gLyAyKSB7XG4gICAgbGVuZ3RoID0gc3RyTGVuIC8gMlxuICB9XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuZ3RoOyBpKyspIHtcbiAgICB2YXIgYnl0ZSA9IHBhcnNlSW50KHN0cmluZy5zdWJzdHIoaSAqIDIsIDIpLCAxNilcbiAgICBpZiAoaXNOYU4oYnl0ZSkpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBoZXggc3RyaW5nJylcbiAgICBidWZbb2Zmc2V0ICsgaV0gPSBieXRlXG4gIH1cbiAgcmV0dXJuIGlcbn1cblxuZnVuY3Rpb24gdXRmOFdyaXRlIChidWYsIHN0cmluZywgb2Zmc2V0LCBsZW5ndGgpIHtcbiAgdmFyIGNoYXJzV3JpdHRlbiA9IGJsaXRCdWZmZXIodXRmOFRvQnl0ZXMoc3RyaW5nKSwgYnVmLCBvZmZzZXQsIGxlbmd0aClcbiAgcmV0dXJuIGNoYXJzV3JpdHRlblxufVxuXG5mdW5jdGlvbiBhc2NpaVdyaXRlIChidWYsIHN0cmluZywgb2Zmc2V0LCBsZW5ndGgpIHtcbiAgdmFyIGNoYXJzV3JpdHRlbiA9IGJsaXRCdWZmZXIoYXNjaWlUb0J5dGVzKHN0cmluZyksIGJ1Ziwgb2Zmc2V0LCBsZW5ndGgpXG4gIHJldHVybiBjaGFyc1dyaXR0ZW5cbn1cblxuZnVuY3Rpb24gYmluYXJ5V3JpdGUgKGJ1Ziwgc3RyaW5nLCBvZmZzZXQsIGxlbmd0aCkge1xuICByZXR1cm4gYXNjaWlXcml0ZShidWYsIHN0cmluZywgb2Zmc2V0LCBsZW5ndGgpXG59XG5cbmZ1bmN0aW9uIGJhc2U2NFdyaXRlIChidWYsIHN0cmluZywgb2Zmc2V0LCBsZW5ndGgpIHtcbiAgdmFyIGNoYXJzV3JpdHRlbiA9IGJsaXRCdWZmZXIoYmFzZTY0VG9CeXRlcyhzdHJpbmcpLCBidWYsIG9mZnNldCwgbGVuZ3RoKVxuICByZXR1cm4gY2hhcnNXcml0dGVuXG59XG5cbmZ1bmN0aW9uIHV0ZjE2bGVXcml0ZSAoYnVmLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKSB7XG4gIHZhciBjaGFyc1dyaXR0ZW4gPSBibGl0QnVmZmVyKHV0ZjE2bGVUb0J5dGVzKHN0cmluZyksIGJ1Ziwgb2Zmc2V0LCBsZW5ndGgpXG4gIHJldHVybiBjaGFyc1dyaXR0ZW5cbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZSA9IGZ1bmN0aW9uIChzdHJpbmcsIG9mZnNldCwgbGVuZ3RoLCBlbmNvZGluZykge1xuICAvLyBTdXBwb3J0IGJvdGggKHN0cmluZywgb2Zmc2V0LCBsZW5ndGgsIGVuY29kaW5nKVxuICAvLyBhbmQgdGhlIGxlZ2FjeSAoc3RyaW5nLCBlbmNvZGluZywgb2Zmc2V0LCBsZW5ndGgpXG4gIGlmIChpc0Zpbml0ZShvZmZzZXQpKSB7XG4gICAgaWYgKCFpc0Zpbml0ZShsZW5ndGgpKSB7XG4gICAgICBlbmNvZGluZyA9IGxlbmd0aFxuICAgICAgbGVuZ3RoID0gdW5kZWZpbmVkXG4gICAgfVxuICB9IGVsc2UgeyAgLy8gbGVnYWN5XG4gICAgdmFyIHN3YXAgPSBlbmNvZGluZ1xuICAgIGVuY29kaW5nID0gb2Zmc2V0XG4gICAgb2Zmc2V0ID0gbGVuZ3RoXG4gICAgbGVuZ3RoID0gc3dhcFxuICB9XG5cbiAgb2Zmc2V0ID0gTnVtYmVyKG9mZnNldCkgfHwgMFxuICB2YXIgcmVtYWluaW5nID0gdGhpcy5sZW5ndGggLSBvZmZzZXRcbiAgaWYgKCFsZW5ndGgpIHtcbiAgICBsZW5ndGggPSByZW1haW5pbmdcbiAgfSBlbHNlIHtcbiAgICBsZW5ndGggPSBOdW1iZXIobGVuZ3RoKVxuICAgIGlmIChsZW5ndGggPiByZW1haW5pbmcpIHtcbiAgICAgIGxlbmd0aCA9IHJlbWFpbmluZ1xuICAgIH1cbiAgfVxuICBlbmNvZGluZyA9IFN0cmluZyhlbmNvZGluZyB8fCAndXRmOCcpLnRvTG93ZXJDYXNlKClcblxuICB2YXIgcmV0XG4gIHN3aXRjaCAoZW5jb2RpbmcpIHtcbiAgICBjYXNlICdoZXgnOlxuICAgICAgcmV0ID0gaGV4V3JpdGUodGhpcywgc3RyaW5nLCBvZmZzZXQsIGxlbmd0aClcbiAgICAgIGJyZWFrXG4gICAgY2FzZSAndXRmOCc6XG4gICAgY2FzZSAndXRmLTgnOlxuICAgICAgcmV0ID0gdXRmOFdyaXRlKHRoaXMsIHN0cmluZywgb2Zmc2V0LCBsZW5ndGgpXG4gICAgICBicmVha1xuICAgIGNhc2UgJ2FzY2lpJzpcbiAgICAgIHJldCA9IGFzY2lpV3JpdGUodGhpcywgc3RyaW5nLCBvZmZzZXQsIGxlbmd0aClcbiAgICAgIGJyZWFrXG4gICAgY2FzZSAnYmluYXJ5JzpcbiAgICAgIHJldCA9IGJpbmFyeVdyaXRlKHRoaXMsIHN0cmluZywgb2Zmc2V0LCBsZW5ndGgpXG4gICAgICBicmVha1xuICAgIGNhc2UgJ2Jhc2U2NCc6XG4gICAgICByZXQgPSBiYXNlNjRXcml0ZSh0aGlzLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKVxuICAgICAgYnJlYWtcbiAgICBjYXNlICd1Y3MyJzpcbiAgICBjYXNlICd1Y3MtMic6XG4gICAgY2FzZSAndXRmMTZsZSc6XG4gICAgY2FzZSAndXRmLTE2bGUnOlxuICAgICAgcmV0ID0gdXRmMTZsZVdyaXRlKHRoaXMsIHN0cmluZywgb2Zmc2V0LCBsZW5ndGgpXG4gICAgICBicmVha1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdVbmtub3duIGVuY29kaW5nOiAnICsgZW5jb2RpbmcpXG4gIH1cbiAgcmV0dXJuIHJldFxufVxuXG5CdWZmZXIucHJvdG90eXBlLnRvSlNPTiA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIHtcbiAgICB0eXBlOiAnQnVmZmVyJyxcbiAgICBkYXRhOiBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbCh0aGlzLl9hcnIgfHwgdGhpcywgMClcbiAgfVxufVxuXG5mdW5jdGlvbiBiYXNlNjRTbGljZSAoYnVmLCBzdGFydCwgZW5kKSB7XG4gIGlmIChzdGFydCA9PT0gMCAmJiBlbmQgPT09IGJ1Zi5sZW5ndGgpIHtcbiAgICByZXR1cm4gYmFzZTY0LmZyb21CeXRlQXJyYXkoYnVmKVxuICB9IGVsc2Uge1xuICAgIHJldHVybiBiYXNlNjQuZnJvbUJ5dGVBcnJheShidWYuc2xpY2Uoc3RhcnQsIGVuZCkpXG4gIH1cbn1cblxuZnVuY3Rpb24gdXRmOFNsaWNlIChidWYsIHN0YXJ0LCBlbmQpIHtcbiAgdmFyIHJlcyA9ICcnXG4gIHZhciB0bXAgPSAnJ1xuICBlbmQgPSBNYXRoLm1pbihidWYubGVuZ3RoLCBlbmQpXG5cbiAgZm9yICh2YXIgaSA9IHN0YXJ0OyBpIDwgZW5kOyBpKyspIHtcbiAgICBpZiAoYnVmW2ldIDw9IDB4N0YpIHtcbiAgICAgIHJlcyArPSBkZWNvZGVVdGY4Q2hhcih0bXApICsgU3RyaW5nLmZyb21DaGFyQ29kZShidWZbaV0pXG4gICAgICB0bXAgPSAnJ1xuICAgIH0gZWxzZSB7XG4gICAgICB0bXAgKz0gJyUnICsgYnVmW2ldLnRvU3RyaW5nKDE2KVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZXMgKyBkZWNvZGVVdGY4Q2hhcih0bXApXG59XG5cbmZ1bmN0aW9uIGFzY2lpU2xpY2UgKGJ1Ziwgc3RhcnQsIGVuZCkge1xuICB2YXIgcmV0ID0gJydcbiAgZW5kID0gTWF0aC5taW4oYnVmLmxlbmd0aCwgZW5kKVxuXG4gIGZvciAodmFyIGkgPSBzdGFydDsgaSA8IGVuZDsgaSsrKSB7XG4gICAgcmV0ICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYnVmW2ldKVxuICB9XG4gIHJldHVybiByZXRcbn1cblxuZnVuY3Rpb24gYmluYXJ5U2xpY2UgKGJ1Ziwgc3RhcnQsIGVuZCkge1xuICByZXR1cm4gYXNjaWlTbGljZShidWYsIHN0YXJ0LCBlbmQpXG59XG5cbmZ1bmN0aW9uIGhleFNsaWNlIChidWYsIHN0YXJ0LCBlbmQpIHtcbiAgdmFyIGxlbiA9IGJ1Zi5sZW5ndGhcblxuICBpZiAoIXN0YXJ0IHx8IHN0YXJ0IDwgMCkgc3RhcnQgPSAwXG4gIGlmICghZW5kIHx8IGVuZCA8IDAgfHwgZW5kID4gbGVuKSBlbmQgPSBsZW5cblxuICB2YXIgb3V0ID0gJydcbiAgZm9yICh2YXIgaSA9IHN0YXJ0OyBpIDwgZW5kOyBpKyspIHtcbiAgICBvdXQgKz0gdG9IZXgoYnVmW2ldKVxuICB9XG4gIHJldHVybiBvdXRcbn1cblxuZnVuY3Rpb24gdXRmMTZsZVNsaWNlIChidWYsIHN0YXJ0LCBlbmQpIHtcbiAgdmFyIGJ5dGVzID0gYnVmLnNsaWNlKHN0YXJ0LCBlbmQpXG4gIHZhciByZXMgPSAnJ1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAyKSB7XG4gICAgcmVzICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYnl0ZXNbaV0gKyBieXRlc1tpICsgMV0gKiAyNTYpXG4gIH1cbiAgcmV0dXJuIHJlc1xufVxuXG5CdWZmZXIucHJvdG90eXBlLnNsaWNlID0gZnVuY3Rpb24gKHN0YXJ0LCBlbmQpIHtcbiAgdmFyIGxlbiA9IHRoaXMubGVuZ3RoXG4gIHN0YXJ0ID0gfn5zdGFydFxuICBlbmQgPSBlbmQgPT09IHVuZGVmaW5lZCA/IGxlbiA6IH5+ZW5kXG5cbiAgaWYgKHN0YXJ0IDwgMCkge1xuICAgIHN0YXJ0ICs9IGxlbjtcbiAgICBpZiAoc3RhcnQgPCAwKVxuICAgICAgc3RhcnQgPSAwXG4gIH0gZWxzZSBpZiAoc3RhcnQgPiBsZW4pIHtcbiAgICBzdGFydCA9IGxlblxuICB9XG5cbiAgaWYgKGVuZCA8IDApIHtcbiAgICBlbmQgKz0gbGVuXG4gICAgaWYgKGVuZCA8IDApXG4gICAgICBlbmQgPSAwXG4gIH0gZWxzZSBpZiAoZW5kID4gbGVuKSB7XG4gICAgZW5kID0gbGVuXG4gIH1cblxuICBpZiAoZW5kIDwgc3RhcnQpXG4gICAgZW5kID0gc3RhcnRcblxuICBpZiAoQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHtcbiAgICByZXR1cm4gQnVmZmVyLl9hdWdtZW50KHRoaXMuc3ViYXJyYXkoc3RhcnQsIGVuZCkpXG4gIH0gZWxzZSB7XG4gICAgdmFyIHNsaWNlTGVuID0gZW5kIC0gc3RhcnRcbiAgICB2YXIgbmV3QnVmID0gbmV3IEJ1ZmZlcihzbGljZUxlbiwgdW5kZWZpbmVkLCB0cnVlKVxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc2xpY2VMZW47IGkrKykge1xuICAgICAgbmV3QnVmW2ldID0gdGhpc1tpICsgc3RhcnRdXG4gICAgfVxuICAgIHJldHVybiBuZXdCdWZcbiAgfVxufVxuXG4vKlxuICogTmVlZCB0byBtYWtlIHN1cmUgdGhhdCBidWZmZXIgaXNuJ3QgdHJ5aW5nIHRvIHdyaXRlIG91dCBvZiBib3VuZHMuXG4gKi9cbmZ1bmN0aW9uIGNoZWNrT2Zmc2V0IChvZmZzZXQsIGV4dCwgbGVuZ3RoKSB7XG4gIGlmICgob2Zmc2V0ICUgMSkgIT09IDAgfHwgb2Zmc2V0IDwgMClcbiAgICB0aHJvdyBuZXcgUmFuZ2VFcnJvcignb2Zmc2V0IGlzIG5vdCB1aW50JylcbiAgaWYgKG9mZnNldCArIGV4dCA+IGxlbmd0aClcbiAgICB0aHJvdyBuZXcgUmFuZ2VFcnJvcignVHJ5aW5nIHRvIGFjY2VzcyBiZXlvbmQgYnVmZmVyIGxlbmd0aCcpXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZFVJbnQ4ID0gZnVuY3Rpb24gKG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja09mZnNldChvZmZzZXQsIDEsIHRoaXMubGVuZ3RoKVxuICByZXR1cm4gdGhpc1tvZmZzZXRdXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZFVJbnQxNkxFID0gZnVuY3Rpb24gKG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja09mZnNldChvZmZzZXQsIDIsIHRoaXMubGVuZ3RoKVxuICByZXR1cm4gdGhpc1tvZmZzZXRdIHwgKHRoaXNbb2Zmc2V0ICsgMV0gPDwgOClcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5yZWFkVUludDE2QkUgPSBmdW5jdGlvbiAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrT2Zmc2V0KG9mZnNldCwgMiwgdGhpcy5sZW5ndGgpXG4gIHJldHVybiAodGhpc1tvZmZzZXRdIDw8IDgpIHwgdGhpc1tvZmZzZXQgKyAxXVxufVxuXG5CdWZmZXIucHJvdG90eXBlLnJlYWRVSW50MzJMRSA9IGZ1bmN0aW9uIChvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIGlmICghbm9Bc3NlcnQpXG4gICAgY2hlY2tPZmZzZXQob2Zmc2V0LCA0LCB0aGlzLmxlbmd0aClcblxuICByZXR1cm4gKCh0aGlzW29mZnNldF0pIHxcbiAgICAgICh0aGlzW29mZnNldCArIDFdIDw8IDgpIHxcbiAgICAgICh0aGlzW29mZnNldCArIDJdIDw8IDE2KSkgK1xuICAgICAgKHRoaXNbb2Zmc2V0ICsgM10gKiAweDEwMDAwMDApXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZFVJbnQzMkJFID0gZnVuY3Rpb24gKG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja09mZnNldChvZmZzZXQsIDQsIHRoaXMubGVuZ3RoKVxuXG4gIHJldHVybiAodGhpc1tvZmZzZXRdICogMHgxMDAwMDAwKSArXG4gICAgICAoKHRoaXNbb2Zmc2V0ICsgMV0gPDwgMTYpIHxcbiAgICAgICh0aGlzW29mZnNldCArIDJdIDw8IDgpIHxcbiAgICAgIHRoaXNbb2Zmc2V0ICsgM10pXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZEludDggPSBmdW5jdGlvbiAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrT2Zmc2V0KG9mZnNldCwgMSwgdGhpcy5sZW5ndGgpXG4gIGlmICghKHRoaXNbb2Zmc2V0XSAmIDB4ODApKVxuICAgIHJldHVybiAodGhpc1tvZmZzZXRdKVxuICByZXR1cm4gKCgweGZmIC0gdGhpc1tvZmZzZXRdICsgMSkgKiAtMSlcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5yZWFkSW50MTZMRSA9IGZ1bmN0aW9uIChvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIGlmICghbm9Bc3NlcnQpXG4gICAgY2hlY2tPZmZzZXQob2Zmc2V0LCAyLCB0aGlzLmxlbmd0aClcbiAgdmFyIHZhbCA9IHRoaXNbb2Zmc2V0XSB8ICh0aGlzW29mZnNldCArIDFdIDw8IDgpXG4gIHJldHVybiAodmFsICYgMHg4MDAwKSA/IHZhbCB8IDB4RkZGRjAwMDAgOiB2YWxcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5yZWFkSW50MTZCRSA9IGZ1bmN0aW9uIChvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIGlmICghbm9Bc3NlcnQpXG4gICAgY2hlY2tPZmZzZXQob2Zmc2V0LCAyLCB0aGlzLmxlbmd0aClcbiAgdmFyIHZhbCA9IHRoaXNbb2Zmc2V0ICsgMV0gfCAodGhpc1tvZmZzZXRdIDw8IDgpXG4gIHJldHVybiAodmFsICYgMHg4MDAwKSA/IHZhbCB8IDB4RkZGRjAwMDAgOiB2YWxcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5yZWFkSW50MzJMRSA9IGZ1bmN0aW9uIChvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIGlmICghbm9Bc3NlcnQpXG4gICAgY2hlY2tPZmZzZXQob2Zmc2V0LCA0LCB0aGlzLmxlbmd0aClcblxuICByZXR1cm4gKHRoaXNbb2Zmc2V0XSkgfFxuICAgICAgKHRoaXNbb2Zmc2V0ICsgMV0gPDwgOCkgfFxuICAgICAgKHRoaXNbb2Zmc2V0ICsgMl0gPDwgMTYpIHxcbiAgICAgICh0aGlzW29mZnNldCArIDNdIDw8IDI0KVxufVxuXG5CdWZmZXIucHJvdG90eXBlLnJlYWRJbnQzMkJFID0gZnVuY3Rpb24gKG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja09mZnNldChvZmZzZXQsIDQsIHRoaXMubGVuZ3RoKVxuXG4gIHJldHVybiAodGhpc1tvZmZzZXRdIDw8IDI0KSB8XG4gICAgICAodGhpc1tvZmZzZXQgKyAxXSA8PCAxNikgfFxuICAgICAgKHRoaXNbb2Zmc2V0ICsgMl0gPDwgOCkgfFxuICAgICAgKHRoaXNbb2Zmc2V0ICsgM10pXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZEZsb2F0TEUgPSBmdW5jdGlvbiAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrT2Zmc2V0KG9mZnNldCwgNCwgdGhpcy5sZW5ndGgpXG4gIHJldHVybiBpZWVlNzU0LnJlYWQodGhpcywgb2Zmc2V0LCB0cnVlLCAyMywgNClcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5yZWFkRmxvYXRCRSA9IGZ1bmN0aW9uIChvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIGlmICghbm9Bc3NlcnQpXG4gICAgY2hlY2tPZmZzZXQob2Zmc2V0LCA0LCB0aGlzLmxlbmd0aClcbiAgcmV0dXJuIGllZWU3NTQucmVhZCh0aGlzLCBvZmZzZXQsIGZhbHNlLCAyMywgNClcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5yZWFkRG91YmxlTEUgPSBmdW5jdGlvbiAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrT2Zmc2V0KG9mZnNldCwgOCwgdGhpcy5sZW5ndGgpXG4gIHJldHVybiBpZWVlNzU0LnJlYWQodGhpcywgb2Zmc2V0LCB0cnVlLCA1MiwgOClcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5yZWFkRG91YmxlQkUgPSBmdW5jdGlvbiAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrT2Zmc2V0KG9mZnNldCwgOCwgdGhpcy5sZW5ndGgpXG4gIHJldHVybiBpZWVlNzU0LnJlYWQodGhpcywgb2Zmc2V0LCBmYWxzZSwgNTIsIDgpXG59XG5cbmZ1bmN0aW9uIGNoZWNrSW50IChidWYsIHZhbHVlLCBvZmZzZXQsIGV4dCwgbWF4LCBtaW4pIHtcbiAgaWYgKCFCdWZmZXIuaXNCdWZmZXIoYnVmKSkgdGhyb3cgbmV3IFR5cGVFcnJvcignYnVmZmVyIG11c3QgYmUgYSBCdWZmZXIgaW5zdGFuY2UnKVxuICBpZiAodmFsdWUgPiBtYXggfHwgdmFsdWUgPCBtaW4pIHRocm93IG5ldyBUeXBlRXJyb3IoJ3ZhbHVlIGlzIG91dCBvZiBib3VuZHMnKVxuICBpZiAob2Zmc2V0ICsgZXh0ID4gYnVmLmxlbmd0aCkgdGhyb3cgbmV3IFR5cGVFcnJvcignaW5kZXggb3V0IG9mIHJhbmdlJylcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZVVJbnQ4ID0gZnVuY3Rpb24gKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHZhbHVlID0gK3ZhbHVlXG4gIG9mZnNldCA9IG9mZnNldCA+Pj4gMFxuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrSW50KHRoaXMsIHZhbHVlLCBvZmZzZXQsIDEsIDB4ZmYsIDApXG4gIGlmICghQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHZhbHVlID0gTWF0aC5mbG9vcih2YWx1ZSlcbiAgdGhpc1tvZmZzZXRdID0gdmFsdWVcbiAgcmV0dXJuIG9mZnNldCArIDFcbn1cblxuZnVuY3Rpb24gb2JqZWN0V3JpdGVVSW50MTYgKGJ1ZiwgdmFsdWUsIG9mZnNldCwgbGl0dGxlRW5kaWFuKSB7XG4gIGlmICh2YWx1ZSA8IDApIHZhbHVlID0gMHhmZmZmICsgdmFsdWUgKyAxXG4gIGZvciAodmFyIGkgPSAwLCBqID0gTWF0aC5taW4oYnVmLmxlbmd0aCAtIG9mZnNldCwgMik7IGkgPCBqOyBpKyspIHtcbiAgICBidWZbb2Zmc2V0ICsgaV0gPSAodmFsdWUgJiAoMHhmZiA8PCAoOCAqIChsaXR0bGVFbmRpYW4gPyBpIDogMSAtIGkpKSkpID4+PlxuICAgICAgKGxpdHRsZUVuZGlhbiA/IGkgOiAxIC0gaSkgKiA4XG4gIH1cbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZVVJbnQxNkxFID0gZnVuY3Rpb24gKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHZhbHVlID0gK3ZhbHVlXG4gIG9mZnNldCA9IG9mZnNldCA+Pj4gMFxuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrSW50KHRoaXMsIHZhbHVlLCBvZmZzZXQsIDIsIDB4ZmZmZiwgMClcbiAgaWYgKEJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUKSB7XG4gICAgdGhpc1tvZmZzZXRdID0gdmFsdWVcbiAgICB0aGlzW29mZnNldCArIDFdID0gKHZhbHVlID4+PiA4KVxuICB9IGVsc2Ugb2JqZWN0V3JpdGVVSW50MTYodGhpcywgdmFsdWUsIG9mZnNldCwgdHJ1ZSlcbiAgcmV0dXJuIG9mZnNldCArIDJcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZVVJbnQxNkJFID0gZnVuY3Rpb24gKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHZhbHVlID0gK3ZhbHVlXG4gIG9mZnNldCA9IG9mZnNldCA+Pj4gMFxuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrSW50KHRoaXMsIHZhbHVlLCBvZmZzZXQsIDIsIDB4ZmZmZiwgMClcbiAgaWYgKEJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUKSB7XG4gICAgdGhpc1tvZmZzZXRdID0gKHZhbHVlID4+PiA4KVxuICAgIHRoaXNbb2Zmc2V0ICsgMV0gPSB2YWx1ZVxuICB9IGVsc2Ugb2JqZWN0V3JpdGVVSW50MTYodGhpcywgdmFsdWUsIG9mZnNldCwgZmFsc2UpXG4gIHJldHVybiBvZmZzZXQgKyAyXG59XG5cbmZ1bmN0aW9uIG9iamVjdFdyaXRlVUludDMyIChidWYsIHZhbHVlLCBvZmZzZXQsIGxpdHRsZUVuZGlhbikge1xuICBpZiAodmFsdWUgPCAwKSB2YWx1ZSA9IDB4ZmZmZmZmZmYgKyB2YWx1ZSArIDFcbiAgZm9yICh2YXIgaSA9IDAsIGogPSBNYXRoLm1pbihidWYubGVuZ3RoIC0gb2Zmc2V0LCA0KTsgaSA8IGo7IGkrKykge1xuICAgIGJ1ZltvZmZzZXQgKyBpXSA9ICh2YWx1ZSA+Pj4gKGxpdHRsZUVuZGlhbiA/IGkgOiAzIC0gaSkgKiA4KSAmIDB4ZmZcbiAgfVxufVxuXG5CdWZmZXIucHJvdG90eXBlLndyaXRlVUludDMyTEUgPSBmdW5jdGlvbiAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgdmFsdWUgPSArdmFsdWVcbiAgb2Zmc2V0ID0gb2Zmc2V0ID4+PiAwXG4gIGlmICghbm9Bc3NlcnQpXG4gICAgY2hlY2tJbnQodGhpcywgdmFsdWUsIG9mZnNldCwgNCwgMHhmZmZmZmZmZiwgMClcbiAgaWYgKEJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUKSB7XG4gICAgdGhpc1tvZmZzZXQgKyAzXSA9ICh2YWx1ZSA+Pj4gMjQpXG4gICAgdGhpc1tvZmZzZXQgKyAyXSA9ICh2YWx1ZSA+Pj4gMTYpXG4gICAgdGhpc1tvZmZzZXQgKyAxXSA9ICh2YWx1ZSA+Pj4gOClcbiAgICB0aGlzW29mZnNldF0gPSB2YWx1ZVxuICB9IGVsc2Ugb2JqZWN0V3JpdGVVSW50MzIodGhpcywgdmFsdWUsIG9mZnNldCwgdHJ1ZSlcbiAgcmV0dXJuIG9mZnNldCArIDRcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZVVJbnQzMkJFID0gZnVuY3Rpb24gKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHZhbHVlID0gK3ZhbHVlXG4gIG9mZnNldCA9IG9mZnNldCA+Pj4gMFxuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrSW50KHRoaXMsIHZhbHVlLCBvZmZzZXQsIDQsIDB4ZmZmZmZmZmYsIDApXG4gIGlmIChCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkge1xuICAgIHRoaXNbb2Zmc2V0XSA9ICh2YWx1ZSA+Pj4gMjQpXG4gICAgdGhpc1tvZmZzZXQgKyAxXSA9ICh2YWx1ZSA+Pj4gMTYpXG4gICAgdGhpc1tvZmZzZXQgKyAyXSA9ICh2YWx1ZSA+Pj4gOClcbiAgICB0aGlzW29mZnNldCArIDNdID0gdmFsdWVcbiAgfSBlbHNlIG9iamVjdFdyaXRlVUludDMyKHRoaXMsIHZhbHVlLCBvZmZzZXQsIGZhbHNlKVxuICByZXR1cm4gb2Zmc2V0ICsgNFxufVxuXG5CdWZmZXIucHJvdG90eXBlLndyaXRlSW50OCA9IGZ1bmN0aW9uICh2YWx1ZSwgb2Zmc2V0LCBub0Fzc2VydCkge1xuICB2YWx1ZSA9ICt2YWx1ZVxuICBvZmZzZXQgPSBvZmZzZXQgPj4+IDBcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja0ludCh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCAxLCAweDdmLCAtMHg4MClcbiAgaWYgKCFCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkgdmFsdWUgPSBNYXRoLmZsb29yKHZhbHVlKVxuICBpZiAodmFsdWUgPCAwKSB2YWx1ZSA9IDB4ZmYgKyB2YWx1ZSArIDFcbiAgdGhpc1tvZmZzZXRdID0gdmFsdWVcbiAgcmV0dXJuIG9mZnNldCArIDFcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZUludDE2TEUgPSBmdW5jdGlvbiAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgdmFsdWUgPSArdmFsdWVcbiAgb2Zmc2V0ID0gb2Zmc2V0ID4+PiAwXG4gIGlmICghbm9Bc3NlcnQpXG4gICAgY2hlY2tJbnQodGhpcywgdmFsdWUsIG9mZnNldCwgMiwgMHg3ZmZmLCAtMHg4MDAwKVxuICBpZiAoQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHtcbiAgICB0aGlzW29mZnNldF0gPSB2YWx1ZVxuICAgIHRoaXNbb2Zmc2V0ICsgMV0gPSAodmFsdWUgPj4+IDgpXG4gIH0gZWxzZSBvYmplY3RXcml0ZVVJbnQxNih0aGlzLCB2YWx1ZSwgb2Zmc2V0LCB0cnVlKVxuICByZXR1cm4gb2Zmc2V0ICsgMlxufVxuXG5CdWZmZXIucHJvdG90eXBlLndyaXRlSW50MTZCRSA9IGZ1bmN0aW9uICh2YWx1ZSwgb2Zmc2V0LCBub0Fzc2VydCkge1xuICB2YWx1ZSA9ICt2YWx1ZVxuICBvZmZzZXQgPSBvZmZzZXQgPj4+IDBcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja0ludCh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCAyLCAweDdmZmYsIC0weDgwMDApXG4gIGlmIChCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkge1xuICAgIHRoaXNbb2Zmc2V0XSA9ICh2YWx1ZSA+Pj4gOClcbiAgICB0aGlzW29mZnNldCArIDFdID0gdmFsdWVcbiAgfSBlbHNlIG9iamVjdFdyaXRlVUludDE2KHRoaXMsIHZhbHVlLCBvZmZzZXQsIGZhbHNlKVxuICByZXR1cm4gb2Zmc2V0ICsgMlxufVxuXG5CdWZmZXIucHJvdG90eXBlLndyaXRlSW50MzJMRSA9IGZ1bmN0aW9uICh2YWx1ZSwgb2Zmc2V0LCBub0Fzc2VydCkge1xuICB2YWx1ZSA9ICt2YWx1ZVxuICBvZmZzZXQgPSBvZmZzZXQgPj4+IDBcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja0ludCh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCA0LCAweDdmZmZmZmZmLCAtMHg4MDAwMDAwMClcbiAgaWYgKEJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUKSB7XG4gICAgdGhpc1tvZmZzZXRdID0gdmFsdWVcbiAgICB0aGlzW29mZnNldCArIDFdID0gKHZhbHVlID4+PiA4KVxuICAgIHRoaXNbb2Zmc2V0ICsgMl0gPSAodmFsdWUgPj4+IDE2KVxuICAgIHRoaXNbb2Zmc2V0ICsgM10gPSAodmFsdWUgPj4+IDI0KVxuICB9IGVsc2Ugb2JqZWN0V3JpdGVVSW50MzIodGhpcywgdmFsdWUsIG9mZnNldCwgdHJ1ZSlcbiAgcmV0dXJuIG9mZnNldCArIDRcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZUludDMyQkUgPSBmdW5jdGlvbiAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgdmFsdWUgPSArdmFsdWVcbiAgb2Zmc2V0ID0gb2Zmc2V0ID4+PiAwXG4gIGlmICghbm9Bc3NlcnQpXG4gICAgY2hlY2tJbnQodGhpcywgdmFsdWUsIG9mZnNldCwgNCwgMHg3ZmZmZmZmZiwgLTB4ODAwMDAwMDApXG4gIGlmICh2YWx1ZSA8IDApIHZhbHVlID0gMHhmZmZmZmZmZiArIHZhbHVlICsgMVxuICBpZiAoQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHtcbiAgICB0aGlzW29mZnNldF0gPSAodmFsdWUgPj4+IDI0KVxuICAgIHRoaXNbb2Zmc2V0ICsgMV0gPSAodmFsdWUgPj4+IDE2KVxuICAgIHRoaXNbb2Zmc2V0ICsgMl0gPSAodmFsdWUgPj4+IDgpXG4gICAgdGhpc1tvZmZzZXQgKyAzXSA9IHZhbHVlXG4gIH0gZWxzZSBvYmplY3RXcml0ZVVJbnQzMih0aGlzLCB2YWx1ZSwgb2Zmc2V0LCBmYWxzZSlcbiAgcmV0dXJuIG9mZnNldCArIDRcbn1cblxuZnVuY3Rpb24gY2hlY2tJRUVFNzU0IChidWYsIHZhbHVlLCBvZmZzZXQsIGV4dCwgbWF4LCBtaW4pIHtcbiAgaWYgKHZhbHVlID4gbWF4IHx8IHZhbHVlIDwgbWluKSB0aHJvdyBuZXcgVHlwZUVycm9yKCd2YWx1ZSBpcyBvdXQgb2YgYm91bmRzJylcbiAgaWYgKG9mZnNldCArIGV4dCA+IGJ1Zi5sZW5ndGgpIHRocm93IG5ldyBUeXBlRXJyb3IoJ2luZGV4IG91dCBvZiByYW5nZScpXG59XG5cbmZ1bmN0aW9uIHdyaXRlRmxvYXQgKGJ1ZiwgdmFsdWUsIG9mZnNldCwgbGl0dGxlRW5kaWFuLCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrSUVFRTc1NChidWYsIHZhbHVlLCBvZmZzZXQsIDQsIDMuNDAyODIzNDY2Mzg1Mjg4NmUrMzgsIC0zLjQwMjgyMzQ2NjM4NTI4ODZlKzM4KVxuICBpZWVlNzU0LndyaXRlKGJ1ZiwgdmFsdWUsIG9mZnNldCwgbGl0dGxlRW5kaWFuLCAyMywgNClcbiAgcmV0dXJuIG9mZnNldCArIDRcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZUZsb2F0TEUgPSBmdW5jdGlvbiAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgcmV0dXJuIHdyaXRlRmxvYXQodGhpcywgdmFsdWUsIG9mZnNldCwgdHJ1ZSwgbm9Bc3NlcnQpXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUud3JpdGVGbG9hdEJFID0gZnVuY3Rpb24gKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHJldHVybiB3cml0ZUZsb2F0KHRoaXMsIHZhbHVlLCBvZmZzZXQsIGZhbHNlLCBub0Fzc2VydClcbn1cblxuZnVuY3Rpb24gd3JpdGVEb3VibGUgKGJ1ZiwgdmFsdWUsIG9mZnNldCwgbGl0dGxlRW5kaWFuLCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrSUVFRTc1NChidWYsIHZhbHVlLCBvZmZzZXQsIDgsIDEuNzk3NjkzMTM0ODYyMzE1N0UrMzA4LCAtMS43OTc2OTMxMzQ4NjIzMTU3RSszMDgpXG4gIGllZWU3NTQud3JpdGUoYnVmLCB2YWx1ZSwgb2Zmc2V0LCBsaXR0bGVFbmRpYW4sIDUyLCA4KVxuICByZXR1cm4gb2Zmc2V0ICsgOFxufVxuXG5CdWZmZXIucHJvdG90eXBlLndyaXRlRG91YmxlTEUgPSBmdW5jdGlvbiAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgcmV0dXJuIHdyaXRlRG91YmxlKHRoaXMsIHZhbHVlLCBvZmZzZXQsIHRydWUsIG5vQXNzZXJ0KVxufVxuXG5CdWZmZXIucHJvdG90eXBlLndyaXRlRG91YmxlQkUgPSBmdW5jdGlvbiAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgcmV0dXJuIHdyaXRlRG91YmxlKHRoaXMsIHZhbHVlLCBvZmZzZXQsIGZhbHNlLCBub0Fzc2VydClcbn1cblxuLy8gY29weSh0YXJnZXRCdWZmZXIsIHRhcmdldFN0YXJ0PTAsIHNvdXJjZVN0YXJ0PTAsIHNvdXJjZUVuZD1idWZmZXIubGVuZ3RoKVxuQnVmZmVyLnByb3RvdHlwZS5jb3B5ID0gZnVuY3Rpb24gKHRhcmdldCwgdGFyZ2V0X3N0YXJ0LCBzdGFydCwgZW5kKSB7XG4gIHZhciBzb3VyY2UgPSB0aGlzXG5cbiAgaWYgKCFzdGFydCkgc3RhcnQgPSAwXG4gIGlmICghZW5kICYmIGVuZCAhPT0gMCkgZW5kID0gdGhpcy5sZW5ndGhcbiAgaWYgKCF0YXJnZXRfc3RhcnQpIHRhcmdldF9zdGFydCA9IDBcblxuICAvLyBDb3B5IDAgYnl0ZXM7IHdlJ3JlIGRvbmVcbiAgaWYgKGVuZCA9PT0gc3RhcnQpIHJldHVyblxuICBpZiAodGFyZ2V0Lmxlbmd0aCA9PT0gMCB8fCBzb3VyY2UubGVuZ3RoID09PSAwKSByZXR1cm5cblxuICAvLyBGYXRhbCBlcnJvciBjb25kaXRpb25zXG4gIGlmIChlbmQgPCBzdGFydCkgdGhyb3cgbmV3IFR5cGVFcnJvcignc291cmNlRW5kIDwgc291cmNlU3RhcnQnKVxuICBpZiAodGFyZ2V0X3N0YXJ0IDwgMCB8fCB0YXJnZXRfc3RhcnQgPj0gdGFyZ2V0Lmxlbmd0aClcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCd0YXJnZXRTdGFydCBvdXQgb2YgYm91bmRzJylcbiAgaWYgKHN0YXJ0IDwgMCB8fCBzdGFydCA+PSBzb3VyY2UubGVuZ3RoKSB0aHJvdyBuZXcgVHlwZUVycm9yKCdzb3VyY2VTdGFydCBvdXQgb2YgYm91bmRzJylcbiAgaWYgKGVuZCA8IDAgfHwgZW5kID4gc291cmNlLmxlbmd0aCkgdGhyb3cgbmV3IFR5cGVFcnJvcignc291cmNlRW5kIG91dCBvZiBib3VuZHMnKVxuXG4gIC8vIEFyZSB3ZSBvb2I/XG4gIGlmIChlbmQgPiB0aGlzLmxlbmd0aClcbiAgICBlbmQgPSB0aGlzLmxlbmd0aFxuICBpZiAodGFyZ2V0Lmxlbmd0aCAtIHRhcmdldF9zdGFydCA8IGVuZCAtIHN0YXJ0KVxuICAgIGVuZCA9IHRhcmdldC5sZW5ndGggLSB0YXJnZXRfc3RhcnQgKyBzdGFydFxuXG4gIHZhciBsZW4gPSBlbmQgLSBzdGFydFxuXG4gIGlmIChsZW4gPCAxMDAwIHx8ICFCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkge1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuOyBpKyspIHtcbiAgICAgIHRhcmdldFtpICsgdGFyZ2V0X3N0YXJ0XSA9IHRoaXNbaSArIHN0YXJ0XVxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB0YXJnZXQuX3NldCh0aGlzLnN1YmFycmF5KHN0YXJ0LCBzdGFydCArIGxlbiksIHRhcmdldF9zdGFydClcbiAgfVxufVxuXG4vLyBmaWxsKHZhbHVlLCBzdGFydD0wLCBlbmQ9YnVmZmVyLmxlbmd0aClcbkJ1ZmZlci5wcm90b3R5cGUuZmlsbCA9IGZ1bmN0aW9uICh2YWx1ZSwgc3RhcnQsIGVuZCkge1xuICBpZiAoIXZhbHVlKSB2YWx1ZSA9IDBcbiAgaWYgKCFzdGFydCkgc3RhcnQgPSAwXG4gIGlmICghZW5kKSBlbmQgPSB0aGlzLmxlbmd0aFxuXG4gIGlmIChlbmQgPCBzdGFydCkgdGhyb3cgbmV3IFR5cGVFcnJvcignZW5kIDwgc3RhcnQnKVxuXG4gIC8vIEZpbGwgMCBieXRlczsgd2UncmUgZG9uZVxuICBpZiAoZW5kID09PSBzdGFydCkgcmV0dXJuXG4gIGlmICh0aGlzLmxlbmd0aCA9PT0gMCkgcmV0dXJuXG5cbiAgaWYgKHN0YXJ0IDwgMCB8fCBzdGFydCA+PSB0aGlzLmxlbmd0aCkgdGhyb3cgbmV3IFR5cGVFcnJvcignc3RhcnQgb3V0IG9mIGJvdW5kcycpXG4gIGlmIChlbmQgPCAwIHx8IGVuZCA+IHRoaXMubGVuZ3RoKSB0aHJvdyBuZXcgVHlwZUVycm9yKCdlbmQgb3V0IG9mIGJvdW5kcycpXG5cbiAgdmFyIGlcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicpIHtcbiAgICBmb3IgKGkgPSBzdGFydDsgaSA8IGVuZDsgaSsrKSB7XG4gICAgICB0aGlzW2ldID0gdmFsdWVcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgdmFyIGJ5dGVzID0gdXRmOFRvQnl0ZXModmFsdWUudG9TdHJpbmcoKSlcbiAgICB2YXIgbGVuID0gYnl0ZXMubGVuZ3RoXG4gICAgZm9yIChpID0gc3RhcnQ7IGkgPCBlbmQ7IGkrKykge1xuICAgICAgdGhpc1tpXSA9IGJ5dGVzW2kgJSBsZW5dXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHRoaXNcbn1cblxuLyoqXG4gKiBDcmVhdGVzIGEgbmV3IGBBcnJheUJ1ZmZlcmAgd2l0aCB0aGUgKmNvcGllZCogbWVtb3J5IG9mIHRoZSBidWZmZXIgaW5zdGFuY2UuXG4gKiBBZGRlZCBpbiBOb2RlIDAuMTIuIE9ubHkgYXZhaWxhYmxlIGluIGJyb3dzZXJzIHRoYXQgc3VwcG9ydCBBcnJheUJ1ZmZlci5cbiAqL1xuQnVmZmVyLnByb3RvdHlwZS50b0FycmF5QnVmZmVyID0gZnVuY3Rpb24gKCkge1xuICBpZiAodHlwZW9mIFVpbnQ4QXJyYXkgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgaWYgKEJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUKSB7XG4gICAgICByZXR1cm4gKG5ldyBCdWZmZXIodGhpcykpLmJ1ZmZlclxuICAgIH0gZWxzZSB7XG4gICAgICB2YXIgYnVmID0gbmV3IFVpbnQ4QXJyYXkodGhpcy5sZW5ndGgpXG4gICAgICBmb3IgKHZhciBpID0gMCwgbGVuID0gYnVmLmxlbmd0aDsgaSA8IGxlbjsgaSArPSAxKSB7XG4gICAgICAgIGJ1ZltpXSA9IHRoaXNbaV1cbiAgICAgIH1cbiAgICAgIHJldHVybiBidWYuYnVmZmVyXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0J1ZmZlci50b0FycmF5QnVmZmVyIG5vdCBzdXBwb3J0ZWQgaW4gdGhpcyBicm93c2VyJylcbiAgfVxufVxuXG4vLyBIRUxQRVIgRlVOQ1RJT05TXG4vLyA9PT09PT09PT09PT09PT09XG5cbnZhciBCUCA9IEJ1ZmZlci5wcm90b3R5cGVcblxuLyoqXG4gKiBBdWdtZW50IGEgVWludDhBcnJheSAqaW5zdGFuY2UqIChub3QgdGhlIFVpbnQ4QXJyYXkgY2xhc3MhKSB3aXRoIEJ1ZmZlciBtZXRob2RzXG4gKi9cbkJ1ZmZlci5fYXVnbWVudCA9IGZ1bmN0aW9uIChhcnIpIHtcbiAgYXJyLmNvbnN0cnVjdG9yID0gQnVmZmVyXG4gIGFyci5faXNCdWZmZXIgPSB0cnVlXG5cbiAgLy8gc2F2ZSByZWZlcmVuY2UgdG8gb3JpZ2luYWwgVWludDhBcnJheSBnZXQvc2V0IG1ldGhvZHMgYmVmb3JlIG92ZXJ3cml0aW5nXG4gIGFyci5fZ2V0ID0gYXJyLmdldFxuICBhcnIuX3NldCA9IGFyci5zZXRcblxuICAvLyBkZXByZWNhdGVkLCB3aWxsIGJlIHJlbW92ZWQgaW4gbm9kZSAwLjEzK1xuICBhcnIuZ2V0ID0gQlAuZ2V0XG4gIGFyci5zZXQgPSBCUC5zZXRcblxuICBhcnIud3JpdGUgPSBCUC53cml0ZVxuICBhcnIudG9TdHJpbmcgPSBCUC50b1N0cmluZ1xuICBhcnIudG9Mb2NhbGVTdHJpbmcgPSBCUC50b1N0cmluZ1xuICBhcnIudG9KU09OID0gQlAudG9KU09OXG4gIGFyci5lcXVhbHMgPSBCUC5lcXVhbHNcbiAgYXJyLmNvbXBhcmUgPSBCUC5jb21wYXJlXG4gIGFyci5jb3B5ID0gQlAuY29weVxuICBhcnIuc2xpY2UgPSBCUC5zbGljZVxuICBhcnIucmVhZFVJbnQ4ID0gQlAucmVhZFVJbnQ4XG4gIGFyci5yZWFkVUludDE2TEUgPSBCUC5yZWFkVUludDE2TEVcbiAgYXJyLnJlYWRVSW50MTZCRSA9IEJQLnJlYWRVSW50MTZCRVxuICBhcnIucmVhZFVJbnQzMkxFID0gQlAucmVhZFVJbnQzMkxFXG4gIGFyci5yZWFkVUludDMyQkUgPSBCUC5yZWFkVUludDMyQkVcbiAgYXJyLnJlYWRJbnQ4ID0gQlAucmVhZEludDhcbiAgYXJyLnJlYWRJbnQxNkxFID0gQlAucmVhZEludDE2TEVcbiAgYXJyLnJlYWRJbnQxNkJFID0gQlAucmVhZEludDE2QkVcbiAgYXJyLnJlYWRJbnQzMkxFID0gQlAucmVhZEludDMyTEVcbiAgYXJyLnJlYWRJbnQzMkJFID0gQlAucmVhZEludDMyQkVcbiAgYXJyLnJlYWRGbG9hdExFID0gQlAucmVhZEZsb2F0TEVcbiAgYXJyLnJlYWRGbG9hdEJFID0gQlAucmVhZEZsb2F0QkVcbiAgYXJyLnJlYWREb3VibGVMRSA9IEJQLnJlYWREb3VibGVMRVxuICBhcnIucmVhZERvdWJsZUJFID0gQlAucmVhZERvdWJsZUJFXG4gIGFyci53cml0ZVVJbnQ4ID0gQlAud3JpdGVVSW50OFxuICBhcnIud3JpdGVVSW50MTZMRSA9IEJQLndyaXRlVUludDE2TEVcbiAgYXJyLndyaXRlVUludDE2QkUgPSBCUC53cml0ZVVJbnQxNkJFXG4gIGFyci53cml0ZVVJbnQzMkxFID0gQlAud3JpdGVVSW50MzJMRVxuICBhcnIud3JpdGVVSW50MzJCRSA9IEJQLndyaXRlVUludDMyQkVcbiAgYXJyLndyaXRlSW50OCA9IEJQLndyaXRlSW50OFxuICBhcnIud3JpdGVJbnQxNkxFID0gQlAud3JpdGVJbnQxNkxFXG4gIGFyci53cml0ZUludDE2QkUgPSBCUC53cml0ZUludDE2QkVcbiAgYXJyLndyaXRlSW50MzJMRSA9IEJQLndyaXRlSW50MzJMRVxuICBhcnIud3JpdGVJbnQzMkJFID0gQlAud3JpdGVJbnQzMkJFXG4gIGFyci53cml0ZUZsb2F0TEUgPSBCUC53cml0ZUZsb2F0TEVcbiAgYXJyLndyaXRlRmxvYXRCRSA9IEJQLndyaXRlRmxvYXRCRVxuICBhcnIud3JpdGVEb3VibGVMRSA9IEJQLndyaXRlRG91YmxlTEVcbiAgYXJyLndyaXRlRG91YmxlQkUgPSBCUC53cml0ZURvdWJsZUJFXG4gIGFyci5maWxsID0gQlAuZmlsbFxuICBhcnIuaW5zcGVjdCA9IEJQLmluc3BlY3RcbiAgYXJyLnRvQXJyYXlCdWZmZXIgPSBCUC50b0FycmF5QnVmZmVyXG5cbiAgcmV0dXJuIGFyclxufVxuXG52YXIgSU5WQUxJRF9CQVNFNjRfUkUgPSAvW14rXFwvMC05QS16XS9nXG5cbmZ1bmN0aW9uIGJhc2U2NGNsZWFuIChzdHIpIHtcbiAgLy8gTm9kZSBzdHJpcHMgb3V0IGludmFsaWQgY2hhcmFjdGVycyBsaWtlIFxcbiBhbmQgXFx0IGZyb20gdGhlIHN0cmluZywgYmFzZTY0LWpzIGRvZXMgbm90XG4gIHN0ciA9IHN0cmluZ3RyaW0oc3RyKS5yZXBsYWNlKElOVkFMSURfQkFTRTY0X1JFLCAnJylcbiAgLy8gTm9kZSBhbGxvd3MgZm9yIG5vbi1wYWRkZWQgYmFzZTY0IHN0cmluZ3MgKG1pc3NpbmcgdHJhaWxpbmcgPT09KSwgYmFzZTY0LWpzIGRvZXMgbm90XG4gIHdoaWxlIChzdHIubGVuZ3RoICUgNCAhPT0gMCkge1xuICAgIHN0ciA9IHN0ciArICc9J1xuICB9XG4gIHJldHVybiBzdHJcbn1cblxuZnVuY3Rpb24gc3RyaW5ndHJpbSAoc3RyKSB7XG4gIGlmIChzdHIudHJpbSkgcmV0dXJuIHN0ci50cmltKClcbiAgcmV0dXJuIHN0ci5yZXBsYWNlKC9eXFxzK3xcXHMrJC9nLCAnJylcbn1cblxuZnVuY3Rpb24gaXNBcnJheWlzaCAoc3ViamVjdCkge1xuICByZXR1cm4gaXNBcnJheShzdWJqZWN0KSB8fCBCdWZmZXIuaXNCdWZmZXIoc3ViamVjdCkgfHxcbiAgICAgIHN1YmplY3QgJiYgdHlwZW9mIHN1YmplY3QgPT09ICdvYmplY3QnICYmXG4gICAgICB0eXBlb2Ygc3ViamVjdC5sZW5ndGggPT09ICdudW1iZXInXG59XG5cbmZ1bmN0aW9uIHRvSGV4IChuKSB7XG4gIGlmIChuIDwgMTYpIHJldHVybiAnMCcgKyBuLnRvU3RyaW5nKDE2KVxuICByZXR1cm4gbi50b1N0cmluZygxNilcbn1cblxuZnVuY3Rpb24gdXRmOFRvQnl0ZXMgKHN0cikge1xuICB2YXIgYnl0ZUFycmF5ID0gW11cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBzdHIubGVuZ3RoOyBpKyspIHtcbiAgICB2YXIgYiA9IHN0ci5jaGFyQ29kZUF0KGkpXG4gICAgaWYgKGIgPD0gMHg3Rikge1xuICAgICAgYnl0ZUFycmF5LnB1c2goYilcbiAgICB9IGVsc2Uge1xuICAgICAgdmFyIHN0YXJ0ID0gaVxuICAgICAgaWYgKGIgPj0gMHhEODAwICYmIGIgPD0gMHhERkZGKSBpKytcbiAgICAgIHZhciBoID0gZW5jb2RlVVJJQ29tcG9uZW50KHN0ci5zbGljZShzdGFydCwgaSsxKSkuc3Vic3RyKDEpLnNwbGl0KCclJylcbiAgICAgIGZvciAodmFyIGogPSAwOyBqIDwgaC5sZW5ndGg7IGorKykge1xuICAgICAgICBieXRlQXJyYXkucHVzaChwYXJzZUludChoW2pdLCAxNikpXG4gICAgICB9XG4gICAgfVxuICB9XG4gIHJldHVybiBieXRlQXJyYXlcbn1cblxuZnVuY3Rpb24gYXNjaWlUb0J5dGVzIChzdHIpIHtcbiAgdmFyIGJ5dGVBcnJheSA9IFtdXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgc3RyLmxlbmd0aDsgaSsrKSB7XG4gICAgLy8gTm9kZSdzIGNvZGUgc2VlbXMgdG8gYmUgZG9pbmcgdGhpcyBhbmQgbm90ICYgMHg3Ri4uXG4gICAgYnl0ZUFycmF5LnB1c2goc3RyLmNoYXJDb2RlQXQoaSkgJiAweEZGKVxuICB9XG4gIHJldHVybiBieXRlQXJyYXlcbn1cblxuZnVuY3Rpb24gdXRmMTZsZVRvQnl0ZXMgKHN0cikge1xuICB2YXIgYywgaGksIGxvXG4gIHZhciBieXRlQXJyYXkgPSBbXVxuICBmb3IgKHZhciBpID0gMDsgaSA8IHN0ci5sZW5ndGg7IGkrKykge1xuICAgIGMgPSBzdHIuY2hhckNvZGVBdChpKVxuICAgIGhpID0gYyA+PiA4XG4gICAgbG8gPSBjICUgMjU2XG4gICAgYnl0ZUFycmF5LnB1c2gobG8pXG4gICAgYnl0ZUFycmF5LnB1c2goaGkpXG4gIH1cblxuICByZXR1cm4gYnl0ZUFycmF5XG59XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMgKHN0cikge1xuICByZXR1cm4gYmFzZTY0LnRvQnl0ZUFycmF5KHN0cilcbn1cblxuZnVuY3Rpb24gYmxpdEJ1ZmZlciAoc3JjLCBkc3QsIG9mZnNldCwgbGVuZ3RoKSB7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuZ3RoOyBpKyspIHtcbiAgICBpZiAoKGkgKyBvZmZzZXQgPj0gZHN0Lmxlbmd0aCkgfHwgKGkgPj0gc3JjLmxlbmd0aCkpXG4gICAgICBicmVha1xuICAgIGRzdFtpICsgb2Zmc2V0XSA9IHNyY1tpXVxuICB9XG4gIHJldHVybiBpXG59XG5cbmZ1bmN0aW9uIGRlY29kZVV0ZjhDaGFyIChzdHIpIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gZGVjb2RlVVJJQ29tcG9uZW50KHN0cilcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcmV0dXJuIFN0cmluZy5mcm9tQ2hhckNvZGUoMHhGRkZEKSAvLyBVVEYgOCBpbnZhbGlkIGNoYXJcbiAgfVxufVxuIiwidmFyIGxvb2t1cCA9ICdBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWmFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OSsvJztcblxuOyhmdW5jdGlvbiAoZXhwb3J0cykge1xuXHQndXNlIHN0cmljdCc7XG5cbiAgdmFyIEFyciA9ICh0eXBlb2YgVWludDhBcnJheSAhPT0gJ3VuZGVmaW5lZCcpXG4gICAgPyBVaW50OEFycmF5XG4gICAgOiBBcnJheVxuXG5cdHZhciBQTFVTICAgPSAnKycuY2hhckNvZGVBdCgwKVxuXHR2YXIgU0xBU0ggID0gJy8nLmNoYXJDb2RlQXQoMClcblx0dmFyIE5VTUJFUiA9ICcwJy5jaGFyQ29kZUF0KDApXG5cdHZhciBMT1dFUiAgPSAnYScuY2hhckNvZGVBdCgwKVxuXHR2YXIgVVBQRVIgID0gJ0EnLmNoYXJDb2RlQXQoMClcblxuXHRmdW5jdGlvbiBkZWNvZGUgKGVsdCkge1xuXHRcdHZhciBjb2RlID0gZWx0LmNoYXJDb2RlQXQoMClcblx0XHRpZiAoY29kZSA9PT0gUExVUylcblx0XHRcdHJldHVybiA2MiAvLyAnKydcblx0XHRpZiAoY29kZSA9PT0gU0xBU0gpXG5cdFx0XHRyZXR1cm4gNjMgLy8gJy8nXG5cdFx0aWYgKGNvZGUgPCBOVU1CRVIpXG5cdFx0XHRyZXR1cm4gLTEgLy9ubyBtYXRjaFxuXHRcdGlmIChjb2RlIDwgTlVNQkVSICsgMTApXG5cdFx0XHRyZXR1cm4gY29kZSAtIE5VTUJFUiArIDI2ICsgMjZcblx0XHRpZiAoY29kZSA8IFVQUEVSICsgMjYpXG5cdFx0XHRyZXR1cm4gY29kZSAtIFVQUEVSXG5cdFx0aWYgKGNvZGUgPCBMT1dFUiArIDI2KVxuXHRcdFx0cmV0dXJuIGNvZGUgLSBMT1dFUiArIDI2XG5cdH1cblxuXHRmdW5jdGlvbiBiNjRUb0J5dGVBcnJheSAoYjY0KSB7XG5cdFx0dmFyIGksIGosIGwsIHRtcCwgcGxhY2VIb2xkZXJzLCBhcnJcblxuXHRcdGlmIChiNjQubGVuZ3RoICUgNCA+IDApIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcignSW52YWxpZCBzdHJpbmcuIExlbmd0aCBtdXN0IGJlIGEgbXVsdGlwbGUgb2YgNCcpXG5cdFx0fVxuXG5cdFx0Ly8gdGhlIG51bWJlciBvZiBlcXVhbCBzaWducyAocGxhY2UgaG9sZGVycylcblx0XHQvLyBpZiB0aGVyZSBhcmUgdHdvIHBsYWNlaG9sZGVycywgdGhhbiB0aGUgdHdvIGNoYXJhY3RlcnMgYmVmb3JlIGl0XG5cdFx0Ly8gcmVwcmVzZW50IG9uZSBieXRlXG5cdFx0Ly8gaWYgdGhlcmUgaXMgb25seSBvbmUsIHRoZW4gdGhlIHRocmVlIGNoYXJhY3RlcnMgYmVmb3JlIGl0IHJlcHJlc2VudCAyIGJ5dGVzXG5cdFx0Ly8gdGhpcyBpcyBqdXN0IGEgY2hlYXAgaGFjayB0byBub3QgZG8gaW5kZXhPZiB0d2ljZVxuXHRcdHZhciBsZW4gPSBiNjQubGVuZ3RoXG5cdFx0cGxhY2VIb2xkZXJzID0gJz0nID09PSBiNjQuY2hhckF0KGxlbiAtIDIpID8gMiA6ICc9JyA9PT0gYjY0LmNoYXJBdChsZW4gLSAxKSA/IDEgOiAwXG5cblx0XHQvLyBiYXNlNjQgaXMgNC8zICsgdXAgdG8gdHdvIGNoYXJhY3RlcnMgb2YgdGhlIG9yaWdpbmFsIGRhdGFcblx0XHRhcnIgPSBuZXcgQXJyKGI2NC5sZW5ndGggKiAzIC8gNCAtIHBsYWNlSG9sZGVycylcblxuXHRcdC8vIGlmIHRoZXJlIGFyZSBwbGFjZWhvbGRlcnMsIG9ubHkgZ2V0IHVwIHRvIHRoZSBsYXN0IGNvbXBsZXRlIDQgY2hhcnNcblx0XHRsID0gcGxhY2VIb2xkZXJzID4gMCA/IGI2NC5sZW5ndGggLSA0IDogYjY0Lmxlbmd0aFxuXG5cdFx0dmFyIEwgPSAwXG5cblx0XHRmdW5jdGlvbiBwdXNoICh2KSB7XG5cdFx0XHRhcnJbTCsrXSA9IHZcblx0XHR9XG5cblx0XHRmb3IgKGkgPSAwLCBqID0gMDsgaSA8IGw7IGkgKz0gNCwgaiArPSAzKSB7XG5cdFx0XHR0bXAgPSAoZGVjb2RlKGI2NC5jaGFyQXQoaSkpIDw8IDE4KSB8IChkZWNvZGUoYjY0LmNoYXJBdChpICsgMSkpIDw8IDEyKSB8IChkZWNvZGUoYjY0LmNoYXJBdChpICsgMikpIDw8IDYpIHwgZGVjb2RlKGI2NC5jaGFyQXQoaSArIDMpKVxuXHRcdFx0cHVzaCgodG1wICYgMHhGRjAwMDApID4+IDE2KVxuXHRcdFx0cHVzaCgodG1wICYgMHhGRjAwKSA+PiA4KVxuXHRcdFx0cHVzaCh0bXAgJiAweEZGKVxuXHRcdH1cblxuXHRcdGlmIChwbGFjZUhvbGRlcnMgPT09IDIpIHtcblx0XHRcdHRtcCA9IChkZWNvZGUoYjY0LmNoYXJBdChpKSkgPDwgMikgfCAoZGVjb2RlKGI2NC5jaGFyQXQoaSArIDEpKSA+PiA0KVxuXHRcdFx0cHVzaCh0bXAgJiAweEZGKVxuXHRcdH0gZWxzZSBpZiAocGxhY2VIb2xkZXJzID09PSAxKSB7XG5cdFx0XHR0bXAgPSAoZGVjb2RlKGI2NC5jaGFyQXQoaSkpIDw8IDEwKSB8IChkZWNvZGUoYjY0LmNoYXJBdChpICsgMSkpIDw8IDQpIHwgKGRlY29kZShiNjQuY2hhckF0KGkgKyAyKSkgPj4gMilcblx0XHRcdHB1c2goKHRtcCA+PiA4KSAmIDB4RkYpXG5cdFx0XHRwdXNoKHRtcCAmIDB4RkYpXG5cdFx0fVxuXG5cdFx0cmV0dXJuIGFyclxuXHR9XG5cblx0ZnVuY3Rpb24gdWludDhUb0Jhc2U2NCAodWludDgpIHtcblx0XHR2YXIgaSxcblx0XHRcdGV4dHJhQnl0ZXMgPSB1aW50OC5sZW5ndGggJSAzLCAvLyBpZiB3ZSBoYXZlIDEgYnl0ZSBsZWZ0LCBwYWQgMiBieXRlc1xuXHRcdFx0b3V0cHV0ID0gXCJcIixcblx0XHRcdHRlbXAsIGxlbmd0aFxuXG5cdFx0ZnVuY3Rpb24gZW5jb2RlIChudW0pIHtcblx0XHRcdHJldHVybiBsb29rdXAuY2hhckF0KG51bSlcblx0XHR9XG5cblx0XHRmdW5jdGlvbiB0cmlwbGV0VG9CYXNlNjQgKG51bSkge1xuXHRcdFx0cmV0dXJuIGVuY29kZShudW0gPj4gMTggJiAweDNGKSArIGVuY29kZShudW0gPj4gMTIgJiAweDNGKSArIGVuY29kZShudW0gPj4gNiAmIDB4M0YpICsgZW5jb2RlKG51bSAmIDB4M0YpXG5cdFx0fVxuXG5cdFx0Ly8gZ28gdGhyb3VnaCB0aGUgYXJyYXkgZXZlcnkgdGhyZWUgYnl0ZXMsIHdlJ2xsIGRlYWwgd2l0aCB0cmFpbGluZyBzdHVmZiBsYXRlclxuXHRcdGZvciAoaSA9IDAsIGxlbmd0aCA9IHVpbnQ4Lmxlbmd0aCAtIGV4dHJhQnl0ZXM7IGkgPCBsZW5ndGg7IGkgKz0gMykge1xuXHRcdFx0dGVtcCA9ICh1aW50OFtpXSA8PCAxNikgKyAodWludDhbaSArIDFdIDw8IDgpICsgKHVpbnQ4W2kgKyAyXSlcblx0XHRcdG91dHB1dCArPSB0cmlwbGV0VG9CYXNlNjQodGVtcClcblx0XHR9XG5cblx0XHQvLyBwYWQgdGhlIGVuZCB3aXRoIHplcm9zLCBidXQgbWFrZSBzdXJlIHRvIG5vdCBmb3JnZXQgdGhlIGV4dHJhIGJ5dGVzXG5cdFx0c3dpdGNoIChleHRyYUJ5dGVzKSB7XG5cdFx0XHRjYXNlIDE6XG5cdFx0XHRcdHRlbXAgPSB1aW50OFt1aW50OC5sZW5ndGggLSAxXVxuXHRcdFx0XHRvdXRwdXQgKz0gZW5jb2RlKHRlbXAgPj4gMilcblx0XHRcdFx0b3V0cHV0ICs9IGVuY29kZSgodGVtcCA8PCA0KSAmIDB4M0YpXG5cdFx0XHRcdG91dHB1dCArPSAnPT0nXG5cdFx0XHRcdGJyZWFrXG5cdFx0XHRjYXNlIDI6XG5cdFx0XHRcdHRlbXAgPSAodWludDhbdWludDgubGVuZ3RoIC0gMl0gPDwgOCkgKyAodWludDhbdWludDgubGVuZ3RoIC0gMV0pXG5cdFx0XHRcdG91dHB1dCArPSBlbmNvZGUodGVtcCA+PiAxMClcblx0XHRcdFx0b3V0cHV0ICs9IGVuY29kZSgodGVtcCA+PiA0KSAmIDB4M0YpXG5cdFx0XHRcdG91dHB1dCArPSBlbmNvZGUoKHRlbXAgPDwgMikgJiAweDNGKVxuXHRcdFx0XHRvdXRwdXQgKz0gJz0nXG5cdFx0XHRcdGJyZWFrXG5cdFx0fVxuXG5cdFx0cmV0dXJuIG91dHB1dFxuXHR9XG5cblx0ZXhwb3J0cy50b0J5dGVBcnJheSA9IGI2NFRvQnl0ZUFycmF5XG5cdGV4cG9ydHMuZnJvbUJ5dGVBcnJheSA9IHVpbnQ4VG9CYXNlNjRcbn0odHlwZW9mIGV4cG9ydHMgPT09ICd1bmRlZmluZWQnID8gKHRoaXMuYmFzZTY0anMgPSB7fSkgOiBleHBvcnRzKSlcbiIsImV4cG9ydHMucmVhZCA9IGZ1bmN0aW9uKGJ1ZmZlciwgb2Zmc2V0LCBpc0xFLCBtTGVuLCBuQnl0ZXMpIHtcbiAgdmFyIGUsIG0sXG4gICAgICBlTGVuID0gbkJ5dGVzICogOCAtIG1MZW4gLSAxLFxuICAgICAgZU1heCA9ICgxIDw8IGVMZW4pIC0gMSxcbiAgICAgIGVCaWFzID0gZU1heCA+PiAxLFxuICAgICAgbkJpdHMgPSAtNyxcbiAgICAgIGkgPSBpc0xFID8gKG5CeXRlcyAtIDEpIDogMCxcbiAgICAgIGQgPSBpc0xFID8gLTEgOiAxLFxuICAgICAgcyA9IGJ1ZmZlcltvZmZzZXQgKyBpXTtcblxuICBpICs9IGQ7XG5cbiAgZSA9IHMgJiAoKDEgPDwgKC1uQml0cykpIC0gMSk7XG4gIHMgPj49ICgtbkJpdHMpO1xuICBuQml0cyArPSBlTGVuO1xuICBmb3IgKDsgbkJpdHMgPiAwOyBlID0gZSAqIDI1NiArIGJ1ZmZlcltvZmZzZXQgKyBpXSwgaSArPSBkLCBuQml0cyAtPSA4KTtcblxuICBtID0gZSAmICgoMSA8PCAoLW5CaXRzKSkgLSAxKTtcbiAgZSA+Pj0gKC1uQml0cyk7XG4gIG5CaXRzICs9IG1MZW47XG4gIGZvciAoOyBuQml0cyA+IDA7IG0gPSBtICogMjU2ICsgYnVmZmVyW29mZnNldCArIGldLCBpICs9IGQsIG5CaXRzIC09IDgpO1xuXG4gIGlmIChlID09PSAwKSB7XG4gICAgZSA9IDEgLSBlQmlhcztcbiAgfSBlbHNlIGlmIChlID09PSBlTWF4KSB7XG4gICAgcmV0dXJuIG0gPyBOYU4gOiAoKHMgPyAtMSA6IDEpICogSW5maW5pdHkpO1xuICB9IGVsc2Uge1xuICAgIG0gPSBtICsgTWF0aC5wb3coMiwgbUxlbik7XG4gICAgZSA9IGUgLSBlQmlhcztcbiAgfVxuICByZXR1cm4gKHMgPyAtMSA6IDEpICogbSAqIE1hdGgucG93KDIsIGUgLSBtTGVuKTtcbn07XG5cbmV4cG9ydHMud3JpdGUgPSBmdW5jdGlvbihidWZmZXIsIHZhbHVlLCBvZmZzZXQsIGlzTEUsIG1MZW4sIG5CeXRlcykge1xuICB2YXIgZSwgbSwgYyxcbiAgICAgIGVMZW4gPSBuQnl0ZXMgKiA4IC0gbUxlbiAtIDEsXG4gICAgICBlTWF4ID0gKDEgPDwgZUxlbikgLSAxLFxuICAgICAgZUJpYXMgPSBlTWF4ID4+IDEsXG4gICAgICBydCA9IChtTGVuID09PSAyMyA/IE1hdGgucG93KDIsIC0yNCkgLSBNYXRoLnBvdygyLCAtNzcpIDogMCksXG4gICAgICBpID0gaXNMRSA/IDAgOiAobkJ5dGVzIC0gMSksXG4gICAgICBkID0gaXNMRSA/IDEgOiAtMSxcbiAgICAgIHMgPSB2YWx1ZSA8IDAgfHwgKHZhbHVlID09PSAwICYmIDEgLyB2YWx1ZSA8IDApID8gMSA6IDA7XG5cbiAgdmFsdWUgPSBNYXRoLmFicyh2YWx1ZSk7XG5cbiAgaWYgKGlzTmFOKHZhbHVlKSB8fCB2YWx1ZSA9PT0gSW5maW5pdHkpIHtcbiAgICBtID0gaXNOYU4odmFsdWUpID8gMSA6IDA7XG4gICAgZSA9IGVNYXg7XG4gIH0gZWxzZSB7XG4gICAgZSA9IE1hdGguZmxvb3IoTWF0aC5sb2codmFsdWUpIC8gTWF0aC5MTjIpO1xuICAgIGlmICh2YWx1ZSAqIChjID0gTWF0aC5wb3coMiwgLWUpKSA8IDEpIHtcbiAgICAgIGUtLTtcbiAgICAgIGMgKj0gMjtcbiAgICB9XG4gICAgaWYgKGUgKyBlQmlhcyA+PSAxKSB7XG4gICAgICB2YWx1ZSArPSBydCAvIGM7XG4gICAgfSBlbHNlIHtcbiAgICAgIHZhbHVlICs9IHJ0ICogTWF0aC5wb3coMiwgMSAtIGVCaWFzKTtcbiAgICB9XG4gICAgaWYgKHZhbHVlICogYyA+PSAyKSB7XG4gICAgICBlKys7XG4gICAgICBjIC89IDI7XG4gICAgfVxuXG4gICAgaWYgKGUgKyBlQmlhcyA+PSBlTWF4KSB7XG4gICAgICBtID0gMDtcbiAgICAgIGUgPSBlTWF4O1xuICAgIH0gZWxzZSBpZiAoZSArIGVCaWFzID49IDEpIHtcbiAgICAgIG0gPSAodmFsdWUgKiBjIC0gMSkgKiBNYXRoLnBvdygyLCBtTGVuKTtcbiAgICAgIGUgPSBlICsgZUJpYXM7XG4gICAgfSBlbHNlIHtcbiAgICAgIG0gPSB2YWx1ZSAqIE1hdGgucG93KDIsIGVCaWFzIC0gMSkgKiBNYXRoLnBvdygyLCBtTGVuKTtcbiAgICAgIGUgPSAwO1xuICAgIH1cbiAgfVxuXG4gIGZvciAoOyBtTGVuID49IDg7IGJ1ZmZlcltvZmZzZXQgKyBpXSA9IG0gJiAweGZmLCBpICs9IGQsIG0gLz0gMjU2LCBtTGVuIC09IDgpO1xuXG4gIGUgPSAoZSA8PCBtTGVuKSB8IG07XG4gIGVMZW4gKz0gbUxlbjtcbiAgZm9yICg7IGVMZW4gPiAwOyBidWZmZXJbb2Zmc2V0ICsgaV0gPSBlICYgMHhmZiwgaSArPSBkLCBlIC89IDI1NiwgZUxlbiAtPSA4KTtcblxuICBidWZmZXJbb2Zmc2V0ICsgaSAtIGRdIHw9IHMgKiAxMjg7XG59O1xuIiwiXG4vKipcbiAqIGlzQXJyYXlcbiAqL1xuXG52YXIgaXNBcnJheSA9IEFycmF5LmlzQXJyYXk7XG5cbi8qKlxuICogdG9TdHJpbmdcbiAqL1xuXG52YXIgc3RyID0gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZztcblxuLyoqXG4gKiBXaGV0aGVyIG9yIG5vdCB0aGUgZ2l2ZW4gYHZhbGBcbiAqIGlzIGFuIGFycmF5LlxuICpcbiAqIGV4YW1wbGU6XG4gKlxuICogICAgICAgIGlzQXJyYXkoW10pO1xuICogICAgICAgIC8vID4gdHJ1ZVxuICogICAgICAgIGlzQXJyYXkoYXJndW1lbnRzKTtcbiAqICAgICAgICAvLyA+IGZhbHNlXG4gKiAgICAgICAgaXNBcnJheSgnJyk7XG4gKiAgICAgICAgLy8gPiBmYWxzZVxuICpcbiAqIEBwYXJhbSB7bWl4ZWR9IHZhbFxuICogQHJldHVybiB7Ym9vbH1cbiAqL1xuXG5tb2R1bGUuZXhwb3J0cyA9IGlzQXJyYXkgfHwgZnVuY3Rpb24gKHZhbCkge1xuICByZXR1cm4gISEgdmFsICYmICdbb2JqZWN0IEFycmF5XScgPT0gc3RyLmNhbGwodmFsKTtcbn07XG4iLCIvLyBDb3B5cmlnaHQgSm95ZW50LCBJbmMuIGFuZCBvdGhlciBOb2RlIGNvbnRyaWJ1dG9ycy5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYVxuLy8gY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZVxuLy8gXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nXG4vLyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsXG4vLyBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0XG4vLyBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGVcbi8vIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkXG4vLyBpbiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTXG4vLyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GXG4vLyBNRVJDSEFOVEFCSUxJVFksIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOXG4vLyBOTyBFVkVOVCBTSEFMTCBUSEUgQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSxcbi8vIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUlxuLy8gT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRVxuLy8gVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxuZnVuY3Rpb24gRXZlbnRFbWl0dGVyKCkge1xuICB0aGlzLl9ldmVudHMgPSB0aGlzLl9ldmVudHMgfHwge307XG4gIHRoaXMuX21heExpc3RlbmVycyA9IHRoaXMuX21heExpc3RlbmVycyB8fCB1bmRlZmluZWQ7XG59XG5tb2R1bGUuZXhwb3J0cyA9IEV2ZW50RW1pdHRlcjtcblxuLy8gQmFja3dhcmRzLWNvbXBhdCB3aXRoIG5vZGUgMC4xMC54XG5FdmVudEVtaXR0ZXIuRXZlbnRFbWl0dGVyID0gRXZlbnRFbWl0dGVyO1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLl9ldmVudHMgPSB1bmRlZmluZWQ7XG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLl9tYXhMaXN0ZW5lcnMgPSB1bmRlZmluZWQ7XG5cbi8vIEJ5IGRlZmF1bHQgRXZlbnRFbWl0dGVycyB3aWxsIHByaW50IGEgd2FybmluZyBpZiBtb3JlIHRoYW4gMTAgbGlzdGVuZXJzIGFyZVxuLy8gYWRkZWQgdG8gaXQuIFRoaXMgaXMgYSB1c2VmdWwgZGVmYXVsdCB3aGljaCBoZWxwcyBmaW5kaW5nIG1lbW9yeSBsZWFrcy5cbkV2ZW50RW1pdHRlci5kZWZhdWx0TWF4TGlzdGVuZXJzID0gMTA7XG5cbi8vIE9idmlvdXNseSBub3QgYWxsIEVtaXR0ZXJzIHNob3VsZCBiZSBsaW1pdGVkIHRvIDEwLiBUaGlzIGZ1bmN0aW9uIGFsbG93c1xuLy8gdGhhdCB0byBiZSBpbmNyZWFzZWQuIFNldCB0byB6ZXJvIGZvciB1bmxpbWl0ZWQuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLnNldE1heExpc3RlbmVycyA9IGZ1bmN0aW9uKG4pIHtcbiAgaWYgKCFpc051bWJlcihuKSB8fCBuIDwgMCB8fCBpc05hTihuKSlcbiAgICB0aHJvdyBUeXBlRXJyb3IoJ24gbXVzdCBiZSBhIHBvc2l0aXZlIG51bWJlcicpO1xuICB0aGlzLl9tYXhMaXN0ZW5lcnMgPSBuO1xuICByZXR1cm4gdGhpcztcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuZW1pdCA9IGZ1bmN0aW9uKHR5cGUpIHtcbiAgdmFyIGVyLCBoYW5kbGVyLCBsZW4sIGFyZ3MsIGksIGxpc3RlbmVycztcblxuICBpZiAoIXRoaXMuX2V2ZW50cylcbiAgICB0aGlzLl9ldmVudHMgPSB7fTtcblxuICAvLyBJZiB0aGVyZSBpcyBubyAnZXJyb3InIGV2ZW50IGxpc3RlbmVyIHRoZW4gdGhyb3cuXG4gIGlmICh0eXBlID09PSAnZXJyb3InKSB7XG4gICAgaWYgKCF0aGlzLl9ldmVudHMuZXJyb3IgfHxcbiAgICAgICAgKGlzT2JqZWN0KHRoaXMuX2V2ZW50cy5lcnJvcikgJiYgIXRoaXMuX2V2ZW50cy5lcnJvci5sZW5ndGgpKSB7XG4gICAgICBlciA9IGFyZ3VtZW50c1sxXTtcbiAgICAgIGlmIChlciBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgICAgIHRocm93IGVyOyAvLyBVbmhhbmRsZWQgJ2Vycm9yJyBldmVudFxuICAgICAgfVxuICAgICAgdGhyb3cgVHlwZUVycm9yKCdVbmNhdWdodCwgdW5zcGVjaWZpZWQgXCJlcnJvclwiIGV2ZW50LicpO1xuICAgIH1cbiAgfVxuXG4gIGhhbmRsZXIgPSB0aGlzLl9ldmVudHNbdHlwZV07XG5cbiAgaWYgKGlzVW5kZWZpbmVkKGhhbmRsZXIpKVxuICAgIHJldHVybiBmYWxzZTtcblxuICBpZiAoaXNGdW5jdGlvbihoYW5kbGVyKSkge1xuICAgIHN3aXRjaCAoYXJndW1lbnRzLmxlbmd0aCkge1xuICAgICAgLy8gZmFzdCBjYXNlc1xuICAgICAgY2FzZSAxOlxuICAgICAgICBoYW5kbGVyLmNhbGwodGhpcyk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAyOlxuICAgICAgICBoYW5kbGVyLmNhbGwodGhpcywgYXJndW1lbnRzWzFdKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDM6XG4gICAgICAgIGhhbmRsZXIuY2FsbCh0aGlzLCBhcmd1bWVudHNbMV0sIGFyZ3VtZW50c1syXSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgLy8gc2xvd2VyXG4gICAgICBkZWZhdWx0OlxuICAgICAgICBsZW4gPSBhcmd1bWVudHMubGVuZ3RoO1xuICAgICAgICBhcmdzID0gbmV3IEFycmF5KGxlbiAtIDEpO1xuICAgICAgICBmb3IgKGkgPSAxOyBpIDwgbGVuOyBpKyspXG4gICAgICAgICAgYXJnc1tpIC0gMV0gPSBhcmd1bWVudHNbaV07XG4gICAgICAgIGhhbmRsZXIuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxuICB9IGVsc2UgaWYgKGlzT2JqZWN0KGhhbmRsZXIpKSB7XG4gICAgbGVuID0gYXJndW1lbnRzLmxlbmd0aDtcbiAgICBhcmdzID0gbmV3IEFycmF5KGxlbiAtIDEpO1xuICAgIGZvciAoaSA9IDE7IGkgPCBsZW47IGkrKylcbiAgICAgIGFyZ3NbaSAtIDFdID0gYXJndW1lbnRzW2ldO1xuXG4gICAgbGlzdGVuZXJzID0gaGFuZGxlci5zbGljZSgpO1xuICAgIGxlbiA9IGxpc3RlbmVycy5sZW5ndGg7XG4gICAgZm9yIChpID0gMDsgaSA8IGxlbjsgaSsrKVxuICAgICAgbGlzdGVuZXJzW2ldLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICB9XG5cbiAgcmV0dXJuIHRydWU7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLmFkZExpc3RlbmVyID0gZnVuY3Rpb24odHlwZSwgbGlzdGVuZXIpIHtcbiAgdmFyIG07XG5cbiAgaWYgKCFpc0Z1bmN0aW9uKGxpc3RlbmVyKSlcbiAgICB0aHJvdyBUeXBlRXJyb3IoJ2xpc3RlbmVyIG11c3QgYmUgYSBmdW5jdGlvbicpO1xuXG4gIGlmICghdGhpcy5fZXZlbnRzKVxuICAgIHRoaXMuX2V2ZW50cyA9IHt9O1xuXG4gIC8vIFRvIGF2b2lkIHJlY3Vyc2lvbiBpbiB0aGUgY2FzZSB0aGF0IHR5cGUgPT09IFwibmV3TGlzdGVuZXJcIiEgQmVmb3JlXG4gIC8vIGFkZGluZyBpdCB0byB0aGUgbGlzdGVuZXJzLCBmaXJzdCBlbWl0IFwibmV3TGlzdGVuZXJcIi5cbiAgaWYgKHRoaXMuX2V2ZW50cy5uZXdMaXN0ZW5lcilcbiAgICB0aGlzLmVtaXQoJ25ld0xpc3RlbmVyJywgdHlwZSxcbiAgICAgICAgICAgICAgaXNGdW5jdGlvbihsaXN0ZW5lci5saXN0ZW5lcikgP1xuICAgICAgICAgICAgICBsaXN0ZW5lci5saXN0ZW5lciA6IGxpc3RlbmVyKTtcblxuICBpZiAoIXRoaXMuX2V2ZW50c1t0eXBlXSlcbiAgICAvLyBPcHRpbWl6ZSB0aGUgY2FzZSBvZiBvbmUgbGlzdGVuZXIuIERvbid0IG5lZWQgdGhlIGV4dHJhIGFycmF5IG9iamVjdC5cbiAgICB0aGlzLl9ldmVudHNbdHlwZV0gPSBsaXN0ZW5lcjtcbiAgZWxzZSBpZiAoaXNPYmplY3QodGhpcy5fZXZlbnRzW3R5cGVdKSlcbiAgICAvLyBJZiB3ZSd2ZSBhbHJlYWR5IGdvdCBhbiBhcnJheSwganVzdCBhcHBlbmQuXG4gICAgdGhpcy5fZXZlbnRzW3R5cGVdLnB1c2gobGlzdGVuZXIpO1xuICBlbHNlXG4gICAgLy8gQWRkaW5nIHRoZSBzZWNvbmQgZWxlbWVudCwgbmVlZCB0byBjaGFuZ2UgdG8gYXJyYXkuXG4gICAgdGhpcy5fZXZlbnRzW3R5cGVdID0gW3RoaXMuX2V2ZW50c1t0eXBlXSwgbGlzdGVuZXJdO1xuXG4gIC8vIENoZWNrIGZvciBsaXN0ZW5lciBsZWFrXG4gIGlmIChpc09iamVjdCh0aGlzLl9ldmVudHNbdHlwZV0pICYmICF0aGlzLl9ldmVudHNbdHlwZV0ud2FybmVkKSB7XG4gICAgdmFyIG07XG4gICAgaWYgKCFpc1VuZGVmaW5lZCh0aGlzLl9tYXhMaXN0ZW5lcnMpKSB7XG4gICAgICBtID0gdGhpcy5fbWF4TGlzdGVuZXJzO1xuICAgIH0gZWxzZSB7XG4gICAgICBtID0gRXZlbnRFbWl0dGVyLmRlZmF1bHRNYXhMaXN0ZW5lcnM7XG4gICAgfVxuXG4gICAgaWYgKG0gJiYgbSA+IDAgJiYgdGhpcy5fZXZlbnRzW3R5cGVdLmxlbmd0aCA+IG0pIHtcbiAgICAgIHRoaXMuX2V2ZW50c1t0eXBlXS53YXJuZWQgPSB0cnVlO1xuICAgICAgY29uc29sZS5lcnJvcignKG5vZGUpIHdhcm5pbmc6IHBvc3NpYmxlIEV2ZW50RW1pdHRlciBtZW1vcnkgJyArXG4gICAgICAgICAgICAgICAgICAgICdsZWFrIGRldGVjdGVkLiAlZCBsaXN0ZW5lcnMgYWRkZWQuICcgK1xuICAgICAgICAgICAgICAgICAgICAnVXNlIGVtaXR0ZXIuc2V0TWF4TGlzdGVuZXJzKCkgdG8gaW5jcmVhc2UgbGltaXQuJyxcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZXZlbnRzW3R5cGVdLmxlbmd0aCk7XG4gICAgICBpZiAodHlwZW9mIGNvbnNvbGUudHJhY2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgLy8gbm90IHN1cHBvcnRlZCBpbiBJRSAxMFxuICAgICAgICBjb25zb2xlLnRyYWNlKCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLm9uID0gRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5hZGRMaXN0ZW5lcjtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5vbmNlID0gZnVuY3Rpb24odHlwZSwgbGlzdGVuZXIpIHtcbiAgaWYgKCFpc0Z1bmN0aW9uKGxpc3RlbmVyKSlcbiAgICB0aHJvdyBUeXBlRXJyb3IoJ2xpc3RlbmVyIG11c3QgYmUgYSBmdW5jdGlvbicpO1xuXG4gIHZhciBmaXJlZCA9IGZhbHNlO1xuXG4gIGZ1bmN0aW9uIGcoKSB7XG4gICAgdGhpcy5yZW1vdmVMaXN0ZW5lcih0eXBlLCBnKTtcblxuICAgIGlmICghZmlyZWQpIHtcbiAgICAgIGZpcmVkID0gdHJ1ZTtcbiAgICAgIGxpc3RlbmVyLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfVxuICB9XG5cbiAgZy5saXN0ZW5lciA9IGxpc3RlbmVyO1xuICB0aGlzLm9uKHR5cGUsIGcpO1xuXG4gIHJldHVybiB0aGlzO1xufTtcblxuLy8gZW1pdHMgYSAncmVtb3ZlTGlzdGVuZXInIGV2ZW50IGlmZiB0aGUgbGlzdGVuZXIgd2FzIHJlbW92ZWRcbkV2ZW50RW1pdHRlci5wcm90b3R5cGUucmVtb3ZlTGlzdGVuZXIgPSBmdW5jdGlvbih0eXBlLCBsaXN0ZW5lcikge1xuICB2YXIgbGlzdCwgcG9zaXRpb24sIGxlbmd0aCwgaTtcblxuICBpZiAoIWlzRnVuY3Rpb24obGlzdGVuZXIpKVxuICAgIHRocm93IFR5cGVFcnJvcignbGlzdGVuZXIgbXVzdCBiZSBhIGZ1bmN0aW9uJyk7XG5cbiAgaWYgKCF0aGlzLl9ldmVudHMgfHwgIXRoaXMuX2V2ZW50c1t0eXBlXSlcbiAgICByZXR1cm4gdGhpcztcblxuICBsaXN0ID0gdGhpcy5fZXZlbnRzW3R5cGVdO1xuICBsZW5ndGggPSBsaXN0Lmxlbmd0aDtcbiAgcG9zaXRpb24gPSAtMTtcblxuICBpZiAobGlzdCA9PT0gbGlzdGVuZXIgfHxcbiAgICAgIChpc0Z1bmN0aW9uKGxpc3QubGlzdGVuZXIpICYmIGxpc3QubGlzdGVuZXIgPT09IGxpc3RlbmVyKSkge1xuICAgIGRlbGV0ZSB0aGlzLl9ldmVudHNbdHlwZV07XG4gICAgaWYgKHRoaXMuX2V2ZW50cy5yZW1vdmVMaXN0ZW5lcilcbiAgICAgIHRoaXMuZW1pdCgncmVtb3ZlTGlzdGVuZXInLCB0eXBlLCBsaXN0ZW5lcik7XG5cbiAgfSBlbHNlIGlmIChpc09iamVjdChsaXN0KSkge1xuICAgIGZvciAoaSA9IGxlbmd0aDsgaS0tID4gMDspIHtcbiAgICAgIGlmIChsaXN0W2ldID09PSBsaXN0ZW5lciB8fFxuICAgICAgICAgIChsaXN0W2ldLmxpc3RlbmVyICYmIGxpc3RbaV0ubGlzdGVuZXIgPT09IGxpc3RlbmVyKSkge1xuICAgICAgICBwb3NpdGlvbiA9IGk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChwb3NpdGlvbiA8IDApXG4gICAgICByZXR1cm4gdGhpcztcblxuICAgIGlmIChsaXN0Lmxlbmd0aCA9PT0gMSkge1xuICAgICAgbGlzdC5sZW5ndGggPSAwO1xuICAgICAgZGVsZXRlIHRoaXMuX2V2ZW50c1t0eXBlXTtcbiAgICB9IGVsc2Uge1xuICAgICAgbGlzdC5zcGxpY2UocG9zaXRpb24sIDEpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLl9ldmVudHMucmVtb3ZlTGlzdGVuZXIpXG4gICAgICB0aGlzLmVtaXQoJ3JlbW92ZUxpc3RlbmVyJywgdHlwZSwgbGlzdGVuZXIpO1xuICB9XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLnJlbW92ZUFsbExpc3RlbmVycyA9IGZ1bmN0aW9uKHR5cGUpIHtcbiAgdmFyIGtleSwgbGlzdGVuZXJzO1xuXG4gIGlmICghdGhpcy5fZXZlbnRzKVxuICAgIHJldHVybiB0aGlzO1xuXG4gIC8vIG5vdCBsaXN0ZW5pbmcgZm9yIHJlbW92ZUxpc3RlbmVyLCBubyBuZWVkIHRvIGVtaXRcbiAgaWYgKCF0aGlzLl9ldmVudHMucmVtb3ZlTGlzdGVuZXIpIHtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMClcbiAgICAgIHRoaXMuX2V2ZW50cyA9IHt9O1xuICAgIGVsc2UgaWYgKHRoaXMuX2V2ZW50c1t0eXBlXSlcbiAgICAgIGRlbGV0ZSB0aGlzLl9ldmVudHNbdHlwZV07XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvLyBlbWl0IHJlbW92ZUxpc3RlbmVyIGZvciBhbGwgbGlzdGVuZXJzIG9uIGFsbCBldmVudHNcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDApIHtcbiAgICBmb3IgKGtleSBpbiB0aGlzLl9ldmVudHMpIHtcbiAgICAgIGlmIChrZXkgPT09ICdyZW1vdmVMaXN0ZW5lcicpIGNvbnRpbnVlO1xuICAgICAgdGhpcy5yZW1vdmVBbGxMaXN0ZW5lcnMoa2V5KTtcbiAgICB9XG4gICAgdGhpcy5yZW1vdmVBbGxMaXN0ZW5lcnMoJ3JlbW92ZUxpc3RlbmVyJyk7XG4gICAgdGhpcy5fZXZlbnRzID0ge307XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBsaXN0ZW5lcnMgPSB0aGlzLl9ldmVudHNbdHlwZV07XG5cbiAgaWYgKGlzRnVuY3Rpb24obGlzdGVuZXJzKSkge1xuICAgIHRoaXMucmVtb3ZlTGlzdGVuZXIodHlwZSwgbGlzdGVuZXJzKTtcbiAgfSBlbHNlIHtcbiAgICAvLyBMSUZPIG9yZGVyXG4gICAgd2hpbGUgKGxpc3RlbmVycy5sZW5ndGgpXG4gICAgICB0aGlzLnJlbW92ZUxpc3RlbmVyKHR5cGUsIGxpc3RlbmVyc1tsaXN0ZW5lcnMubGVuZ3RoIC0gMV0pO1xuICB9XG4gIGRlbGV0ZSB0aGlzLl9ldmVudHNbdHlwZV07XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLmxpc3RlbmVycyA9IGZ1bmN0aW9uKHR5cGUpIHtcbiAgdmFyIHJldDtcbiAgaWYgKCF0aGlzLl9ldmVudHMgfHwgIXRoaXMuX2V2ZW50c1t0eXBlXSlcbiAgICByZXQgPSBbXTtcbiAgZWxzZSBpZiAoaXNGdW5jdGlvbih0aGlzLl9ldmVudHNbdHlwZV0pKVxuICAgIHJldCA9IFt0aGlzLl9ldmVudHNbdHlwZV1dO1xuICBlbHNlXG4gICAgcmV0ID0gdGhpcy5fZXZlbnRzW3R5cGVdLnNsaWNlKCk7XG4gIHJldHVybiByZXQ7XG59O1xuXG5FdmVudEVtaXR0ZXIubGlzdGVuZXJDb3VudCA9IGZ1bmN0aW9uKGVtaXR0ZXIsIHR5cGUpIHtcbiAgdmFyIHJldDtcbiAgaWYgKCFlbWl0dGVyLl9ldmVudHMgfHwgIWVtaXR0ZXIuX2V2ZW50c1t0eXBlXSlcbiAgICByZXQgPSAwO1xuICBlbHNlIGlmIChpc0Z1bmN0aW9uKGVtaXR0ZXIuX2V2ZW50c1t0eXBlXSkpXG4gICAgcmV0ID0gMTtcbiAgZWxzZVxuICAgIHJldCA9IGVtaXR0ZXIuX2V2ZW50c1t0eXBlXS5sZW5ndGg7XG4gIHJldHVybiByZXQ7XG59O1xuXG5mdW5jdGlvbiBpc0Z1bmN0aW9uKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ2Z1bmN0aW9uJztcbn1cblxuZnVuY3Rpb24gaXNOdW1iZXIoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnbnVtYmVyJztcbn1cblxuZnVuY3Rpb24gaXNPYmplY3QoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBhcmcgIT09IG51bGw7XG59XG5cbmZ1bmN0aW9uIGlzVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gYXJnID09PSB2b2lkIDA7XG59XG4iLCJtb2R1bGUuZXhwb3J0cyA9IEFycmF5LmlzQXJyYXkgfHwgZnVuY3Rpb24gKGFycikge1xuICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKGFycikgPT0gJ1tvYmplY3QgQXJyYXldJztcbn07XG4iLCIvLyBzaGltIGZvciB1c2luZyBwcm9jZXNzIGluIGJyb3dzZXJcblxudmFyIHByb2Nlc3MgPSBtb2R1bGUuZXhwb3J0cyA9IHt9O1xuXG5wcm9jZXNzLm5leHRUaWNrID0gKGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgY2FuU2V0SW1tZWRpYXRlID0gdHlwZW9mIHdpbmRvdyAhPT0gJ3VuZGVmaW5lZCdcbiAgICAmJiB3aW5kb3cuc2V0SW1tZWRpYXRlO1xuICAgIHZhciBjYW5NdXRhdGlvbk9ic2VydmVyID0gdHlwZW9mIHdpbmRvdyAhPT0gJ3VuZGVmaW5lZCdcbiAgICAmJiB3aW5kb3cuTXV0YXRpb25PYnNlcnZlcjtcbiAgICB2YXIgY2FuUG9zdCA9IHR5cGVvZiB3aW5kb3cgIT09ICd1bmRlZmluZWQnXG4gICAgJiYgd2luZG93LnBvc3RNZXNzYWdlICYmIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyXG4gICAgO1xuXG4gICAgaWYgKGNhblNldEltbWVkaWF0ZSkge1xuICAgICAgICByZXR1cm4gZnVuY3Rpb24gKGYpIHsgcmV0dXJuIHdpbmRvdy5zZXRJbW1lZGlhdGUoZikgfTtcbiAgICB9XG5cbiAgICB2YXIgcXVldWUgPSBbXTtcblxuICAgIGlmIChjYW5NdXRhdGlvbk9ic2VydmVyKSB7XG4gICAgICAgIHZhciBoaWRkZW5EaXYgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICB2YXIgb2JzZXJ2ZXIgPSBuZXcgTXV0YXRpb25PYnNlcnZlcihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB2YXIgcXVldWVMaXN0ID0gcXVldWUuc2xpY2UoKTtcbiAgICAgICAgICAgIHF1ZXVlLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICBxdWV1ZUxpc3QuZm9yRWFjaChmdW5jdGlvbiAoZm4pIHtcbiAgICAgICAgICAgICAgICBmbigpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIG9ic2VydmVyLm9ic2VydmUoaGlkZGVuRGl2LCB7IGF0dHJpYnV0ZXM6IHRydWUgfSk7XG5cbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIG5leHRUaWNrKGZuKSB7XG4gICAgICAgICAgICBpZiAoIXF1ZXVlLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIGhpZGRlbkRpdi5zZXRBdHRyaWJ1dGUoJ3llcycsICdubycpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcXVldWUucHVzaChmbik7XG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgaWYgKGNhblBvc3QpIHtcbiAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ21lc3NhZ2UnLCBmdW5jdGlvbiAoZXYpIHtcbiAgICAgICAgICAgIHZhciBzb3VyY2UgPSBldi5zb3VyY2U7XG4gICAgICAgICAgICBpZiAoKHNvdXJjZSA9PT0gd2luZG93IHx8IHNvdXJjZSA9PT0gbnVsbCkgJiYgZXYuZGF0YSA9PT0gJ3Byb2Nlc3MtdGljaycpIHtcbiAgICAgICAgICAgICAgICBldi5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgICAgICAgICAgICBpZiAocXVldWUubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICB2YXIgZm4gPSBxdWV1ZS5zaGlmdCgpO1xuICAgICAgICAgICAgICAgICAgICBmbigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSwgdHJ1ZSk7XG5cbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIG5leHRUaWNrKGZuKSB7XG4gICAgICAgICAgICBxdWV1ZS5wdXNoKGZuKTtcbiAgICAgICAgICAgIHdpbmRvdy5wb3N0TWVzc2FnZSgncHJvY2Vzcy10aWNrJywgJyonKTtcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4gZnVuY3Rpb24gbmV4dFRpY2soZm4pIHtcbiAgICAgICAgc2V0VGltZW91dChmbiwgMCk7XG4gICAgfTtcbn0pKCk7XG5cbnByb2Nlc3MudGl0bGUgPSAnYnJvd3Nlcic7XG5wcm9jZXNzLmJyb3dzZXIgPSB0cnVlO1xucHJvY2Vzcy5lbnYgPSB7fTtcbnByb2Nlc3MuYXJndiA9IFtdO1xuXG5mdW5jdGlvbiBub29wKCkge31cblxucHJvY2Vzcy5vbiA9IG5vb3A7XG5wcm9jZXNzLmFkZExpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3Mub25jZSA9IG5vb3A7XG5wcm9jZXNzLm9mZiA9IG5vb3A7XG5wcm9jZXNzLnJlbW92ZUxpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlQWxsTGlzdGVuZXJzID0gbm9vcDtcbnByb2Nlc3MuZW1pdCA9IG5vb3A7XG5cbnByb2Nlc3MuYmluZGluZyA9IGZ1bmN0aW9uIChuYW1lKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwcm9jZXNzLmJpbmRpbmcgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcblxuLy8gVE9ETyhzaHR5bG1hbilcbnByb2Nlc3MuY3dkID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gJy8nIH07XG5wcm9jZXNzLmNoZGlyID0gZnVuY3Rpb24gKGRpcikge1xuICAgIHRocm93IG5ldyBFcnJvcigncHJvY2Vzcy5jaGRpciBpcyBub3Qgc3VwcG9ydGVkJyk7XG59O1xuIiwibW9kdWxlLmV4cG9ydHMgPSByZXF1aXJlKFwiLi9saWIvX3N0cmVhbV9kdXBsZXguanNcIilcbiIsIihmdW5jdGlvbiAocHJvY2Vzcyl7XG4vLyBDb3B5cmlnaHQgSm95ZW50LCBJbmMuIGFuZCBvdGhlciBOb2RlIGNvbnRyaWJ1dG9ycy5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYVxuLy8gY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZVxuLy8gXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nXG4vLyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsXG4vLyBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0XG4vLyBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGVcbi8vIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkXG4vLyBpbiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTXG4vLyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GXG4vLyBNRVJDSEFOVEFCSUxJVFksIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOXG4vLyBOTyBFVkVOVCBTSEFMTCBUSEUgQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSxcbi8vIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUlxuLy8gT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRVxuLy8gVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxuLy8gYSBkdXBsZXggc3RyZWFtIGlzIGp1c3QgYSBzdHJlYW0gdGhhdCBpcyBib3RoIHJlYWRhYmxlIGFuZCB3cml0YWJsZS5cbi8vIFNpbmNlIEpTIGRvZXNuJ3QgaGF2ZSBtdWx0aXBsZSBwcm90b3R5cGFsIGluaGVyaXRhbmNlLCB0aGlzIGNsYXNzXG4vLyBwcm90b3R5cGFsbHkgaW5oZXJpdHMgZnJvbSBSZWFkYWJsZSwgYW5kIHRoZW4gcGFyYXNpdGljYWxseSBmcm9tXG4vLyBXcml0YWJsZS5cblxubW9kdWxlLmV4cG9ydHMgPSBEdXBsZXg7XG5cbi8qPHJlcGxhY2VtZW50PiovXG52YXIgb2JqZWN0S2V5cyA9IE9iamVjdC5rZXlzIHx8IGZ1bmN0aW9uIChvYmopIHtcbiAgdmFyIGtleXMgPSBbXTtcbiAgZm9yICh2YXIga2V5IGluIG9iaikga2V5cy5wdXNoKGtleSk7XG4gIHJldHVybiBrZXlzO1xufVxuLyo8L3JlcGxhY2VtZW50PiovXG5cblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciB1dGlsID0gcmVxdWlyZSgnY29yZS11dGlsLWlzJyk7XG51dGlsLmluaGVyaXRzID0gcmVxdWlyZSgnaW5oZXJpdHMnKTtcbi8qPC9yZXBsYWNlbWVudD4qL1xuXG52YXIgUmVhZGFibGUgPSByZXF1aXJlKCcuL19zdHJlYW1fcmVhZGFibGUnKTtcbnZhciBXcml0YWJsZSA9IHJlcXVpcmUoJy4vX3N0cmVhbV93cml0YWJsZScpO1xuXG51dGlsLmluaGVyaXRzKER1cGxleCwgUmVhZGFibGUpO1xuXG5mb3JFYWNoKG9iamVjdEtleXMoV3JpdGFibGUucHJvdG90eXBlKSwgZnVuY3Rpb24obWV0aG9kKSB7XG4gIGlmICghRHVwbGV4LnByb3RvdHlwZVttZXRob2RdKVxuICAgIER1cGxleC5wcm90b3R5cGVbbWV0aG9kXSA9IFdyaXRhYmxlLnByb3RvdHlwZVttZXRob2RdO1xufSk7XG5cbmZ1bmN0aW9uIER1cGxleChvcHRpb25zKSB7XG4gIGlmICghKHRoaXMgaW5zdGFuY2VvZiBEdXBsZXgpKVxuICAgIHJldHVybiBuZXcgRHVwbGV4KG9wdGlvbnMpO1xuXG4gIFJlYWRhYmxlLmNhbGwodGhpcywgb3B0aW9ucyk7XG4gIFdyaXRhYmxlLmNhbGwodGhpcywgb3B0aW9ucyk7XG5cbiAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yZWFkYWJsZSA9PT0gZmFsc2UpXG4gICAgdGhpcy5yZWFkYWJsZSA9IGZhbHNlO1xuXG4gIGlmIChvcHRpb25zICYmIG9wdGlvbnMud3JpdGFibGUgPT09IGZhbHNlKVxuICAgIHRoaXMud3JpdGFibGUgPSBmYWxzZTtcblxuICB0aGlzLmFsbG93SGFsZk9wZW4gPSB0cnVlO1xuICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLmFsbG93SGFsZk9wZW4gPT09IGZhbHNlKVxuICAgIHRoaXMuYWxsb3dIYWxmT3BlbiA9IGZhbHNlO1xuXG4gIHRoaXMub25jZSgnZW5kJywgb25lbmQpO1xufVxuXG4vLyB0aGUgbm8taGFsZi1vcGVuIGVuZm9yY2VyXG5mdW5jdGlvbiBvbmVuZCgpIHtcbiAgLy8gaWYgd2UgYWxsb3cgaGFsZi1vcGVuIHN0YXRlLCBvciBpZiB0aGUgd3JpdGFibGUgc2lkZSBlbmRlZCxcbiAgLy8gdGhlbiB3ZSdyZSBvay5cbiAgaWYgKHRoaXMuYWxsb3dIYWxmT3BlbiB8fCB0aGlzLl93cml0YWJsZVN0YXRlLmVuZGVkKVxuICAgIHJldHVybjtcblxuICAvLyBubyBtb3JlIGRhdGEgY2FuIGJlIHdyaXR0ZW4uXG4gIC8vIEJ1dCBhbGxvdyBtb3JlIHdyaXRlcyB0byBoYXBwZW4gaW4gdGhpcyB0aWNrLlxuICBwcm9jZXNzLm5leHRUaWNrKHRoaXMuZW5kLmJpbmQodGhpcykpO1xufVxuXG5mdW5jdGlvbiBmb3JFYWNoICh4cywgZikge1xuICBmb3IgKHZhciBpID0gMCwgbCA9IHhzLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgIGYoeHNbaV0sIGkpO1xuICB9XG59XG5cbn0pLmNhbGwodGhpcyxyZXF1aXJlKCdfcHJvY2VzcycpKSIsIi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG4vLyBhIHBhc3N0aHJvdWdoIHN0cmVhbS5cbi8vIGJhc2ljYWxseSBqdXN0IHRoZSBtb3N0IG1pbmltYWwgc29ydCBvZiBUcmFuc2Zvcm0gc3RyZWFtLlxuLy8gRXZlcnkgd3JpdHRlbiBjaHVuayBnZXRzIG91dHB1dCBhcy1pcy5cblxubW9kdWxlLmV4cG9ydHMgPSBQYXNzVGhyb3VnaDtcblxudmFyIFRyYW5zZm9ybSA9IHJlcXVpcmUoJy4vX3N0cmVhbV90cmFuc2Zvcm0nKTtcblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciB1dGlsID0gcmVxdWlyZSgnY29yZS11dGlsLWlzJyk7XG51dGlsLmluaGVyaXRzID0gcmVxdWlyZSgnaW5oZXJpdHMnKTtcbi8qPC9yZXBsYWNlbWVudD4qL1xuXG51dGlsLmluaGVyaXRzKFBhc3NUaHJvdWdoLCBUcmFuc2Zvcm0pO1xuXG5mdW5jdGlvbiBQYXNzVGhyb3VnaChvcHRpb25zKSB7XG4gIGlmICghKHRoaXMgaW5zdGFuY2VvZiBQYXNzVGhyb3VnaCkpXG4gICAgcmV0dXJuIG5ldyBQYXNzVGhyb3VnaChvcHRpb25zKTtcblxuICBUcmFuc2Zvcm0uY2FsbCh0aGlzLCBvcHRpb25zKTtcbn1cblxuUGFzc1Rocm91Z2gucHJvdG90eXBlLl90cmFuc2Zvcm0gPSBmdW5jdGlvbihjaHVuaywgZW5jb2RpbmcsIGNiKSB7XG4gIGNiKG51bGwsIGNodW5rKTtcbn07XG4iLCIoZnVuY3Rpb24gKHByb2Nlc3Mpe1xuLy8gQ29weXJpZ2h0IEpveWVudCwgSW5jLiBhbmQgb3RoZXIgTm9kZSBjb250cmlidXRvcnMuXG4vL1xuLy8gUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGFcbi8vIGNvcHkgb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGVcbi8vIFwiU29mdHdhcmVcIiksIHRvIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZ1xuLy8gd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLFxuLy8gZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdFxuLy8gcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlXG4vLyBmb2xsb3dpbmcgY29uZGl0aW9uczpcbi8vXG4vLyBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZFxuLy8gaW4gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4vL1xuLy8gVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTU1xuLy8gT1IgSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRlxuLy8gTUVSQ0hBTlRBQklMSVRZLCBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTlxuLy8gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sXG4vLyBEQU1BR0VTIE9SIE9USEVSIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1Jcbi8vIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLCBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEVcbi8vIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuXG5cbm1vZHVsZS5leHBvcnRzID0gUmVhZGFibGU7XG5cbi8qPHJlcGxhY2VtZW50PiovXG52YXIgaXNBcnJheSA9IHJlcXVpcmUoJ2lzYXJyYXknKTtcbi8qPC9yZXBsYWNlbWVudD4qL1xuXG5cbi8qPHJlcGxhY2VtZW50PiovXG52YXIgQnVmZmVyID0gcmVxdWlyZSgnYnVmZmVyJykuQnVmZmVyO1xuLyo8L3JlcGxhY2VtZW50PiovXG5cblJlYWRhYmxlLlJlYWRhYmxlU3RhdGUgPSBSZWFkYWJsZVN0YXRlO1xuXG52YXIgRUUgPSByZXF1aXJlKCdldmVudHMnKS5FdmVudEVtaXR0ZXI7XG5cbi8qPHJlcGxhY2VtZW50PiovXG5pZiAoIUVFLmxpc3RlbmVyQ291bnQpIEVFLmxpc3RlbmVyQ291bnQgPSBmdW5jdGlvbihlbWl0dGVyLCB0eXBlKSB7XG4gIHJldHVybiBlbWl0dGVyLmxpc3RlbmVycyh0eXBlKS5sZW5ndGg7XG59O1xuLyo8L3JlcGxhY2VtZW50PiovXG5cbnZhciBTdHJlYW0gPSByZXF1aXJlKCdzdHJlYW0nKTtcblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciB1dGlsID0gcmVxdWlyZSgnY29yZS11dGlsLWlzJyk7XG51dGlsLmluaGVyaXRzID0gcmVxdWlyZSgnaW5oZXJpdHMnKTtcbi8qPC9yZXBsYWNlbWVudD4qL1xuXG52YXIgU3RyaW5nRGVjb2RlcjtcblxudXRpbC5pbmhlcml0cyhSZWFkYWJsZSwgU3RyZWFtKTtcblxuZnVuY3Rpb24gUmVhZGFibGVTdGF0ZShvcHRpb25zLCBzdHJlYW0pIHtcbiAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG5cbiAgLy8gdGhlIHBvaW50IGF0IHdoaWNoIGl0IHN0b3BzIGNhbGxpbmcgX3JlYWQoKSB0byBmaWxsIHRoZSBidWZmZXJcbiAgLy8gTm90ZTogMCBpcyBhIHZhbGlkIHZhbHVlLCBtZWFucyBcImRvbid0IGNhbGwgX3JlYWQgcHJlZW1wdGl2ZWx5IGV2ZXJcIlxuICB2YXIgaHdtID0gb3B0aW9ucy5oaWdoV2F0ZXJNYXJrO1xuICB0aGlzLmhpZ2hXYXRlck1hcmsgPSAoaHdtIHx8IGh3bSA9PT0gMCkgPyBod20gOiAxNiAqIDEwMjQ7XG5cbiAgLy8gY2FzdCB0byBpbnRzLlxuICB0aGlzLmhpZ2hXYXRlck1hcmsgPSB+fnRoaXMuaGlnaFdhdGVyTWFyaztcblxuICB0aGlzLmJ1ZmZlciA9IFtdO1xuICB0aGlzLmxlbmd0aCA9IDA7XG4gIHRoaXMucGlwZXMgPSBudWxsO1xuICB0aGlzLnBpcGVzQ291bnQgPSAwO1xuICB0aGlzLmZsb3dpbmcgPSBmYWxzZTtcbiAgdGhpcy5lbmRlZCA9IGZhbHNlO1xuICB0aGlzLmVuZEVtaXR0ZWQgPSBmYWxzZTtcbiAgdGhpcy5yZWFkaW5nID0gZmFsc2U7XG5cbiAgLy8gSW4gc3RyZWFtcyB0aGF0IG5ldmVyIGhhdmUgYW55IGRhdGEsIGFuZCBkbyBwdXNoKG51bGwpIHJpZ2h0IGF3YXksXG4gIC8vIHRoZSBjb25zdW1lciBjYW4gbWlzcyB0aGUgJ2VuZCcgZXZlbnQgaWYgdGhleSBkbyBzb21lIEkvTyBiZWZvcmVcbiAgLy8gY29uc3VtaW5nIHRoZSBzdHJlYW0uICBTbywgd2UgZG9uJ3QgZW1pdCgnZW5kJykgdW50aWwgc29tZSByZWFkaW5nXG4gIC8vIGhhcHBlbnMuXG4gIHRoaXMuY2FsbGVkUmVhZCA9IGZhbHNlO1xuXG4gIC8vIGEgZmxhZyB0byBiZSBhYmxlIHRvIHRlbGwgaWYgdGhlIG9ud3JpdGUgY2IgaXMgY2FsbGVkIGltbWVkaWF0ZWx5LFxuICAvLyBvciBvbiBhIGxhdGVyIHRpY2suICBXZSBzZXQgdGhpcyB0byB0cnVlIGF0IGZpcnN0LCBiZWN1YXNlIGFueVxuICAvLyBhY3Rpb25zIHRoYXQgc2hvdWxkbid0IGhhcHBlbiB1bnRpbCBcImxhdGVyXCIgc2hvdWxkIGdlbmVyYWxseSBhbHNvXG4gIC8vIG5vdCBoYXBwZW4gYmVmb3JlIHRoZSBmaXJzdCB3cml0ZSBjYWxsLlxuICB0aGlzLnN5bmMgPSB0cnVlO1xuXG4gIC8vIHdoZW5ldmVyIHdlIHJldHVybiBudWxsLCB0aGVuIHdlIHNldCBhIGZsYWcgdG8gc2F5XG4gIC8vIHRoYXQgd2UncmUgYXdhaXRpbmcgYSAncmVhZGFibGUnIGV2ZW50IGVtaXNzaW9uLlxuICB0aGlzLm5lZWRSZWFkYWJsZSA9IGZhbHNlO1xuICB0aGlzLmVtaXR0ZWRSZWFkYWJsZSA9IGZhbHNlO1xuICB0aGlzLnJlYWRhYmxlTGlzdGVuaW5nID0gZmFsc2U7XG5cblxuICAvLyBvYmplY3Qgc3RyZWFtIGZsYWcuIFVzZWQgdG8gbWFrZSByZWFkKG4pIGlnbm9yZSBuIGFuZCB0b1xuICAvLyBtYWtlIGFsbCB0aGUgYnVmZmVyIG1lcmdpbmcgYW5kIGxlbmd0aCBjaGVja3MgZ28gYXdheVxuICB0aGlzLm9iamVjdE1vZGUgPSAhIW9wdGlvbnMub2JqZWN0TW9kZTtcblxuICAvLyBDcnlwdG8gaXMga2luZCBvZiBvbGQgYW5kIGNydXN0eS4gIEhpc3RvcmljYWxseSwgaXRzIGRlZmF1bHQgc3RyaW5nXG4gIC8vIGVuY29kaW5nIGlzICdiaW5hcnknIHNvIHdlIGhhdmUgdG8gbWFrZSB0aGlzIGNvbmZpZ3VyYWJsZS5cbiAgLy8gRXZlcnl0aGluZyBlbHNlIGluIHRoZSB1bml2ZXJzZSB1c2VzICd1dGY4JywgdGhvdWdoLlxuICB0aGlzLmRlZmF1bHRFbmNvZGluZyA9IG9wdGlvbnMuZGVmYXVsdEVuY29kaW5nIHx8ICd1dGY4JztcblxuICAvLyB3aGVuIHBpcGluZywgd2Ugb25seSBjYXJlIGFib3V0ICdyZWFkYWJsZScgZXZlbnRzIHRoYXQgaGFwcGVuXG4gIC8vIGFmdGVyIHJlYWQoKWluZyBhbGwgdGhlIGJ5dGVzIGFuZCBub3QgZ2V0dGluZyBhbnkgcHVzaGJhY2suXG4gIHRoaXMucmFuT3V0ID0gZmFsc2U7XG5cbiAgLy8gdGhlIG51bWJlciBvZiB3cml0ZXJzIHRoYXQgYXJlIGF3YWl0aW5nIGEgZHJhaW4gZXZlbnQgaW4gLnBpcGUoKXNcbiAgdGhpcy5hd2FpdERyYWluID0gMDtcblxuICAvLyBpZiB0cnVlLCBhIG1heWJlUmVhZE1vcmUgaGFzIGJlZW4gc2NoZWR1bGVkXG4gIHRoaXMucmVhZGluZ01vcmUgPSBmYWxzZTtcblxuICB0aGlzLmRlY29kZXIgPSBudWxsO1xuICB0aGlzLmVuY29kaW5nID0gbnVsbDtcbiAgaWYgKG9wdGlvbnMuZW5jb2RpbmcpIHtcbiAgICBpZiAoIVN0cmluZ0RlY29kZXIpXG4gICAgICBTdHJpbmdEZWNvZGVyID0gcmVxdWlyZSgnc3RyaW5nX2RlY29kZXIvJykuU3RyaW5nRGVjb2RlcjtcbiAgICB0aGlzLmRlY29kZXIgPSBuZXcgU3RyaW5nRGVjb2RlcihvcHRpb25zLmVuY29kaW5nKTtcbiAgICB0aGlzLmVuY29kaW5nID0gb3B0aW9ucy5lbmNvZGluZztcbiAgfVxufVxuXG5mdW5jdGlvbiBSZWFkYWJsZShvcHRpb25zKSB7XG4gIGlmICghKHRoaXMgaW5zdGFuY2VvZiBSZWFkYWJsZSkpXG4gICAgcmV0dXJuIG5ldyBSZWFkYWJsZShvcHRpb25zKTtcblxuICB0aGlzLl9yZWFkYWJsZVN0YXRlID0gbmV3IFJlYWRhYmxlU3RhdGUob3B0aW9ucywgdGhpcyk7XG5cbiAgLy8gbGVnYWN5XG4gIHRoaXMucmVhZGFibGUgPSB0cnVlO1xuXG4gIFN0cmVhbS5jYWxsKHRoaXMpO1xufVxuXG4vLyBNYW51YWxseSBzaG92ZSBzb21ldGhpbmcgaW50byB0aGUgcmVhZCgpIGJ1ZmZlci5cbi8vIFRoaXMgcmV0dXJucyB0cnVlIGlmIHRoZSBoaWdoV2F0ZXJNYXJrIGhhcyBub3QgYmVlbiBoaXQgeWV0LFxuLy8gc2ltaWxhciB0byBob3cgV3JpdGFibGUud3JpdGUoKSByZXR1cm5zIHRydWUgaWYgeW91IHNob3VsZFxuLy8gd3JpdGUoKSBzb21lIG1vcmUuXG5SZWFkYWJsZS5wcm90b3R5cGUucHVzaCA9IGZ1bmN0aW9uKGNodW5rLCBlbmNvZGluZykge1xuICB2YXIgc3RhdGUgPSB0aGlzLl9yZWFkYWJsZVN0YXRlO1xuXG4gIGlmICh0eXBlb2YgY2h1bmsgPT09ICdzdHJpbmcnICYmICFzdGF0ZS5vYmplY3RNb2RlKSB7XG4gICAgZW5jb2RpbmcgPSBlbmNvZGluZyB8fCBzdGF0ZS5kZWZhdWx0RW5jb2Rpbmc7XG4gICAgaWYgKGVuY29kaW5nICE9PSBzdGF0ZS5lbmNvZGluZykge1xuICAgICAgY2h1bmsgPSBuZXcgQnVmZmVyKGNodW5rLCBlbmNvZGluZyk7XG4gICAgICBlbmNvZGluZyA9ICcnO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZWFkYWJsZUFkZENodW5rKHRoaXMsIHN0YXRlLCBjaHVuaywgZW5jb2RpbmcsIGZhbHNlKTtcbn07XG5cbi8vIFVuc2hpZnQgc2hvdWxkICphbHdheXMqIGJlIHNvbWV0aGluZyBkaXJlY3RseSBvdXQgb2YgcmVhZCgpXG5SZWFkYWJsZS5wcm90b3R5cGUudW5zaGlmdCA9IGZ1bmN0aW9uKGNodW5rKSB7XG4gIHZhciBzdGF0ZSA9IHRoaXMuX3JlYWRhYmxlU3RhdGU7XG4gIHJldHVybiByZWFkYWJsZUFkZENodW5rKHRoaXMsIHN0YXRlLCBjaHVuaywgJycsIHRydWUpO1xufTtcblxuZnVuY3Rpb24gcmVhZGFibGVBZGRDaHVuayhzdHJlYW0sIHN0YXRlLCBjaHVuaywgZW5jb2RpbmcsIGFkZFRvRnJvbnQpIHtcbiAgdmFyIGVyID0gY2h1bmtJbnZhbGlkKHN0YXRlLCBjaHVuayk7XG4gIGlmIChlcikge1xuICAgIHN0cmVhbS5lbWl0KCdlcnJvcicsIGVyKTtcbiAgfSBlbHNlIGlmIChjaHVuayA9PT0gbnVsbCB8fCBjaHVuayA9PT0gdW5kZWZpbmVkKSB7XG4gICAgc3RhdGUucmVhZGluZyA9IGZhbHNlO1xuICAgIGlmICghc3RhdGUuZW5kZWQpXG4gICAgICBvbkVvZkNodW5rKHN0cmVhbSwgc3RhdGUpO1xuICB9IGVsc2UgaWYgKHN0YXRlLm9iamVjdE1vZGUgfHwgY2h1bmsgJiYgY2h1bmsubGVuZ3RoID4gMCkge1xuICAgIGlmIChzdGF0ZS5lbmRlZCAmJiAhYWRkVG9Gcm9udCkge1xuICAgICAgdmFyIGUgPSBuZXcgRXJyb3IoJ3N0cmVhbS5wdXNoKCkgYWZ0ZXIgRU9GJyk7XG4gICAgICBzdHJlYW0uZW1pdCgnZXJyb3InLCBlKTtcbiAgICB9IGVsc2UgaWYgKHN0YXRlLmVuZEVtaXR0ZWQgJiYgYWRkVG9Gcm9udCkge1xuICAgICAgdmFyIGUgPSBuZXcgRXJyb3IoJ3N0cmVhbS51bnNoaWZ0KCkgYWZ0ZXIgZW5kIGV2ZW50Jyk7XG4gICAgICBzdHJlYW0uZW1pdCgnZXJyb3InLCBlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgaWYgKHN0YXRlLmRlY29kZXIgJiYgIWFkZFRvRnJvbnQgJiYgIWVuY29kaW5nKVxuICAgICAgICBjaHVuayA9IHN0YXRlLmRlY29kZXIud3JpdGUoY2h1bmspO1xuXG4gICAgICAvLyB1cGRhdGUgdGhlIGJ1ZmZlciBpbmZvLlxuICAgICAgc3RhdGUubGVuZ3RoICs9IHN0YXRlLm9iamVjdE1vZGUgPyAxIDogY2h1bmsubGVuZ3RoO1xuICAgICAgaWYgKGFkZFRvRnJvbnQpIHtcbiAgICAgICAgc3RhdGUuYnVmZmVyLnVuc2hpZnQoY2h1bmspO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc3RhdGUucmVhZGluZyA9IGZhbHNlO1xuICAgICAgICBzdGF0ZS5idWZmZXIucHVzaChjaHVuayk7XG4gICAgICB9XG5cbiAgICAgIGlmIChzdGF0ZS5uZWVkUmVhZGFibGUpXG4gICAgICAgIGVtaXRSZWFkYWJsZShzdHJlYW0pO1xuXG4gICAgICBtYXliZVJlYWRNb3JlKHN0cmVhbSwgc3RhdGUpO1xuICAgIH1cbiAgfSBlbHNlIGlmICghYWRkVG9Gcm9udCkge1xuICAgIHN0YXRlLnJlYWRpbmcgPSBmYWxzZTtcbiAgfVxuXG4gIHJldHVybiBuZWVkTW9yZURhdGEoc3RhdGUpO1xufVxuXG5cblxuLy8gaWYgaXQncyBwYXN0IHRoZSBoaWdoIHdhdGVyIG1hcmssIHdlIGNhbiBwdXNoIGluIHNvbWUgbW9yZS5cbi8vIEFsc28sIGlmIHdlIGhhdmUgbm8gZGF0YSB5ZXQsIHdlIGNhbiBzdGFuZCBzb21lXG4vLyBtb3JlIGJ5dGVzLiAgVGhpcyBpcyB0byB3b3JrIGFyb3VuZCBjYXNlcyB3aGVyZSBod209MCxcbi8vIHN1Y2ggYXMgdGhlIHJlcGwuICBBbHNvLCBpZiB0aGUgcHVzaCgpIHRyaWdnZXJlZCBhXG4vLyByZWFkYWJsZSBldmVudCwgYW5kIHRoZSB1c2VyIGNhbGxlZCByZWFkKGxhcmdlTnVtYmVyKSBzdWNoIHRoYXRcbi8vIG5lZWRSZWFkYWJsZSB3YXMgc2V0LCB0aGVuIHdlIG91Z2h0IHRvIHB1c2ggbW9yZSwgc28gdGhhdCBhbm90aGVyXG4vLyAncmVhZGFibGUnIGV2ZW50IHdpbGwgYmUgdHJpZ2dlcmVkLlxuZnVuY3Rpb24gbmVlZE1vcmVEYXRhKHN0YXRlKSB7XG4gIHJldHVybiAhc3RhdGUuZW5kZWQgJiZcbiAgICAgICAgIChzdGF0ZS5uZWVkUmVhZGFibGUgfHxcbiAgICAgICAgICBzdGF0ZS5sZW5ndGggPCBzdGF0ZS5oaWdoV2F0ZXJNYXJrIHx8XG4gICAgICAgICAgc3RhdGUubGVuZ3RoID09PSAwKTtcbn1cblxuLy8gYmFja3dhcmRzIGNvbXBhdGliaWxpdHkuXG5SZWFkYWJsZS5wcm90b3R5cGUuc2V0RW5jb2RpbmcgPSBmdW5jdGlvbihlbmMpIHtcbiAgaWYgKCFTdHJpbmdEZWNvZGVyKVxuICAgIFN0cmluZ0RlY29kZXIgPSByZXF1aXJlKCdzdHJpbmdfZGVjb2Rlci8nKS5TdHJpbmdEZWNvZGVyO1xuICB0aGlzLl9yZWFkYWJsZVN0YXRlLmRlY29kZXIgPSBuZXcgU3RyaW5nRGVjb2RlcihlbmMpO1xuICB0aGlzLl9yZWFkYWJsZVN0YXRlLmVuY29kaW5nID0gZW5jO1xufTtcblxuLy8gRG9uJ3QgcmFpc2UgdGhlIGh3bSA+IDEyOE1CXG52YXIgTUFYX0hXTSA9IDB4ODAwMDAwO1xuZnVuY3Rpb24gcm91bmRVcFRvTmV4dFBvd2VyT2YyKG4pIHtcbiAgaWYgKG4gPj0gTUFYX0hXTSkge1xuICAgIG4gPSBNQVhfSFdNO1xuICB9IGVsc2Uge1xuICAgIC8vIEdldCB0aGUgbmV4dCBoaWdoZXN0IHBvd2VyIG9mIDJcbiAgICBuLS07XG4gICAgZm9yICh2YXIgcCA9IDE7IHAgPCAzMjsgcCA8PD0gMSkgbiB8PSBuID4+IHA7XG4gICAgbisrO1xuICB9XG4gIHJldHVybiBuO1xufVxuXG5mdW5jdGlvbiBob3dNdWNoVG9SZWFkKG4sIHN0YXRlKSB7XG4gIGlmIChzdGF0ZS5sZW5ndGggPT09IDAgJiYgc3RhdGUuZW5kZWQpXG4gICAgcmV0dXJuIDA7XG5cbiAgaWYgKHN0YXRlLm9iamVjdE1vZGUpXG4gICAgcmV0dXJuIG4gPT09IDAgPyAwIDogMTtcblxuICBpZiAobiA9PT0gbnVsbCB8fCBpc05hTihuKSkge1xuICAgIC8vIG9ubHkgZmxvdyBvbmUgYnVmZmVyIGF0IGEgdGltZVxuICAgIGlmIChzdGF0ZS5mbG93aW5nICYmIHN0YXRlLmJ1ZmZlci5sZW5ndGgpXG4gICAgICByZXR1cm4gc3RhdGUuYnVmZmVyWzBdLmxlbmd0aDtcbiAgICBlbHNlXG4gICAgICByZXR1cm4gc3RhdGUubGVuZ3RoO1xuICB9XG5cbiAgaWYgKG4gPD0gMClcbiAgICByZXR1cm4gMDtcblxuICAvLyBJZiB3ZSdyZSBhc2tpbmcgZm9yIG1vcmUgdGhhbiB0aGUgdGFyZ2V0IGJ1ZmZlciBsZXZlbCxcbiAgLy8gdGhlbiByYWlzZSB0aGUgd2F0ZXIgbWFyay4gIEJ1bXAgdXAgdG8gdGhlIG5leHQgaGlnaGVzdFxuICAvLyBwb3dlciBvZiAyLCB0byBwcmV2ZW50IGluY3JlYXNpbmcgaXQgZXhjZXNzaXZlbHkgaW4gdGlueVxuICAvLyBhbW91bnRzLlxuICBpZiAobiA+IHN0YXRlLmhpZ2hXYXRlck1hcmspXG4gICAgc3RhdGUuaGlnaFdhdGVyTWFyayA9IHJvdW5kVXBUb05leHRQb3dlck9mMihuKTtcblxuICAvLyBkb24ndCBoYXZlIHRoYXQgbXVjaC4gIHJldHVybiBudWxsLCB1bmxlc3Mgd2UndmUgZW5kZWQuXG4gIGlmIChuID4gc3RhdGUubGVuZ3RoKSB7XG4gICAgaWYgKCFzdGF0ZS5lbmRlZCkge1xuICAgICAgc3RhdGUubmVlZFJlYWRhYmxlID0gdHJ1ZTtcbiAgICAgIHJldHVybiAwO1xuICAgIH0gZWxzZVxuICAgICAgcmV0dXJuIHN0YXRlLmxlbmd0aDtcbiAgfVxuXG4gIHJldHVybiBuO1xufVxuXG4vLyB5b3UgY2FuIG92ZXJyaWRlIGVpdGhlciB0aGlzIG1ldGhvZCwgb3IgdGhlIGFzeW5jIF9yZWFkKG4pIGJlbG93LlxuUmVhZGFibGUucHJvdG90eXBlLnJlYWQgPSBmdW5jdGlvbihuKSB7XG4gIHZhciBzdGF0ZSA9IHRoaXMuX3JlYWRhYmxlU3RhdGU7XG4gIHN0YXRlLmNhbGxlZFJlYWQgPSB0cnVlO1xuICB2YXIgbk9yaWcgPSBuO1xuICB2YXIgcmV0O1xuXG4gIGlmICh0eXBlb2YgbiAhPT0gJ251bWJlcicgfHwgbiA+IDApXG4gICAgc3RhdGUuZW1pdHRlZFJlYWRhYmxlID0gZmFsc2U7XG5cbiAgLy8gaWYgd2UncmUgZG9pbmcgcmVhZCgwKSB0byB0cmlnZ2VyIGEgcmVhZGFibGUgZXZlbnQsIGJ1dCB3ZVxuICAvLyBhbHJlYWR5IGhhdmUgYSBidW5jaCBvZiBkYXRhIGluIHRoZSBidWZmZXIsIHRoZW4ganVzdCB0cmlnZ2VyXG4gIC8vIHRoZSAncmVhZGFibGUnIGV2ZW50IGFuZCBtb3ZlIG9uLlxuICBpZiAobiA9PT0gMCAmJlxuICAgICAgc3RhdGUubmVlZFJlYWRhYmxlICYmXG4gICAgICAoc3RhdGUubGVuZ3RoID49IHN0YXRlLmhpZ2hXYXRlck1hcmsgfHwgc3RhdGUuZW5kZWQpKSB7XG4gICAgZW1pdFJlYWRhYmxlKHRoaXMpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgbiA9IGhvd011Y2hUb1JlYWQobiwgc3RhdGUpO1xuXG4gIC8vIGlmIHdlJ3ZlIGVuZGVkLCBhbmQgd2UncmUgbm93IGNsZWFyLCB0aGVuIGZpbmlzaCBpdCB1cC5cbiAgaWYgKG4gPT09IDAgJiYgc3RhdGUuZW5kZWQpIHtcbiAgICByZXQgPSBudWxsO1xuXG4gICAgLy8gSW4gY2FzZXMgd2hlcmUgdGhlIGRlY29kZXIgZGlkIG5vdCByZWNlaXZlIGVub3VnaCBkYXRhXG4gICAgLy8gdG8gcHJvZHVjZSBhIGZ1bGwgY2h1bmssIHRoZW4gaW1tZWRpYXRlbHkgcmVjZWl2ZWQgYW5cbiAgICAvLyBFT0YsIHN0YXRlLmJ1ZmZlciB3aWxsIGNvbnRhaW4gWzxCdWZmZXIgPiwgPEJ1ZmZlciAwMCAuLi4+XS5cbiAgICAvLyBob3dNdWNoVG9SZWFkIHdpbGwgc2VlIHRoaXMgYW5kIGNvZXJjZSB0aGUgYW1vdW50IHRvXG4gICAgLy8gcmVhZCB0byB6ZXJvIChiZWNhdXNlIGl0J3MgbG9va2luZyBhdCB0aGUgbGVuZ3RoIG9mIHRoZVxuICAgIC8vIGZpcnN0IDxCdWZmZXIgPiBpbiBzdGF0ZS5idWZmZXIpLCBhbmQgd2UnbGwgZW5kIHVwIGhlcmUuXG4gICAgLy9cbiAgICAvLyBUaGlzIGNhbiBvbmx5IGhhcHBlbiB2aWEgc3RhdGUuZGVjb2RlciAtLSBubyBvdGhlciB2ZW51ZVxuICAgIC8vIGV4aXN0cyBmb3IgcHVzaGluZyBhIHplcm8tbGVuZ3RoIGNodW5rIGludG8gc3RhdGUuYnVmZmVyXG4gICAgLy8gYW5kIHRyaWdnZXJpbmcgdGhpcyBiZWhhdmlvci4gSW4gdGhpcyBjYXNlLCB3ZSByZXR1cm4gb3VyXG4gICAgLy8gcmVtYWluaW5nIGRhdGEgYW5kIGVuZCB0aGUgc3RyZWFtLCBpZiBhcHByb3ByaWF0ZS5cbiAgICBpZiAoc3RhdGUubGVuZ3RoID4gMCAmJiBzdGF0ZS5kZWNvZGVyKSB7XG4gICAgICByZXQgPSBmcm9tTGlzdChuLCBzdGF0ZSk7XG4gICAgICBzdGF0ZS5sZW5ndGggLT0gcmV0Lmxlbmd0aDtcbiAgICB9XG5cbiAgICBpZiAoc3RhdGUubGVuZ3RoID09PSAwKVxuICAgICAgZW5kUmVhZGFibGUodGhpcyk7XG5cbiAgICByZXR1cm4gcmV0O1xuICB9XG5cbiAgLy8gQWxsIHRoZSBhY3R1YWwgY2h1bmsgZ2VuZXJhdGlvbiBsb2dpYyBuZWVkcyB0byBiZVxuICAvLyAqYmVsb3cqIHRoZSBjYWxsIHRvIF9yZWFkLiAgVGhlIHJlYXNvbiBpcyB0aGF0IGluIGNlcnRhaW5cbiAgLy8gc3ludGhldGljIHN0cmVhbSBjYXNlcywgc3VjaCBhcyBwYXNzdGhyb3VnaCBzdHJlYW1zLCBfcmVhZFxuICAvLyBtYXkgYmUgYSBjb21wbGV0ZWx5IHN5bmNocm9ub3VzIG9wZXJhdGlvbiB3aGljaCBtYXkgY2hhbmdlXG4gIC8vIHRoZSBzdGF0ZSBvZiB0aGUgcmVhZCBidWZmZXIsIHByb3ZpZGluZyBlbm91Z2ggZGF0YSB3aGVuXG4gIC8vIGJlZm9yZSB0aGVyZSB3YXMgKm5vdCogZW5vdWdoLlxuICAvL1xuICAvLyBTbywgdGhlIHN0ZXBzIGFyZTpcbiAgLy8gMS4gRmlndXJlIG91dCB3aGF0IHRoZSBzdGF0ZSBvZiB0aGluZ3Mgd2lsbCBiZSBhZnRlciB3ZSBkb1xuICAvLyBhIHJlYWQgZnJvbSB0aGUgYnVmZmVyLlxuICAvL1xuICAvLyAyLiBJZiB0aGF0IHJlc3VsdGluZyBzdGF0ZSB3aWxsIHRyaWdnZXIgYSBfcmVhZCwgdGhlbiBjYWxsIF9yZWFkLlxuICAvLyBOb3RlIHRoYXQgdGhpcyBtYXkgYmUgYXN5bmNocm9ub3VzLCBvciBzeW5jaHJvbm91cy4gIFllcywgaXQgaXNcbiAgLy8gZGVlcGx5IHVnbHkgdG8gd3JpdGUgQVBJcyB0aGlzIHdheSwgYnV0IHRoYXQgc3RpbGwgZG9lc24ndCBtZWFuXG4gIC8vIHRoYXQgdGhlIFJlYWRhYmxlIGNsYXNzIHNob3VsZCBiZWhhdmUgaW1wcm9wZXJseSwgYXMgc3RyZWFtcyBhcmVcbiAgLy8gZGVzaWduZWQgdG8gYmUgc3luYy9hc3luYyBhZ25vc3RpYy5cbiAgLy8gVGFrZSBub3RlIGlmIHRoZSBfcmVhZCBjYWxsIGlzIHN5bmMgb3IgYXN5bmMgKGllLCBpZiB0aGUgcmVhZCBjYWxsXG4gIC8vIGhhcyByZXR1cm5lZCB5ZXQpLCBzbyB0aGF0IHdlIGtub3cgd2hldGhlciBvciBub3QgaXQncyBzYWZlIHRvIGVtaXRcbiAgLy8gJ3JlYWRhYmxlJyBldGMuXG4gIC8vXG4gIC8vIDMuIEFjdHVhbGx5IHB1bGwgdGhlIHJlcXVlc3RlZCBjaHVua3Mgb3V0IG9mIHRoZSBidWZmZXIgYW5kIHJldHVybi5cblxuICAvLyBpZiB3ZSBuZWVkIGEgcmVhZGFibGUgZXZlbnQsIHRoZW4gd2UgbmVlZCB0byBkbyBzb21lIHJlYWRpbmcuXG4gIHZhciBkb1JlYWQgPSBzdGF0ZS5uZWVkUmVhZGFibGU7XG5cbiAgLy8gaWYgd2UgY3VycmVudGx5IGhhdmUgbGVzcyB0aGFuIHRoZSBoaWdoV2F0ZXJNYXJrLCB0aGVuIGFsc28gcmVhZCBzb21lXG4gIGlmIChzdGF0ZS5sZW5ndGggLSBuIDw9IHN0YXRlLmhpZ2hXYXRlck1hcmspXG4gICAgZG9SZWFkID0gdHJ1ZTtcblxuICAvLyBob3dldmVyLCBpZiB3ZSd2ZSBlbmRlZCwgdGhlbiB0aGVyZSdzIG5vIHBvaW50LCBhbmQgaWYgd2UncmUgYWxyZWFkeVxuICAvLyByZWFkaW5nLCB0aGVuIGl0J3MgdW5uZWNlc3NhcnkuXG4gIGlmIChzdGF0ZS5lbmRlZCB8fCBzdGF0ZS5yZWFkaW5nKVxuICAgIGRvUmVhZCA9IGZhbHNlO1xuXG4gIGlmIChkb1JlYWQpIHtcbiAgICBzdGF0ZS5yZWFkaW5nID0gdHJ1ZTtcbiAgICBzdGF0ZS5zeW5jID0gdHJ1ZTtcbiAgICAvLyBpZiB0aGUgbGVuZ3RoIGlzIGN1cnJlbnRseSB6ZXJvLCB0aGVuIHdlICpuZWVkKiBhIHJlYWRhYmxlIGV2ZW50LlxuICAgIGlmIChzdGF0ZS5sZW5ndGggPT09IDApXG4gICAgICBzdGF0ZS5uZWVkUmVhZGFibGUgPSB0cnVlO1xuICAgIC8vIGNhbGwgaW50ZXJuYWwgcmVhZCBtZXRob2RcbiAgICB0aGlzLl9yZWFkKHN0YXRlLmhpZ2hXYXRlck1hcmspO1xuICAgIHN0YXRlLnN5bmMgPSBmYWxzZTtcbiAgfVxuXG4gIC8vIElmIF9yZWFkIGNhbGxlZCBpdHMgY2FsbGJhY2sgc3luY2hyb25vdXNseSwgdGhlbiBgcmVhZGluZ2BcbiAgLy8gd2lsbCBiZSBmYWxzZSwgYW5kIHdlIG5lZWQgdG8gcmUtZXZhbHVhdGUgaG93IG11Y2ggZGF0YSB3ZVxuICAvLyBjYW4gcmV0dXJuIHRvIHRoZSB1c2VyLlxuICBpZiAoZG9SZWFkICYmICFzdGF0ZS5yZWFkaW5nKVxuICAgIG4gPSBob3dNdWNoVG9SZWFkKG5PcmlnLCBzdGF0ZSk7XG5cbiAgaWYgKG4gPiAwKVxuICAgIHJldCA9IGZyb21MaXN0KG4sIHN0YXRlKTtcbiAgZWxzZVxuICAgIHJldCA9IG51bGw7XG5cbiAgaWYgKHJldCA9PT0gbnVsbCkge1xuICAgIHN0YXRlLm5lZWRSZWFkYWJsZSA9IHRydWU7XG4gICAgbiA9IDA7XG4gIH1cblxuICBzdGF0ZS5sZW5ndGggLT0gbjtcblxuICAvLyBJZiB3ZSBoYXZlIG5vdGhpbmcgaW4gdGhlIGJ1ZmZlciwgdGhlbiB3ZSB3YW50IHRvIGtub3dcbiAgLy8gYXMgc29vbiBhcyB3ZSAqZG8qIGdldCBzb21ldGhpbmcgaW50byB0aGUgYnVmZmVyLlxuICBpZiAoc3RhdGUubGVuZ3RoID09PSAwICYmICFzdGF0ZS5lbmRlZClcbiAgICBzdGF0ZS5uZWVkUmVhZGFibGUgPSB0cnVlO1xuXG4gIC8vIElmIHdlIGhhcHBlbmVkIHRvIHJlYWQoKSBleGFjdGx5IHRoZSByZW1haW5pbmcgYW1vdW50IGluIHRoZVxuICAvLyBidWZmZXIsIGFuZCB0aGUgRU9GIGhhcyBiZWVuIHNlZW4gYXQgdGhpcyBwb2ludCwgdGhlbiBtYWtlIHN1cmVcbiAgLy8gdGhhdCB3ZSBlbWl0ICdlbmQnIG9uIHRoZSB2ZXJ5IG5leHQgdGljay5cbiAgaWYgKHN0YXRlLmVuZGVkICYmICFzdGF0ZS5lbmRFbWl0dGVkICYmIHN0YXRlLmxlbmd0aCA9PT0gMClcbiAgICBlbmRSZWFkYWJsZSh0aGlzKTtcblxuICByZXR1cm4gcmV0O1xufTtcblxuZnVuY3Rpb24gY2h1bmtJbnZhbGlkKHN0YXRlLCBjaHVuaykge1xuICB2YXIgZXIgPSBudWxsO1xuICBpZiAoIUJ1ZmZlci5pc0J1ZmZlcihjaHVuaykgJiZcbiAgICAgICdzdHJpbmcnICE9PSB0eXBlb2YgY2h1bmsgJiZcbiAgICAgIGNodW5rICE9PSBudWxsICYmXG4gICAgICBjaHVuayAhPT0gdW5kZWZpbmVkICYmXG4gICAgICAhc3RhdGUub2JqZWN0TW9kZSkge1xuICAgIGVyID0gbmV3IFR5cGVFcnJvcignSW52YWxpZCBub24tc3RyaW5nL2J1ZmZlciBjaHVuaycpO1xuICB9XG4gIHJldHVybiBlcjtcbn1cblxuXG5mdW5jdGlvbiBvbkVvZkNodW5rKHN0cmVhbSwgc3RhdGUpIHtcbiAgaWYgKHN0YXRlLmRlY29kZXIgJiYgIXN0YXRlLmVuZGVkKSB7XG4gICAgdmFyIGNodW5rID0gc3RhdGUuZGVjb2Rlci5lbmQoKTtcbiAgICBpZiAoY2h1bmsgJiYgY2h1bmsubGVuZ3RoKSB7XG4gICAgICBzdGF0ZS5idWZmZXIucHVzaChjaHVuayk7XG4gICAgICBzdGF0ZS5sZW5ndGggKz0gc3RhdGUub2JqZWN0TW9kZSA/IDEgOiBjaHVuay5sZW5ndGg7XG4gICAgfVxuICB9XG4gIHN0YXRlLmVuZGVkID0gdHJ1ZTtcblxuICAvLyBpZiB3ZSd2ZSBlbmRlZCBhbmQgd2UgaGF2ZSBzb21lIGRhdGEgbGVmdCwgdGhlbiBlbWl0XG4gIC8vICdyZWFkYWJsZScgbm93IHRvIG1ha2Ugc3VyZSBpdCBnZXRzIHBpY2tlZCB1cC5cbiAgaWYgKHN0YXRlLmxlbmd0aCA+IDApXG4gICAgZW1pdFJlYWRhYmxlKHN0cmVhbSk7XG4gIGVsc2VcbiAgICBlbmRSZWFkYWJsZShzdHJlYW0pO1xufVxuXG4vLyBEb24ndCBlbWl0IHJlYWRhYmxlIHJpZ2h0IGF3YXkgaW4gc3luYyBtb2RlLCBiZWNhdXNlIHRoaXMgY2FuIHRyaWdnZXJcbi8vIGFub3RoZXIgcmVhZCgpIGNhbGwgPT4gc3RhY2sgb3ZlcmZsb3cuICBUaGlzIHdheSwgaXQgbWlnaHQgdHJpZ2dlclxuLy8gYSBuZXh0VGljayByZWN1cnNpb24gd2FybmluZywgYnV0IHRoYXQncyBub3Qgc28gYmFkLlxuZnVuY3Rpb24gZW1pdFJlYWRhYmxlKHN0cmVhbSkge1xuICB2YXIgc3RhdGUgPSBzdHJlYW0uX3JlYWRhYmxlU3RhdGU7XG4gIHN0YXRlLm5lZWRSZWFkYWJsZSA9IGZhbHNlO1xuICBpZiAoc3RhdGUuZW1pdHRlZFJlYWRhYmxlKVxuICAgIHJldHVybjtcblxuICBzdGF0ZS5lbWl0dGVkUmVhZGFibGUgPSB0cnVlO1xuICBpZiAoc3RhdGUuc3luYylcbiAgICBwcm9jZXNzLm5leHRUaWNrKGZ1bmN0aW9uKCkge1xuICAgICAgZW1pdFJlYWRhYmxlXyhzdHJlYW0pO1xuICAgIH0pO1xuICBlbHNlXG4gICAgZW1pdFJlYWRhYmxlXyhzdHJlYW0pO1xufVxuXG5mdW5jdGlvbiBlbWl0UmVhZGFibGVfKHN0cmVhbSkge1xuICBzdHJlYW0uZW1pdCgncmVhZGFibGUnKTtcbn1cblxuXG4vLyBhdCB0aGlzIHBvaW50LCB0aGUgdXNlciBoYXMgcHJlc3VtYWJseSBzZWVuIHRoZSAncmVhZGFibGUnIGV2ZW50LFxuLy8gYW5kIGNhbGxlZCByZWFkKCkgdG8gY29uc3VtZSBzb21lIGRhdGEuICB0aGF0IG1heSBoYXZlIHRyaWdnZXJlZFxuLy8gaW4gdHVybiBhbm90aGVyIF9yZWFkKG4pIGNhbGwsIGluIHdoaWNoIGNhc2UgcmVhZGluZyA9IHRydWUgaWZcbi8vIGl0J3MgaW4gcHJvZ3Jlc3MuXG4vLyBIb3dldmVyLCBpZiB3ZSdyZSBub3QgZW5kZWQsIG9yIHJlYWRpbmcsIGFuZCB0aGUgbGVuZ3RoIDwgaHdtLFxuLy8gdGhlbiBnbyBhaGVhZCBhbmQgdHJ5IHRvIHJlYWQgc29tZSBtb3JlIHByZWVtcHRpdmVseS5cbmZ1bmN0aW9uIG1heWJlUmVhZE1vcmUoc3RyZWFtLCBzdGF0ZSkge1xuICBpZiAoIXN0YXRlLnJlYWRpbmdNb3JlKSB7XG4gICAgc3RhdGUucmVhZGluZ01vcmUgPSB0cnVlO1xuICAgIHByb2Nlc3MubmV4dFRpY2soZnVuY3Rpb24oKSB7XG4gICAgICBtYXliZVJlYWRNb3JlXyhzdHJlYW0sIHN0YXRlKTtcbiAgICB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBtYXliZVJlYWRNb3JlXyhzdHJlYW0sIHN0YXRlKSB7XG4gIHZhciBsZW4gPSBzdGF0ZS5sZW5ndGg7XG4gIHdoaWxlICghc3RhdGUucmVhZGluZyAmJiAhc3RhdGUuZmxvd2luZyAmJiAhc3RhdGUuZW5kZWQgJiZcbiAgICAgICAgIHN0YXRlLmxlbmd0aCA8IHN0YXRlLmhpZ2hXYXRlck1hcmspIHtcbiAgICBzdHJlYW0ucmVhZCgwKTtcbiAgICBpZiAobGVuID09PSBzdGF0ZS5sZW5ndGgpXG4gICAgICAvLyBkaWRuJ3QgZ2V0IGFueSBkYXRhLCBzdG9wIHNwaW5uaW5nLlxuICAgICAgYnJlYWs7XG4gICAgZWxzZVxuICAgICAgbGVuID0gc3RhdGUubGVuZ3RoO1xuICB9XG4gIHN0YXRlLnJlYWRpbmdNb3JlID0gZmFsc2U7XG59XG5cbi8vIGFic3RyYWN0IG1ldGhvZC4gIHRvIGJlIG92ZXJyaWRkZW4gaW4gc3BlY2lmaWMgaW1wbGVtZW50YXRpb24gY2xhc3Nlcy5cbi8vIGNhbGwgY2IoZXIsIGRhdGEpIHdoZXJlIGRhdGEgaXMgPD0gbiBpbiBsZW5ndGguXG4vLyBmb3IgdmlydHVhbCAobm9uLXN0cmluZywgbm9uLWJ1ZmZlcikgc3RyZWFtcywgXCJsZW5ndGhcIiBpcyBzb21ld2hhdFxuLy8gYXJiaXRyYXJ5LCBhbmQgcGVyaGFwcyBub3QgdmVyeSBtZWFuaW5nZnVsLlxuUmVhZGFibGUucHJvdG90eXBlLl9yZWFkID0gZnVuY3Rpb24obikge1xuICB0aGlzLmVtaXQoJ2Vycm9yJywgbmV3IEVycm9yKCdub3QgaW1wbGVtZW50ZWQnKSk7XG59O1xuXG5SZWFkYWJsZS5wcm90b3R5cGUucGlwZSA9IGZ1bmN0aW9uKGRlc3QsIHBpcGVPcHRzKSB7XG4gIHZhciBzcmMgPSB0aGlzO1xuICB2YXIgc3RhdGUgPSB0aGlzLl9yZWFkYWJsZVN0YXRlO1xuXG4gIHN3aXRjaCAoc3RhdGUucGlwZXNDb3VudCkge1xuICAgIGNhc2UgMDpcbiAgICAgIHN0YXRlLnBpcGVzID0gZGVzdDtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgMTpcbiAgICAgIHN0YXRlLnBpcGVzID0gW3N0YXRlLnBpcGVzLCBkZXN0XTtcbiAgICAgIGJyZWFrO1xuICAgIGRlZmF1bHQ6XG4gICAgICBzdGF0ZS5waXBlcy5wdXNoKGRlc3QpO1xuICAgICAgYnJlYWs7XG4gIH1cbiAgc3RhdGUucGlwZXNDb3VudCArPSAxO1xuXG4gIHZhciBkb0VuZCA9ICghcGlwZU9wdHMgfHwgcGlwZU9wdHMuZW5kICE9PSBmYWxzZSkgJiZcbiAgICAgICAgICAgICAgZGVzdCAhPT0gcHJvY2Vzcy5zdGRvdXQgJiZcbiAgICAgICAgICAgICAgZGVzdCAhPT0gcHJvY2Vzcy5zdGRlcnI7XG5cbiAgdmFyIGVuZEZuID0gZG9FbmQgPyBvbmVuZCA6IGNsZWFudXA7XG4gIGlmIChzdGF0ZS5lbmRFbWl0dGVkKVxuICAgIHByb2Nlc3MubmV4dFRpY2soZW5kRm4pO1xuICBlbHNlXG4gICAgc3JjLm9uY2UoJ2VuZCcsIGVuZEZuKTtcblxuICBkZXN0Lm9uKCd1bnBpcGUnLCBvbnVucGlwZSk7XG4gIGZ1bmN0aW9uIG9udW5waXBlKHJlYWRhYmxlKSB7XG4gICAgaWYgKHJlYWRhYmxlICE9PSBzcmMpIHJldHVybjtcbiAgICBjbGVhbnVwKCk7XG4gIH1cblxuICBmdW5jdGlvbiBvbmVuZCgpIHtcbiAgICBkZXN0LmVuZCgpO1xuICB9XG5cbiAgLy8gd2hlbiB0aGUgZGVzdCBkcmFpbnMsIGl0IHJlZHVjZXMgdGhlIGF3YWl0RHJhaW4gY291bnRlclxuICAvLyBvbiB0aGUgc291cmNlLiAgVGhpcyB3b3VsZCBiZSBtb3JlIGVsZWdhbnQgd2l0aCBhIC5vbmNlKClcbiAgLy8gaGFuZGxlciBpbiBmbG93KCksIGJ1dCBhZGRpbmcgYW5kIHJlbW92aW5nIHJlcGVhdGVkbHkgaXNcbiAgLy8gdG9vIHNsb3cuXG4gIHZhciBvbmRyYWluID0gcGlwZU9uRHJhaW4oc3JjKTtcbiAgZGVzdC5vbignZHJhaW4nLCBvbmRyYWluKTtcblxuICBmdW5jdGlvbiBjbGVhbnVwKCkge1xuICAgIC8vIGNsZWFudXAgZXZlbnQgaGFuZGxlcnMgb25jZSB0aGUgcGlwZSBpcyBicm9rZW5cbiAgICBkZXN0LnJlbW92ZUxpc3RlbmVyKCdjbG9zZScsIG9uY2xvc2UpO1xuICAgIGRlc3QucmVtb3ZlTGlzdGVuZXIoJ2ZpbmlzaCcsIG9uZmluaXNoKTtcbiAgICBkZXN0LnJlbW92ZUxpc3RlbmVyKCdkcmFpbicsIG9uZHJhaW4pO1xuICAgIGRlc3QucmVtb3ZlTGlzdGVuZXIoJ2Vycm9yJywgb25lcnJvcik7XG4gICAgZGVzdC5yZW1vdmVMaXN0ZW5lcigndW5waXBlJywgb251bnBpcGUpO1xuICAgIHNyYy5yZW1vdmVMaXN0ZW5lcignZW5kJywgb25lbmQpO1xuICAgIHNyYy5yZW1vdmVMaXN0ZW5lcignZW5kJywgY2xlYW51cCk7XG5cbiAgICAvLyBpZiB0aGUgcmVhZGVyIGlzIHdhaXRpbmcgZm9yIGEgZHJhaW4gZXZlbnQgZnJvbSB0aGlzXG4gICAgLy8gc3BlY2lmaWMgd3JpdGVyLCB0aGVuIGl0IHdvdWxkIGNhdXNlIGl0IHRvIG5ldmVyIHN0YXJ0XG4gICAgLy8gZmxvd2luZyBhZ2Fpbi5cbiAgICAvLyBTbywgaWYgdGhpcyBpcyBhd2FpdGluZyBhIGRyYWluLCB0aGVuIHdlIGp1c3QgY2FsbCBpdCBub3cuXG4gICAgLy8gSWYgd2UgZG9uJ3Qga25vdywgdGhlbiBhc3N1bWUgdGhhdCB3ZSBhcmUgd2FpdGluZyBmb3Igb25lLlxuICAgIGlmICghZGVzdC5fd3JpdGFibGVTdGF0ZSB8fCBkZXN0Ll93cml0YWJsZVN0YXRlLm5lZWREcmFpbilcbiAgICAgIG9uZHJhaW4oKTtcbiAgfVxuXG4gIC8vIGlmIHRoZSBkZXN0IGhhcyBhbiBlcnJvciwgdGhlbiBzdG9wIHBpcGluZyBpbnRvIGl0LlxuICAvLyBob3dldmVyLCBkb24ndCBzdXBwcmVzcyB0aGUgdGhyb3dpbmcgYmVoYXZpb3IgZm9yIHRoaXMuXG4gIGZ1bmN0aW9uIG9uZXJyb3IoZXIpIHtcbiAgICB1bnBpcGUoKTtcbiAgICBkZXN0LnJlbW92ZUxpc3RlbmVyKCdlcnJvcicsIG9uZXJyb3IpO1xuICAgIGlmIChFRS5saXN0ZW5lckNvdW50KGRlc3QsICdlcnJvcicpID09PSAwKVxuICAgICAgZGVzdC5lbWl0KCdlcnJvcicsIGVyKTtcbiAgfVxuICAvLyBUaGlzIGlzIGEgYnJ1dGFsbHkgdWdseSBoYWNrIHRvIG1ha2Ugc3VyZSB0aGF0IG91ciBlcnJvciBoYW5kbGVyXG4gIC8vIGlzIGF0dGFjaGVkIGJlZm9yZSBhbnkgdXNlcmxhbmQgb25lcy4gIE5FVkVSIERPIFRISVMuXG4gIGlmICghZGVzdC5fZXZlbnRzIHx8ICFkZXN0Ll9ldmVudHMuZXJyb3IpXG4gICAgZGVzdC5vbignZXJyb3InLCBvbmVycm9yKTtcbiAgZWxzZSBpZiAoaXNBcnJheShkZXN0Ll9ldmVudHMuZXJyb3IpKVxuICAgIGRlc3QuX2V2ZW50cy5lcnJvci51bnNoaWZ0KG9uZXJyb3IpO1xuICBlbHNlXG4gICAgZGVzdC5fZXZlbnRzLmVycm9yID0gW29uZXJyb3IsIGRlc3QuX2V2ZW50cy5lcnJvcl07XG5cblxuXG4gIC8vIEJvdGggY2xvc2UgYW5kIGZpbmlzaCBzaG91bGQgdHJpZ2dlciB1bnBpcGUsIGJ1dCBvbmx5IG9uY2UuXG4gIGZ1bmN0aW9uIG9uY2xvc2UoKSB7XG4gICAgZGVzdC5yZW1vdmVMaXN0ZW5lcignZmluaXNoJywgb25maW5pc2gpO1xuICAgIHVucGlwZSgpO1xuICB9XG4gIGRlc3Qub25jZSgnY2xvc2UnLCBvbmNsb3NlKTtcbiAgZnVuY3Rpb24gb25maW5pc2goKSB7XG4gICAgZGVzdC5yZW1vdmVMaXN0ZW5lcignY2xvc2UnLCBvbmNsb3NlKTtcbiAgICB1bnBpcGUoKTtcbiAgfVxuICBkZXN0Lm9uY2UoJ2ZpbmlzaCcsIG9uZmluaXNoKTtcblxuICBmdW5jdGlvbiB1bnBpcGUoKSB7XG4gICAgc3JjLnVucGlwZShkZXN0KTtcbiAgfVxuXG4gIC8vIHRlbGwgdGhlIGRlc3QgdGhhdCBpdCdzIGJlaW5nIHBpcGVkIHRvXG4gIGRlc3QuZW1pdCgncGlwZScsIHNyYyk7XG5cbiAgLy8gc3RhcnQgdGhlIGZsb3cgaWYgaXQgaGFzbid0IGJlZW4gc3RhcnRlZCBhbHJlYWR5LlxuICBpZiAoIXN0YXRlLmZsb3dpbmcpIHtcbiAgICAvLyB0aGUgaGFuZGxlciB0aGF0IHdhaXRzIGZvciByZWFkYWJsZSBldmVudHMgYWZ0ZXIgYWxsXG4gICAgLy8gdGhlIGRhdGEgZ2V0cyBzdWNrZWQgb3V0IGluIGZsb3cuXG4gICAgLy8gVGhpcyB3b3VsZCBiZSBlYXNpZXIgdG8gZm9sbG93IHdpdGggYSAub25jZSgpIGhhbmRsZXJcbiAgICAvLyBpbiBmbG93KCksIGJ1dCB0aGF0IGlzIHRvbyBzbG93LlxuICAgIHRoaXMub24oJ3JlYWRhYmxlJywgcGlwZU9uUmVhZGFibGUpO1xuXG4gICAgc3RhdGUuZmxvd2luZyA9IHRydWU7XG4gICAgcHJvY2Vzcy5uZXh0VGljayhmdW5jdGlvbigpIHtcbiAgICAgIGZsb3coc3JjKTtcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBkZXN0O1xufTtcblxuZnVuY3Rpb24gcGlwZU9uRHJhaW4oc3JjKSB7XG4gIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICB2YXIgZGVzdCA9IHRoaXM7XG4gICAgdmFyIHN0YXRlID0gc3JjLl9yZWFkYWJsZVN0YXRlO1xuICAgIHN0YXRlLmF3YWl0RHJhaW4tLTtcbiAgICBpZiAoc3RhdGUuYXdhaXREcmFpbiA9PT0gMClcbiAgICAgIGZsb3coc3JjKTtcbiAgfTtcbn1cblxuZnVuY3Rpb24gZmxvdyhzcmMpIHtcbiAgdmFyIHN0YXRlID0gc3JjLl9yZWFkYWJsZVN0YXRlO1xuICB2YXIgY2h1bms7XG4gIHN0YXRlLmF3YWl0RHJhaW4gPSAwO1xuXG4gIGZ1bmN0aW9uIHdyaXRlKGRlc3QsIGksIGxpc3QpIHtcbiAgICB2YXIgd3JpdHRlbiA9IGRlc3Qud3JpdGUoY2h1bmspO1xuICAgIGlmIChmYWxzZSA9PT0gd3JpdHRlbikge1xuICAgICAgc3RhdGUuYXdhaXREcmFpbisrO1xuICAgIH1cbiAgfVxuXG4gIHdoaWxlIChzdGF0ZS5waXBlc0NvdW50ICYmIG51bGwgIT09IChjaHVuayA9IHNyYy5yZWFkKCkpKSB7XG5cbiAgICBpZiAoc3RhdGUucGlwZXNDb3VudCA9PT0gMSlcbiAgICAgIHdyaXRlKHN0YXRlLnBpcGVzLCAwLCBudWxsKTtcbiAgICBlbHNlXG4gICAgICBmb3JFYWNoKHN0YXRlLnBpcGVzLCB3cml0ZSk7XG5cbiAgICBzcmMuZW1pdCgnZGF0YScsIGNodW5rKTtcblxuICAgIC8vIGlmIGFueW9uZSBuZWVkcyBhIGRyYWluLCB0aGVuIHdlIGhhdmUgdG8gd2FpdCBmb3IgdGhhdC5cbiAgICBpZiAoc3RhdGUuYXdhaXREcmFpbiA+IDApXG4gICAgICByZXR1cm47XG4gIH1cblxuICAvLyBpZiBldmVyeSBkZXN0aW5hdGlvbiB3YXMgdW5waXBlZCwgZWl0aGVyIGJlZm9yZSBlbnRlcmluZyB0aGlzXG4gIC8vIGZ1bmN0aW9uLCBvciBpbiB0aGUgd2hpbGUgbG9vcCwgdGhlbiBzdG9wIGZsb3dpbmcuXG4gIC8vXG4gIC8vIE5COiBUaGlzIGlzIGEgcHJldHR5IHJhcmUgZWRnZSBjYXNlLlxuICBpZiAoc3RhdGUucGlwZXNDb3VudCA9PT0gMCkge1xuICAgIHN0YXRlLmZsb3dpbmcgPSBmYWxzZTtcblxuICAgIC8vIGlmIHRoZXJlIHdlcmUgZGF0YSBldmVudCBsaXN0ZW5lcnMgYWRkZWQsIHRoZW4gc3dpdGNoIHRvIG9sZCBtb2RlLlxuICAgIGlmIChFRS5saXN0ZW5lckNvdW50KHNyYywgJ2RhdGEnKSA+IDApXG4gICAgICBlbWl0RGF0YUV2ZW50cyhzcmMpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIGF0IHRoaXMgcG9pbnQsIG5vIG9uZSBuZWVkZWQgYSBkcmFpbiwgc28gd2UganVzdCByYW4gb3V0IG9mIGRhdGFcbiAgLy8gb24gdGhlIG5leHQgcmVhZGFibGUgZXZlbnQsIHN0YXJ0IGl0IG92ZXIgYWdhaW4uXG4gIHN0YXRlLnJhbk91dCA9IHRydWU7XG59XG5cbmZ1bmN0aW9uIHBpcGVPblJlYWRhYmxlKCkge1xuICBpZiAodGhpcy5fcmVhZGFibGVTdGF0ZS5yYW5PdXQpIHtcbiAgICB0aGlzLl9yZWFkYWJsZVN0YXRlLnJhbk91dCA9IGZhbHNlO1xuICAgIGZsb3codGhpcyk7XG4gIH1cbn1cblxuXG5SZWFkYWJsZS5wcm90b3R5cGUudW5waXBlID0gZnVuY3Rpb24oZGVzdCkge1xuICB2YXIgc3RhdGUgPSB0aGlzLl9yZWFkYWJsZVN0YXRlO1xuXG4gIC8vIGlmIHdlJ3JlIG5vdCBwaXBpbmcgYW55d2hlcmUsIHRoZW4gZG8gbm90aGluZy5cbiAgaWYgKHN0YXRlLnBpcGVzQ291bnQgPT09IDApXG4gICAgcmV0dXJuIHRoaXM7XG5cbiAgLy8ganVzdCBvbmUgZGVzdGluYXRpb24uICBtb3N0IGNvbW1vbiBjYXNlLlxuICBpZiAoc3RhdGUucGlwZXNDb3VudCA9PT0gMSkge1xuICAgIC8vIHBhc3NlZCBpbiBvbmUsIGJ1dCBpdCdzIG5vdCB0aGUgcmlnaHQgb25lLlxuICAgIGlmIChkZXN0ICYmIGRlc3QgIT09IHN0YXRlLnBpcGVzKVxuICAgICAgcmV0dXJuIHRoaXM7XG5cbiAgICBpZiAoIWRlc3QpXG4gICAgICBkZXN0ID0gc3RhdGUucGlwZXM7XG5cbiAgICAvLyBnb3QgYSBtYXRjaC5cbiAgICBzdGF0ZS5waXBlcyA9IG51bGw7XG4gICAgc3RhdGUucGlwZXNDb3VudCA9IDA7XG4gICAgdGhpcy5yZW1vdmVMaXN0ZW5lcigncmVhZGFibGUnLCBwaXBlT25SZWFkYWJsZSk7XG4gICAgc3RhdGUuZmxvd2luZyA9IGZhbHNlO1xuICAgIGlmIChkZXN0KVxuICAgICAgZGVzdC5lbWl0KCd1bnBpcGUnLCB0aGlzKTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8vIHNsb3cgY2FzZS4gbXVsdGlwbGUgcGlwZSBkZXN0aW5hdGlvbnMuXG5cbiAgaWYgKCFkZXN0KSB7XG4gICAgLy8gcmVtb3ZlIGFsbC5cbiAgICB2YXIgZGVzdHMgPSBzdGF0ZS5waXBlcztcbiAgICB2YXIgbGVuID0gc3RhdGUucGlwZXNDb3VudDtcbiAgICBzdGF0ZS5waXBlcyA9IG51bGw7XG4gICAgc3RhdGUucGlwZXNDb3VudCA9IDA7XG4gICAgdGhpcy5yZW1vdmVMaXN0ZW5lcigncmVhZGFibGUnLCBwaXBlT25SZWFkYWJsZSk7XG4gICAgc3RhdGUuZmxvd2luZyA9IGZhbHNlO1xuXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW47IGkrKylcbiAgICAgIGRlc3RzW2ldLmVtaXQoJ3VucGlwZScsIHRoaXMpO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLy8gdHJ5IHRvIGZpbmQgdGhlIHJpZ2h0IG9uZS5cbiAgdmFyIGkgPSBpbmRleE9mKHN0YXRlLnBpcGVzLCBkZXN0KTtcbiAgaWYgKGkgPT09IC0xKVxuICAgIHJldHVybiB0aGlzO1xuXG4gIHN0YXRlLnBpcGVzLnNwbGljZShpLCAxKTtcbiAgc3RhdGUucGlwZXNDb3VudCAtPSAxO1xuICBpZiAoc3RhdGUucGlwZXNDb3VudCA9PT0gMSlcbiAgICBzdGF0ZS5waXBlcyA9IHN0YXRlLnBpcGVzWzBdO1xuXG4gIGRlc3QuZW1pdCgndW5waXBlJywgdGhpcyk7XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG4vLyBzZXQgdXAgZGF0YSBldmVudHMgaWYgdGhleSBhcmUgYXNrZWQgZm9yXG4vLyBFbnN1cmUgcmVhZGFibGUgbGlzdGVuZXJzIGV2ZW50dWFsbHkgZ2V0IHNvbWV0aGluZ1xuUmVhZGFibGUucHJvdG90eXBlLm9uID0gZnVuY3Rpb24oZXYsIGZuKSB7XG4gIHZhciByZXMgPSBTdHJlYW0ucHJvdG90eXBlLm9uLmNhbGwodGhpcywgZXYsIGZuKTtcblxuICBpZiAoZXYgPT09ICdkYXRhJyAmJiAhdGhpcy5fcmVhZGFibGVTdGF0ZS5mbG93aW5nKVxuICAgIGVtaXREYXRhRXZlbnRzKHRoaXMpO1xuXG4gIGlmIChldiA9PT0gJ3JlYWRhYmxlJyAmJiB0aGlzLnJlYWRhYmxlKSB7XG4gICAgdmFyIHN0YXRlID0gdGhpcy5fcmVhZGFibGVTdGF0ZTtcbiAgICBpZiAoIXN0YXRlLnJlYWRhYmxlTGlzdGVuaW5nKSB7XG4gICAgICBzdGF0ZS5yZWFkYWJsZUxpc3RlbmluZyA9IHRydWU7XG4gICAgICBzdGF0ZS5lbWl0dGVkUmVhZGFibGUgPSBmYWxzZTtcbiAgICAgIHN0YXRlLm5lZWRSZWFkYWJsZSA9IHRydWU7XG4gICAgICBpZiAoIXN0YXRlLnJlYWRpbmcpIHtcbiAgICAgICAgdGhpcy5yZWFkKDApO1xuICAgICAgfSBlbHNlIGlmIChzdGF0ZS5sZW5ndGgpIHtcbiAgICAgICAgZW1pdFJlYWRhYmxlKHRoaXMsIHN0YXRlKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzO1xufTtcblJlYWRhYmxlLnByb3RvdHlwZS5hZGRMaXN0ZW5lciA9IFJlYWRhYmxlLnByb3RvdHlwZS5vbjtcblxuLy8gcGF1c2UoKSBhbmQgcmVzdW1lKCkgYXJlIHJlbW5hbnRzIG9mIHRoZSBsZWdhY3kgcmVhZGFibGUgc3RyZWFtIEFQSVxuLy8gSWYgdGhlIHVzZXIgdXNlcyB0aGVtLCB0aGVuIHN3aXRjaCBpbnRvIG9sZCBtb2RlLlxuUmVhZGFibGUucHJvdG90eXBlLnJlc3VtZSA9IGZ1bmN0aW9uKCkge1xuICBlbWl0RGF0YUV2ZW50cyh0aGlzKTtcbiAgdGhpcy5yZWFkKDApO1xuICB0aGlzLmVtaXQoJ3Jlc3VtZScpO1xufTtcblxuUmVhZGFibGUucHJvdG90eXBlLnBhdXNlID0gZnVuY3Rpb24oKSB7XG4gIGVtaXREYXRhRXZlbnRzKHRoaXMsIHRydWUpO1xuICB0aGlzLmVtaXQoJ3BhdXNlJyk7XG59O1xuXG5mdW5jdGlvbiBlbWl0RGF0YUV2ZW50cyhzdHJlYW0sIHN0YXJ0UGF1c2VkKSB7XG4gIHZhciBzdGF0ZSA9IHN0cmVhbS5fcmVhZGFibGVTdGF0ZTtcblxuICBpZiAoc3RhdGUuZmxvd2luZykge1xuICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9pc2FhY3MvcmVhZGFibGUtc3RyZWFtL2lzc3Vlcy8xNlxuICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHN3aXRjaCB0byBvbGQgbW9kZSBub3cuJyk7XG4gIH1cblxuICB2YXIgcGF1c2VkID0gc3RhcnRQYXVzZWQgfHwgZmFsc2U7XG4gIHZhciByZWFkYWJsZSA9IGZhbHNlO1xuXG4gIC8vIGNvbnZlcnQgdG8gYW4gb2xkLXN0eWxlIHN0cmVhbS5cbiAgc3RyZWFtLnJlYWRhYmxlID0gdHJ1ZTtcbiAgc3RyZWFtLnBpcGUgPSBTdHJlYW0ucHJvdG90eXBlLnBpcGU7XG4gIHN0cmVhbS5vbiA9IHN0cmVhbS5hZGRMaXN0ZW5lciA9IFN0cmVhbS5wcm90b3R5cGUub247XG5cbiAgc3RyZWFtLm9uKCdyZWFkYWJsZScsIGZ1bmN0aW9uKCkge1xuICAgIHJlYWRhYmxlID0gdHJ1ZTtcblxuICAgIHZhciBjO1xuICAgIHdoaWxlICghcGF1c2VkICYmIChudWxsICE9PSAoYyA9IHN0cmVhbS5yZWFkKCkpKSlcbiAgICAgIHN0cmVhbS5lbWl0KCdkYXRhJywgYyk7XG5cbiAgICBpZiAoYyA9PT0gbnVsbCkge1xuICAgICAgcmVhZGFibGUgPSBmYWxzZTtcbiAgICAgIHN0cmVhbS5fcmVhZGFibGVTdGF0ZS5uZWVkUmVhZGFibGUgPSB0cnVlO1xuICAgIH1cbiAgfSk7XG5cbiAgc3RyZWFtLnBhdXNlID0gZnVuY3Rpb24oKSB7XG4gICAgcGF1c2VkID0gdHJ1ZTtcbiAgICB0aGlzLmVtaXQoJ3BhdXNlJyk7XG4gIH07XG5cbiAgc3RyZWFtLnJlc3VtZSA9IGZ1bmN0aW9uKCkge1xuICAgIHBhdXNlZCA9IGZhbHNlO1xuICAgIGlmIChyZWFkYWJsZSlcbiAgICAgIHByb2Nlc3MubmV4dFRpY2soZnVuY3Rpb24oKSB7XG4gICAgICAgIHN0cmVhbS5lbWl0KCdyZWFkYWJsZScpO1xuICAgICAgfSk7XG4gICAgZWxzZVxuICAgICAgdGhpcy5yZWFkKDApO1xuICAgIHRoaXMuZW1pdCgncmVzdW1lJyk7XG4gIH07XG5cbiAgLy8gbm93IG1ha2UgaXQgc3RhcnQsIGp1c3QgaW4gY2FzZSBpdCBoYWRuJ3QgYWxyZWFkeS5cbiAgc3RyZWFtLmVtaXQoJ3JlYWRhYmxlJyk7XG59XG5cbi8vIHdyYXAgYW4gb2xkLXN0eWxlIHN0cmVhbSBhcyB0aGUgYXN5bmMgZGF0YSBzb3VyY2UuXG4vLyBUaGlzIGlzICpub3QqIHBhcnQgb2YgdGhlIHJlYWRhYmxlIHN0cmVhbSBpbnRlcmZhY2UuXG4vLyBJdCBpcyBhbiB1Z2x5IHVuZm9ydHVuYXRlIG1lc3Mgb2YgaGlzdG9yeS5cblJlYWRhYmxlLnByb3RvdHlwZS53cmFwID0gZnVuY3Rpb24oc3RyZWFtKSB7XG4gIHZhciBzdGF0ZSA9IHRoaXMuX3JlYWRhYmxlU3RhdGU7XG4gIHZhciBwYXVzZWQgPSBmYWxzZTtcblxuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHN0cmVhbS5vbignZW5kJywgZnVuY3Rpb24oKSB7XG4gICAgaWYgKHN0YXRlLmRlY29kZXIgJiYgIXN0YXRlLmVuZGVkKSB7XG4gICAgICB2YXIgY2h1bmsgPSBzdGF0ZS5kZWNvZGVyLmVuZCgpO1xuICAgICAgaWYgKGNodW5rICYmIGNodW5rLmxlbmd0aClcbiAgICAgICAgc2VsZi5wdXNoKGNodW5rKTtcbiAgICB9XG5cbiAgICBzZWxmLnB1c2gobnVsbCk7XG4gIH0pO1xuXG4gIHN0cmVhbS5vbignZGF0YScsIGZ1bmN0aW9uKGNodW5rKSB7XG4gICAgaWYgKHN0YXRlLmRlY29kZXIpXG4gICAgICBjaHVuayA9IHN0YXRlLmRlY29kZXIud3JpdGUoY2h1bmspO1xuXG4gICAgLy8gZG9uJ3Qgc2tpcCBvdmVyIGZhbHN5IHZhbHVlcyBpbiBvYmplY3RNb2RlXG4gICAgLy9pZiAoc3RhdGUub2JqZWN0TW9kZSAmJiB1dGlsLmlzTnVsbE9yVW5kZWZpbmVkKGNodW5rKSlcbiAgICBpZiAoc3RhdGUub2JqZWN0TW9kZSAmJiAoY2h1bmsgPT09IG51bGwgfHwgY2h1bmsgPT09IHVuZGVmaW5lZCkpXG4gICAgICByZXR1cm47XG4gICAgZWxzZSBpZiAoIXN0YXRlLm9iamVjdE1vZGUgJiYgKCFjaHVuayB8fCAhY2h1bmsubGVuZ3RoKSlcbiAgICAgIHJldHVybjtcblxuICAgIHZhciByZXQgPSBzZWxmLnB1c2goY2h1bmspO1xuICAgIGlmICghcmV0KSB7XG4gICAgICBwYXVzZWQgPSB0cnVlO1xuICAgICAgc3RyZWFtLnBhdXNlKCk7XG4gICAgfVxuICB9KTtcblxuICAvLyBwcm94eSBhbGwgdGhlIG90aGVyIG1ldGhvZHMuXG4gIC8vIGltcG9ydGFudCB3aGVuIHdyYXBwaW5nIGZpbHRlcnMgYW5kIGR1cGxleGVzLlxuICBmb3IgKHZhciBpIGluIHN0cmVhbSkge1xuICAgIGlmICh0eXBlb2Ygc3RyZWFtW2ldID09PSAnZnVuY3Rpb24nICYmXG4gICAgICAgIHR5cGVvZiB0aGlzW2ldID09PSAndW5kZWZpbmVkJykge1xuICAgICAgdGhpc1tpXSA9IGZ1bmN0aW9uKG1ldGhvZCkgeyByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICAgIHJldHVybiBzdHJlYW1bbWV0aG9kXS5hcHBseShzdHJlYW0sIGFyZ3VtZW50cyk7XG4gICAgICB9fShpKTtcbiAgICB9XG4gIH1cblxuICAvLyBwcm94eSBjZXJ0YWluIGltcG9ydGFudCBldmVudHMuXG4gIHZhciBldmVudHMgPSBbJ2Vycm9yJywgJ2Nsb3NlJywgJ2Rlc3Ryb3knLCAncGF1c2UnLCAncmVzdW1lJ107XG4gIGZvckVhY2goZXZlbnRzLCBmdW5jdGlvbihldikge1xuICAgIHN0cmVhbS5vbihldiwgc2VsZi5lbWl0LmJpbmQoc2VsZiwgZXYpKTtcbiAgfSk7XG5cbiAgLy8gd2hlbiB3ZSB0cnkgdG8gY29uc3VtZSBzb21lIG1vcmUgYnl0ZXMsIHNpbXBseSB1bnBhdXNlIHRoZVxuICAvLyB1bmRlcmx5aW5nIHN0cmVhbS5cbiAgc2VsZi5fcmVhZCA9IGZ1bmN0aW9uKG4pIHtcbiAgICBpZiAocGF1c2VkKSB7XG4gICAgICBwYXVzZWQgPSBmYWxzZTtcbiAgICAgIHN0cmVhbS5yZXN1bWUoKTtcbiAgICB9XG4gIH07XG5cbiAgcmV0dXJuIHNlbGY7XG59O1xuXG5cblxuLy8gZXhwb3NlZCBmb3IgdGVzdGluZyBwdXJwb3NlcyBvbmx5LlxuUmVhZGFibGUuX2Zyb21MaXN0ID0gZnJvbUxpc3Q7XG5cbi8vIFBsdWNrIG9mZiBuIGJ5dGVzIGZyb20gYW4gYXJyYXkgb2YgYnVmZmVycy5cbi8vIExlbmd0aCBpcyB0aGUgY29tYmluZWQgbGVuZ3RocyBvZiBhbGwgdGhlIGJ1ZmZlcnMgaW4gdGhlIGxpc3QuXG5mdW5jdGlvbiBmcm9tTGlzdChuLCBzdGF0ZSkge1xuICB2YXIgbGlzdCA9IHN0YXRlLmJ1ZmZlcjtcbiAgdmFyIGxlbmd0aCA9IHN0YXRlLmxlbmd0aDtcbiAgdmFyIHN0cmluZ01vZGUgPSAhIXN0YXRlLmRlY29kZXI7XG4gIHZhciBvYmplY3RNb2RlID0gISFzdGF0ZS5vYmplY3RNb2RlO1xuICB2YXIgcmV0O1xuXG4gIC8vIG5vdGhpbmcgaW4gdGhlIGxpc3QsIGRlZmluaXRlbHkgZW1wdHkuXG4gIGlmIChsaXN0Lmxlbmd0aCA9PT0gMClcbiAgICByZXR1cm4gbnVsbDtcblxuICBpZiAobGVuZ3RoID09PSAwKVxuICAgIHJldCA9IG51bGw7XG4gIGVsc2UgaWYgKG9iamVjdE1vZGUpXG4gICAgcmV0ID0gbGlzdC5zaGlmdCgpO1xuICBlbHNlIGlmICghbiB8fCBuID49IGxlbmd0aCkge1xuICAgIC8vIHJlYWQgaXQgYWxsLCB0cnVuY2F0ZSB0aGUgYXJyYXkuXG4gICAgaWYgKHN0cmluZ01vZGUpXG4gICAgICByZXQgPSBsaXN0LmpvaW4oJycpO1xuICAgIGVsc2VcbiAgICAgIHJldCA9IEJ1ZmZlci5jb25jYXQobGlzdCwgbGVuZ3RoKTtcbiAgICBsaXN0Lmxlbmd0aCA9IDA7XG4gIH0gZWxzZSB7XG4gICAgLy8gcmVhZCBqdXN0IHNvbWUgb2YgaXQuXG4gICAgaWYgKG4gPCBsaXN0WzBdLmxlbmd0aCkge1xuICAgICAgLy8ganVzdCB0YWtlIGEgcGFydCBvZiB0aGUgZmlyc3QgbGlzdCBpdGVtLlxuICAgICAgLy8gc2xpY2UgaXMgdGhlIHNhbWUgZm9yIGJ1ZmZlcnMgYW5kIHN0cmluZ3MuXG4gICAgICB2YXIgYnVmID0gbGlzdFswXTtcbiAgICAgIHJldCA9IGJ1Zi5zbGljZSgwLCBuKTtcbiAgICAgIGxpc3RbMF0gPSBidWYuc2xpY2Uobik7XG4gICAgfSBlbHNlIGlmIChuID09PSBsaXN0WzBdLmxlbmd0aCkge1xuICAgICAgLy8gZmlyc3QgbGlzdCBpcyBhIHBlcmZlY3QgbWF0Y2hcbiAgICAgIHJldCA9IGxpc3Quc2hpZnQoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gY29tcGxleCBjYXNlLlxuICAgICAgLy8gd2UgaGF2ZSBlbm91Z2ggdG8gY292ZXIgaXQsIGJ1dCBpdCBzcGFucyBwYXN0IHRoZSBmaXJzdCBidWZmZXIuXG4gICAgICBpZiAoc3RyaW5nTW9kZSlcbiAgICAgICAgcmV0ID0gJyc7XG4gICAgICBlbHNlXG4gICAgICAgIHJldCA9IG5ldyBCdWZmZXIobik7XG5cbiAgICAgIHZhciBjID0gMDtcbiAgICAgIGZvciAodmFyIGkgPSAwLCBsID0gbGlzdC5sZW5ndGg7IGkgPCBsICYmIGMgPCBuOyBpKyspIHtcbiAgICAgICAgdmFyIGJ1ZiA9IGxpc3RbMF07XG4gICAgICAgIHZhciBjcHkgPSBNYXRoLm1pbihuIC0gYywgYnVmLmxlbmd0aCk7XG5cbiAgICAgICAgaWYgKHN0cmluZ01vZGUpXG4gICAgICAgICAgcmV0ICs9IGJ1Zi5zbGljZSgwLCBjcHkpO1xuICAgICAgICBlbHNlXG4gICAgICAgICAgYnVmLmNvcHkocmV0LCBjLCAwLCBjcHkpO1xuXG4gICAgICAgIGlmIChjcHkgPCBidWYubGVuZ3RoKVxuICAgICAgICAgIGxpc3RbMF0gPSBidWYuc2xpY2UoY3B5KTtcbiAgICAgICAgZWxzZVxuICAgICAgICAgIGxpc3Quc2hpZnQoKTtcblxuICAgICAgICBjICs9IGNweTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmV0O1xufVxuXG5mdW5jdGlvbiBlbmRSZWFkYWJsZShzdHJlYW0pIHtcbiAgdmFyIHN0YXRlID0gc3RyZWFtLl9yZWFkYWJsZVN0YXRlO1xuXG4gIC8vIElmIHdlIGdldCBoZXJlIGJlZm9yZSBjb25zdW1pbmcgYWxsIHRoZSBieXRlcywgdGhlbiB0aGF0IGlzIGFcbiAgLy8gYnVnIGluIG5vZGUuICBTaG91bGQgbmV2ZXIgaGFwcGVuLlxuICBpZiAoc3RhdGUubGVuZ3RoID4gMClcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ2VuZFJlYWRhYmxlIGNhbGxlZCBvbiBub24tZW1wdHkgc3RyZWFtJyk7XG5cbiAgaWYgKCFzdGF0ZS5lbmRFbWl0dGVkICYmIHN0YXRlLmNhbGxlZFJlYWQpIHtcbiAgICBzdGF0ZS5lbmRlZCA9IHRydWU7XG4gICAgcHJvY2Vzcy5uZXh0VGljayhmdW5jdGlvbigpIHtcbiAgICAgIC8vIENoZWNrIHRoYXQgd2UgZGlkbid0IGdldCBvbmUgbGFzdCB1bnNoaWZ0LlxuICAgICAgaWYgKCFzdGF0ZS5lbmRFbWl0dGVkICYmIHN0YXRlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBzdGF0ZS5lbmRFbWl0dGVkID0gdHJ1ZTtcbiAgICAgICAgc3RyZWFtLnJlYWRhYmxlID0gZmFsc2U7XG4gICAgICAgIHN0cmVhbS5lbWl0KCdlbmQnKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBmb3JFYWNoICh4cywgZikge1xuICBmb3IgKHZhciBpID0gMCwgbCA9IHhzLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgIGYoeHNbaV0sIGkpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGluZGV4T2YgKHhzLCB4KSB7XG4gIGZvciAodmFyIGkgPSAwLCBsID0geHMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgaWYgKHhzW2ldID09PSB4KSByZXR1cm4gaTtcbiAgfVxuICByZXR1cm4gLTE7XG59XG5cbn0pLmNhbGwodGhpcyxyZXF1aXJlKCdfcHJvY2VzcycpKSIsIi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG5cbi8vIGEgdHJhbnNmb3JtIHN0cmVhbSBpcyBhIHJlYWRhYmxlL3dyaXRhYmxlIHN0cmVhbSB3aGVyZSB5b3UgZG9cbi8vIHNvbWV0aGluZyB3aXRoIHRoZSBkYXRhLiAgU29tZXRpbWVzIGl0J3MgY2FsbGVkIGEgXCJmaWx0ZXJcIixcbi8vIGJ1dCB0aGF0J3Mgbm90IGEgZ3JlYXQgbmFtZSBmb3IgaXQsIHNpbmNlIHRoYXQgaW1wbGllcyBhIHRoaW5nIHdoZXJlXG4vLyBzb21lIGJpdHMgcGFzcyB0aHJvdWdoLCBhbmQgb3RoZXJzIGFyZSBzaW1wbHkgaWdub3JlZC4gIChUaGF0IHdvdWxkXG4vLyBiZSBhIHZhbGlkIGV4YW1wbGUgb2YgYSB0cmFuc2Zvcm0sIG9mIGNvdXJzZS4pXG4vL1xuLy8gV2hpbGUgdGhlIG91dHB1dCBpcyBjYXVzYWxseSByZWxhdGVkIHRvIHRoZSBpbnB1dCwgaXQncyBub3QgYVxuLy8gbmVjZXNzYXJpbHkgc3ltbWV0cmljIG9yIHN5bmNocm9ub3VzIHRyYW5zZm9ybWF0aW9uLiAgRm9yIGV4YW1wbGUsXG4vLyBhIHpsaWIgc3RyZWFtIG1pZ2h0IHRha2UgbXVsdGlwbGUgcGxhaW4tdGV4dCB3cml0ZXMoKSwgYW5kIHRoZW5cbi8vIGVtaXQgYSBzaW5nbGUgY29tcHJlc3NlZCBjaHVuayBzb21lIHRpbWUgaW4gdGhlIGZ1dHVyZS5cbi8vXG4vLyBIZXJlJ3MgaG93IHRoaXMgd29ya3M6XG4vL1xuLy8gVGhlIFRyYW5zZm9ybSBzdHJlYW0gaGFzIGFsbCB0aGUgYXNwZWN0cyBvZiB0aGUgcmVhZGFibGUgYW5kIHdyaXRhYmxlXG4vLyBzdHJlYW0gY2xhc3Nlcy4gIFdoZW4geW91IHdyaXRlKGNodW5rKSwgdGhhdCBjYWxscyBfd3JpdGUoY2h1bmssY2IpXG4vLyBpbnRlcm5hbGx5LCBhbmQgcmV0dXJucyBmYWxzZSBpZiB0aGVyZSdzIGEgbG90IG9mIHBlbmRpbmcgd3JpdGVzXG4vLyBidWZmZXJlZCB1cC4gIFdoZW4geW91IGNhbGwgcmVhZCgpLCB0aGF0IGNhbGxzIF9yZWFkKG4pIHVudGlsXG4vLyB0aGVyZSdzIGVub3VnaCBwZW5kaW5nIHJlYWRhYmxlIGRhdGEgYnVmZmVyZWQgdXAuXG4vL1xuLy8gSW4gYSB0cmFuc2Zvcm0gc3RyZWFtLCB0aGUgd3JpdHRlbiBkYXRhIGlzIHBsYWNlZCBpbiBhIGJ1ZmZlci4gIFdoZW5cbi8vIF9yZWFkKG4pIGlzIGNhbGxlZCwgaXQgdHJhbnNmb3JtcyB0aGUgcXVldWVkIHVwIGRhdGEsIGNhbGxpbmcgdGhlXG4vLyBidWZmZXJlZCBfd3JpdGUgY2IncyBhcyBpdCBjb25zdW1lcyBjaHVua3MuICBJZiBjb25zdW1pbmcgYSBzaW5nbGVcbi8vIHdyaXR0ZW4gY2h1bmsgd291bGQgcmVzdWx0IGluIG11bHRpcGxlIG91dHB1dCBjaHVua3MsIHRoZW4gdGhlIGZpcnN0XG4vLyBvdXRwdXR0ZWQgYml0IGNhbGxzIHRoZSByZWFkY2IsIGFuZCBzdWJzZXF1ZW50IGNodW5rcyBqdXN0IGdvIGludG9cbi8vIHRoZSByZWFkIGJ1ZmZlciwgYW5kIHdpbGwgY2F1c2UgaXQgdG8gZW1pdCAncmVhZGFibGUnIGlmIG5lY2Vzc2FyeS5cbi8vXG4vLyBUaGlzIHdheSwgYmFjay1wcmVzc3VyZSBpcyBhY3R1YWxseSBkZXRlcm1pbmVkIGJ5IHRoZSByZWFkaW5nIHNpZGUsXG4vLyBzaW5jZSBfcmVhZCBoYXMgdG8gYmUgY2FsbGVkIHRvIHN0YXJ0IHByb2Nlc3NpbmcgYSBuZXcgY2h1bmsuICBIb3dldmVyLFxuLy8gYSBwYXRob2xvZ2ljYWwgaW5mbGF0ZSB0eXBlIG9mIHRyYW5zZm9ybSBjYW4gY2F1c2UgZXhjZXNzaXZlIGJ1ZmZlcmluZ1xuLy8gaGVyZS4gIEZvciBleGFtcGxlLCBpbWFnaW5lIGEgc3RyZWFtIHdoZXJlIGV2ZXJ5IGJ5dGUgb2YgaW5wdXQgaXNcbi8vIGludGVycHJldGVkIGFzIGFuIGludGVnZXIgZnJvbSAwLTI1NSwgYW5kIHRoZW4gcmVzdWx0cyBpbiB0aGF0IG1hbnlcbi8vIGJ5dGVzIG9mIG91dHB1dC4gIFdyaXRpbmcgdGhlIDQgYnl0ZXMge2ZmLGZmLGZmLGZmfSB3b3VsZCByZXN1bHQgaW5cbi8vIDFrYiBvZiBkYXRhIGJlaW5nIG91dHB1dC4gIEluIHRoaXMgY2FzZSwgeW91IGNvdWxkIHdyaXRlIGEgdmVyeSBzbWFsbFxuLy8gYW1vdW50IG9mIGlucHV0LCBhbmQgZW5kIHVwIHdpdGggYSB2ZXJ5IGxhcmdlIGFtb3VudCBvZiBvdXRwdXQuICBJblxuLy8gc3VjaCBhIHBhdGhvbG9naWNhbCBpbmZsYXRpbmcgbWVjaGFuaXNtLCB0aGVyZSdkIGJlIG5vIHdheSB0byB0ZWxsXG4vLyB0aGUgc3lzdGVtIHRvIHN0b3AgZG9pbmcgdGhlIHRyYW5zZm9ybS4gIEEgc2luZ2xlIDRNQiB3cml0ZSBjb3VsZFxuLy8gY2F1c2UgdGhlIHN5c3RlbSB0byBydW4gb3V0IG9mIG1lbW9yeS5cbi8vXG4vLyBIb3dldmVyLCBldmVuIGluIHN1Y2ggYSBwYXRob2xvZ2ljYWwgY2FzZSwgb25seSBhIHNpbmdsZSB3cml0dGVuIGNodW5rXG4vLyB3b3VsZCBiZSBjb25zdW1lZCwgYW5kIHRoZW4gdGhlIHJlc3Qgd291bGQgd2FpdCAodW4tdHJhbnNmb3JtZWQpIHVudGlsXG4vLyB0aGUgcmVzdWx0cyBvZiB0aGUgcHJldmlvdXMgdHJhbnNmb3JtZWQgY2h1bmsgd2VyZSBjb25zdW1lZC5cblxubW9kdWxlLmV4cG9ydHMgPSBUcmFuc2Zvcm07XG5cbnZhciBEdXBsZXggPSByZXF1aXJlKCcuL19zdHJlYW1fZHVwbGV4Jyk7XG5cbi8qPHJlcGxhY2VtZW50PiovXG52YXIgdXRpbCA9IHJlcXVpcmUoJ2NvcmUtdXRpbC1pcycpO1xudXRpbC5pbmhlcml0cyA9IHJlcXVpcmUoJ2luaGVyaXRzJyk7XG4vKjwvcmVwbGFjZW1lbnQ+Ki9cblxudXRpbC5pbmhlcml0cyhUcmFuc2Zvcm0sIER1cGxleCk7XG5cblxuZnVuY3Rpb24gVHJhbnNmb3JtU3RhdGUob3B0aW9ucywgc3RyZWFtKSB7XG4gIHRoaXMuYWZ0ZXJUcmFuc2Zvcm0gPSBmdW5jdGlvbihlciwgZGF0YSkge1xuICAgIHJldHVybiBhZnRlclRyYW5zZm9ybShzdHJlYW0sIGVyLCBkYXRhKTtcbiAgfTtcblxuICB0aGlzLm5lZWRUcmFuc2Zvcm0gPSBmYWxzZTtcbiAgdGhpcy50cmFuc2Zvcm1pbmcgPSBmYWxzZTtcbiAgdGhpcy53cml0ZWNiID0gbnVsbDtcbiAgdGhpcy53cml0ZWNodW5rID0gbnVsbDtcbn1cblxuZnVuY3Rpb24gYWZ0ZXJUcmFuc2Zvcm0oc3RyZWFtLCBlciwgZGF0YSkge1xuICB2YXIgdHMgPSBzdHJlYW0uX3RyYW5zZm9ybVN0YXRlO1xuICB0cy50cmFuc2Zvcm1pbmcgPSBmYWxzZTtcblxuICB2YXIgY2IgPSB0cy53cml0ZWNiO1xuXG4gIGlmICghY2IpXG4gICAgcmV0dXJuIHN0cmVhbS5lbWl0KCdlcnJvcicsIG5ldyBFcnJvcignbm8gd3JpdGVjYiBpbiBUcmFuc2Zvcm0gY2xhc3MnKSk7XG5cbiAgdHMud3JpdGVjaHVuayA9IG51bGw7XG4gIHRzLndyaXRlY2IgPSBudWxsO1xuXG4gIGlmIChkYXRhICE9PSBudWxsICYmIGRhdGEgIT09IHVuZGVmaW5lZClcbiAgICBzdHJlYW0ucHVzaChkYXRhKTtcblxuICBpZiAoY2IpXG4gICAgY2IoZXIpO1xuXG4gIHZhciBycyA9IHN0cmVhbS5fcmVhZGFibGVTdGF0ZTtcbiAgcnMucmVhZGluZyA9IGZhbHNlO1xuICBpZiAocnMubmVlZFJlYWRhYmxlIHx8IHJzLmxlbmd0aCA8IHJzLmhpZ2hXYXRlck1hcmspIHtcbiAgICBzdHJlYW0uX3JlYWQocnMuaGlnaFdhdGVyTWFyayk7XG4gIH1cbn1cblxuXG5mdW5jdGlvbiBUcmFuc2Zvcm0ob3B0aW9ucykge1xuICBpZiAoISh0aGlzIGluc3RhbmNlb2YgVHJhbnNmb3JtKSlcbiAgICByZXR1cm4gbmV3IFRyYW5zZm9ybShvcHRpb25zKTtcblxuICBEdXBsZXguY2FsbCh0aGlzLCBvcHRpb25zKTtcblxuICB2YXIgdHMgPSB0aGlzLl90cmFuc2Zvcm1TdGF0ZSA9IG5ldyBUcmFuc2Zvcm1TdGF0ZShvcHRpb25zLCB0aGlzKTtcblxuICAvLyB3aGVuIHRoZSB3cml0YWJsZSBzaWRlIGZpbmlzaGVzLCB0aGVuIGZsdXNoIG91dCBhbnl0aGluZyByZW1haW5pbmcuXG4gIHZhciBzdHJlYW0gPSB0aGlzO1xuXG4gIC8vIHN0YXJ0IG91dCBhc2tpbmcgZm9yIGEgcmVhZGFibGUgZXZlbnQgb25jZSBkYXRhIGlzIHRyYW5zZm9ybWVkLlxuICB0aGlzLl9yZWFkYWJsZVN0YXRlLm5lZWRSZWFkYWJsZSA9IHRydWU7XG5cbiAgLy8gd2UgaGF2ZSBpbXBsZW1lbnRlZCB0aGUgX3JlYWQgbWV0aG9kLCBhbmQgZG9uZSB0aGUgb3RoZXIgdGhpbmdzXG4gIC8vIHRoYXQgUmVhZGFibGUgd2FudHMgYmVmb3JlIHRoZSBmaXJzdCBfcmVhZCBjYWxsLCBzbyB1bnNldCB0aGVcbiAgLy8gc3luYyBndWFyZCBmbGFnLlxuICB0aGlzLl9yZWFkYWJsZVN0YXRlLnN5bmMgPSBmYWxzZTtcblxuICB0aGlzLm9uY2UoJ2ZpbmlzaCcsIGZ1bmN0aW9uKCkge1xuICAgIGlmICgnZnVuY3Rpb24nID09PSB0eXBlb2YgdGhpcy5fZmx1c2gpXG4gICAgICB0aGlzLl9mbHVzaChmdW5jdGlvbihlcikge1xuICAgICAgICBkb25lKHN0cmVhbSwgZXIpO1xuICAgICAgfSk7XG4gICAgZWxzZVxuICAgICAgZG9uZShzdHJlYW0pO1xuICB9KTtcbn1cblxuVHJhbnNmb3JtLnByb3RvdHlwZS5wdXNoID0gZnVuY3Rpb24oY2h1bmssIGVuY29kaW5nKSB7XG4gIHRoaXMuX3RyYW5zZm9ybVN0YXRlLm5lZWRUcmFuc2Zvcm0gPSBmYWxzZTtcbiAgcmV0dXJuIER1cGxleC5wcm90b3R5cGUucHVzaC5jYWxsKHRoaXMsIGNodW5rLCBlbmNvZGluZyk7XG59O1xuXG4vLyBUaGlzIGlzIHRoZSBwYXJ0IHdoZXJlIHlvdSBkbyBzdHVmZiFcbi8vIG92ZXJyaWRlIHRoaXMgZnVuY3Rpb24gaW4gaW1wbGVtZW50YXRpb24gY2xhc3Nlcy5cbi8vICdjaHVuaycgaXMgYW4gaW5wdXQgY2h1bmsuXG4vL1xuLy8gQ2FsbCBgcHVzaChuZXdDaHVuaylgIHRvIHBhc3MgYWxvbmcgdHJhbnNmb3JtZWQgb3V0cHV0XG4vLyB0byB0aGUgcmVhZGFibGUgc2lkZS4gIFlvdSBtYXkgY2FsbCAncHVzaCcgemVybyBvciBtb3JlIHRpbWVzLlxuLy9cbi8vIENhbGwgYGNiKGVycilgIHdoZW4geW91IGFyZSBkb25lIHdpdGggdGhpcyBjaHVuay4gIElmIHlvdSBwYXNzXG4vLyBhbiBlcnJvciwgdGhlbiB0aGF0J2xsIHB1dCB0aGUgaHVydCBvbiB0aGUgd2hvbGUgb3BlcmF0aW9uLiAgSWYgeW91XG4vLyBuZXZlciBjYWxsIGNiKCksIHRoZW4geW91J2xsIG5ldmVyIGdldCBhbm90aGVyIGNodW5rLlxuVHJhbnNmb3JtLnByb3RvdHlwZS5fdHJhbnNmb3JtID0gZnVuY3Rpb24oY2h1bmssIGVuY29kaW5nLCBjYikge1xuICB0aHJvdyBuZXcgRXJyb3IoJ25vdCBpbXBsZW1lbnRlZCcpO1xufTtcblxuVHJhbnNmb3JtLnByb3RvdHlwZS5fd3JpdGUgPSBmdW5jdGlvbihjaHVuaywgZW5jb2RpbmcsIGNiKSB7XG4gIHZhciB0cyA9IHRoaXMuX3RyYW5zZm9ybVN0YXRlO1xuICB0cy53cml0ZWNiID0gY2I7XG4gIHRzLndyaXRlY2h1bmsgPSBjaHVuaztcbiAgdHMud3JpdGVlbmNvZGluZyA9IGVuY29kaW5nO1xuICBpZiAoIXRzLnRyYW5zZm9ybWluZykge1xuICAgIHZhciBycyA9IHRoaXMuX3JlYWRhYmxlU3RhdGU7XG4gICAgaWYgKHRzLm5lZWRUcmFuc2Zvcm0gfHxcbiAgICAgICAgcnMubmVlZFJlYWRhYmxlIHx8XG4gICAgICAgIHJzLmxlbmd0aCA8IHJzLmhpZ2hXYXRlck1hcmspXG4gICAgICB0aGlzLl9yZWFkKHJzLmhpZ2hXYXRlck1hcmspO1xuICB9XG59O1xuXG4vLyBEb2Vzbid0IG1hdHRlciB3aGF0IHRoZSBhcmdzIGFyZSBoZXJlLlxuLy8gX3RyYW5zZm9ybSBkb2VzIGFsbCB0aGUgd29yay5cbi8vIFRoYXQgd2UgZ290IGhlcmUgbWVhbnMgdGhhdCB0aGUgcmVhZGFibGUgc2lkZSB3YW50cyBtb3JlIGRhdGEuXG5UcmFuc2Zvcm0ucHJvdG90eXBlLl9yZWFkID0gZnVuY3Rpb24obikge1xuICB2YXIgdHMgPSB0aGlzLl90cmFuc2Zvcm1TdGF0ZTtcblxuICBpZiAodHMud3JpdGVjaHVuayAhPT0gbnVsbCAmJiB0cy53cml0ZWNiICYmICF0cy50cmFuc2Zvcm1pbmcpIHtcbiAgICB0cy50cmFuc2Zvcm1pbmcgPSB0cnVlO1xuICAgIHRoaXMuX3RyYW5zZm9ybSh0cy53cml0ZWNodW5rLCB0cy53cml0ZWVuY29kaW5nLCB0cy5hZnRlclRyYW5zZm9ybSk7XG4gIH0gZWxzZSB7XG4gICAgLy8gbWFyayB0aGF0IHdlIG5lZWQgYSB0cmFuc2Zvcm0sIHNvIHRoYXQgYW55IGRhdGEgdGhhdCBjb21lcyBpblxuICAgIC8vIHdpbGwgZ2V0IHByb2Nlc3NlZCwgbm93IHRoYXQgd2UndmUgYXNrZWQgZm9yIGl0LlxuICAgIHRzLm5lZWRUcmFuc2Zvcm0gPSB0cnVlO1xuICB9XG59O1xuXG5cbmZ1bmN0aW9uIGRvbmUoc3RyZWFtLCBlcikge1xuICBpZiAoZXIpXG4gICAgcmV0dXJuIHN0cmVhbS5lbWl0KCdlcnJvcicsIGVyKTtcblxuICAvLyBpZiB0aGVyZSdzIG5vdGhpbmcgaW4gdGhlIHdyaXRlIGJ1ZmZlciwgdGhlbiB0aGF0IG1lYW5zXG4gIC8vIHRoYXQgbm90aGluZyBtb3JlIHdpbGwgZXZlciBiZSBwcm92aWRlZFxuICB2YXIgd3MgPSBzdHJlYW0uX3dyaXRhYmxlU3RhdGU7XG4gIHZhciBycyA9IHN0cmVhbS5fcmVhZGFibGVTdGF0ZTtcbiAgdmFyIHRzID0gc3RyZWFtLl90cmFuc2Zvcm1TdGF0ZTtcblxuICBpZiAod3MubGVuZ3RoKVxuICAgIHRocm93IG5ldyBFcnJvcignY2FsbGluZyB0cmFuc2Zvcm0gZG9uZSB3aGVuIHdzLmxlbmd0aCAhPSAwJyk7XG5cbiAgaWYgKHRzLnRyYW5zZm9ybWluZylcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ2NhbGxpbmcgdHJhbnNmb3JtIGRvbmUgd2hlbiBzdGlsbCB0cmFuc2Zvcm1pbmcnKTtcblxuICByZXR1cm4gc3RyZWFtLnB1c2gobnVsbCk7XG59XG4iLCIoZnVuY3Rpb24gKHByb2Nlc3Mpe1xuLy8gQ29weXJpZ2h0IEpveWVudCwgSW5jLiBhbmQgb3RoZXIgTm9kZSBjb250cmlidXRvcnMuXG4vL1xuLy8gUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGFcbi8vIGNvcHkgb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGVcbi8vIFwiU29mdHdhcmVcIiksIHRvIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZ1xuLy8gd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLFxuLy8gZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdFxuLy8gcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlXG4vLyBmb2xsb3dpbmcgY29uZGl0aW9uczpcbi8vXG4vLyBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZFxuLy8gaW4gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4vL1xuLy8gVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTU1xuLy8gT1IgSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRlxuLy8gTUVSQ0hBTlRBQklMSVRZLCBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTlxuLy8gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sXG4vLyBEQU1BR0VTIE9SIE9USEVSIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1Jcbi8vIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLCBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEVcbi8vIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuXG5cbi8vIEEgYml0IHNpbXBsZXIgdGhhbiByZWFkYWJsZSBzdHJlYW1zLlxuLy8gSW1wbGVtZW50IGFuIGFzeW5jIC5fd3JpdGUoY2h1bmssIGNiKSwgYW5kIGl0J2xsIGhhbmRsZSBhbGxcbi8vIHRoZSBkcmFpbiBldmVudCBlbWlzc2lvbiBhbmQgYnVmZmVyaW5nLlxuXG5tb2R1bGUuZXhwb3J0cyA9IFdyaXRhYmxlO1xuXG4vKjxyZXBsYWNlbWVudD4qL1xudmFyIEJ1ZmZlciA9IHJlcXVpcmUoJ2J1ZmZlcicpLkJ1ZmZlcjtcbi8qPC9yZXBsYWNlbWVudD4qL1xuXG5Xcml0YWJsZS5Xcml0YWJsZVN0YXRlID0gV3JpdGFibGVTdGF0ZTtcblxuXG4vKjxyZXBsYWNlbWVudD4qL1xudmFyIHV0aWwgPSByZXF1aXJlKCdjb3JlLXV0aWwtaXMnKTtcbnV0aWwuaW5oZXJpdHMgPSByZXF1aXJlKCdpbmhlcml0cycpO1xuLyo8L3JlcGxhY2VtZW50PiovXG5cbnZhciBTdHJlYW0gPSByZXF1aXJlKCdzdHJlYW0nKTtcblxudXRpbC5pbmhlcml0cyhXcml0YWJsZSwgU3RyZWFtKTtcblxuZnVuY3Rpb24gV3JpdGVSZXEoY2h1bmssIGVuY29kaW5nLCBjYikge1xuICB0aGlzLmNodW5rID0gY2h1bms7XG4gIHRoaXMuZW5jb2RpbmcgPSBlbmNvZGluZztcbiAgdGhpcy5jYWxsYmFjayA9IGNiO1xufVxuXG5mdW5jdGlvbiBXcml0YWJsZVN0YXRlKG9wdGlvbnMsIHN0cmVhbSkge1xuICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcblxuICAvLyB0aGUgcG9pbnQgYXQgd2hpY2ggd3JpdGUoKSBzdGFydHMgcmV0dXJuaW5nIGZhbHNlXG4gIC8vIE5vdGU6IDAgaXMgYSB2YWxpZCB2YWx1ZSwgbWVhbnMgdGhhdCB3ZSBhbHdheXMgcmV0dXJuIGZhbHNlIGlmXG4gIC8vIHRoZSBlbnRpcmUgYnVmZmVyIGlzIG5vdCBmbHVzaGVkIGltbWVkaWF0ZWx5IG9uIHdyaXRlKClcbiAgdmFyIGh3bSA9IG9wdGlvbnMuaGlnaFdhdGVyTWFyaztcbiAgdGhpcy5oaWdoV2F0ZXJNYXJrID0gKGh3bSB8fCBod20gPT09IDApID8gaHdtIDogMTYgKiAxMDI0O1xuXG4gIC8vIG9iamVjdCBzdHJlYW0gZmxhZyB0byBpbmRpY2F0ZSB3aGV0aGVyIG9yIG5vdCB0aGlzIHN0cmVhbVxuICAvLyBjb250YWlucyBidWZmZXJzIG9yIG9iamVjdHMuXG4gIHRoaXMub2JqZWN0TW9kZSA9ICEhb3B0aW9ucy5vYmplY3RNb2RlO1xuXG4gIC8vIGNhc3QgdG8gaW50cy5cbiAgdGhpcy5oaWdoV2F0ZXJNYXJrID0gfn50aGlzLmhpZ2hXYXRlck1hcms7XG5cbiAgdGhpcy5uZWVkRHJhaW4gPSBmYWxzZTtcbiAgLy8gYXQgdGhlIHN0YXJ0IG9mIGNhbGxpbmcgZW5kKClcbiAgdGhpcy5lbmRpbmcgPSBmYWxzZTtcbiAgLy8gd2hlbiBlbmQoKSBoYXMgYmVlbiBjYWxsZWQsIGFuZCByZXR1cm5lZFxuICB0aGlzLmVuZGVkID0gZmFsc2U7XG4gIC8vIHdoZW4gJ2ZpbmlzaCcgaXMgZW1pdHRlZFxuICB0aGlzLmZpbmlzaGVkID0gZmFsc2U7XG5cbiAgLy8gc2hvdWxkIHdlIGRlY29kZSBzdHJpbmdzIGludG8gYnVmZmVycyBiZWZvcmUgcGFzc2luZyB0byBfd3JpdGU/XG4gIC8vIHRoaXMgaXMgaGVyZSBzbyB0aGF0IHNvbWUgbm9kZS1jb3JlIHN0cmVhbXMgY2FuIG9wdGltaXplIHN0cmluZ1xuICAvLyBoYW5kbGluZyBhdCBhIGxvd2VyIGxldmVsLlxuICB2YXIgbm9EZWNvZGUgPSBvcHRpb25zLmRlY29kZVN0cmluZ3MgPT09IGZhbHNlO1xuICB0aGlzLmRlY29kZVN0cmluZ3MgPSAhbm9EZWNvZGU7XG5cbiAgLy8gQ3J5cHRvIGlzIGtpbmQgb2Ygb2xkIGFuZCBjcnVzdHkuICBIaXN0b3JpY2FsbHksIGl0cyBkZWZhdWx0IHN0cmluZ1xuICAvLyBlbmNvZGluZyBpcyAnYmluYXJ5JyBzbyB3ZSBoYXZlIHRvIG1ha2UgdGhpcyBjb25maWd1cmFibGUuXG4gIC8vIEV2ZXJ5dGhpbmcgZWxzZSBpbiB0aGUgdW5pdmVyc2UgdXNlcyAndXRmOCcsIHRob3VnaC5cbiAgdGhpcy5kZWZhdWx0RW5jb2RpbmcgPSBvcHRpb25zLmRlZmF1bHRFbmNvZGluZyB8fCAndXRmOCc7XG5cbiAgLy8gbm90IGFuIGFjdHVhbCBidWZmZXIgd2Uga2VlcCB0cmFjayBvZiwgYnV0IGEgbWVhc3VyZW1lbnRcbiAgLy8gb2YgaG93IG11Y2ggd2UncmUgd2FpdGluZyB0byBnZXQgcHVzaGVkIHRvIHNvbWUgdW5kZXJseWluZ1xuICAvLyBzb2NrZXQgb3IgZmlsZS5cbiAgdGhpcy5sZW5ndGggPSAwO1xuXG4gIC8vIGEgZmxhZyB0byBzZWUgd2hlbiB3ZSdyZSBpbiB0aGUgbWlkZGxlIG9mIGEgd3JpdGUuXG4gIHRoaXMud3JpdGluZyA9IGZhbHNlO1xuXG4gIC8vIGEgZmxhZyB0byBiZSBhYmxlIHRvIHRlbGwgaWYgdGhlIG9ud3JpdGUgY2IgaXMgY2FsbGVkIGltbWVkaWF0ZWx5LFxuICAvLyBvciBvbiBhIGxhdGVyIHRpY2suICBXZSBzZXQgdGhpcyB0byB0cnVlIGF0IGZpcnN0LCBiZWN1YXNlIGFueVxuICAvLyBhY3Rpb25zIHRoYXQgc2hvdWxkbid0IGhhcHBlbiB1bnRpbCBcImxhdGVyXCIgc2hvdWxkIGdlbmVyYWxseSBhbHNvXG4gIC8vIG5vdCBoYXBwZW4gYmVmb3JlIHRoZSBmaXJzdCB3cml0ZSBjYWxsLlxuICB0aGlzLnN5bmMgPSB0cnVlO1xuXG4gIC8vIGEgZmxhZyB0byBrbm93IGlmIHdlJ3JlIHByb2Nlc3NpbmcgcHJldmlvdXNseSBidWZmZXJlZCBpdGVtcywgd2hpY2hcbiAgLy8gbWF5IGNhbGwgdGhlIF93cml0ZSgpIGNhbGxiYWNrIGluIHRoZSBzYW1lIHRpY2ssIHNvIHRoYXQgd2UgZG9uJ3RcbiAgLy8gZW5kIHVwIGluIGFuIG92ZXJsYXBwZWQgb253cml0ZSBzaXR1YXRpb24uXG4gIHRoaXMuYnVmZmVyUHJvY2Vzc2luZyA9IGZhbHNlO1xuXG4gIC8vIHRoZSBjYWxsYmFjayB0aGF0J3MgcGFzc2VkIHRvIF93cml0ZShjaHVuayxjYilcbiAgdGhpcy5vbndyaXRlID0gZnVuY3Rpb24oZXIpIHtcbiAgICBvbndyaXRlKHN0cmVhbSwgZXIpO1xuICB9O1xuXG4gIC8vIHRoZSBjYWxsYmFjayB0aGF0IHRoZSB1c2VyIHN1cHBsaWVzIHRvIHdyaXRlKGNodW5rLGVuY29kaW5nLGNiKVxuICB0aGlzLndyaXRlY2IgPSBudWxsO1xuXG4gIC8vIHRoZSBhbW91bnQgdGhhdCBpcyBiZWluZyB3cml0dGVuIHdoZW4gX3dyaXRlIGlzIGNhbGxlZC5cbiAgdGhpcy53cml0ZWxlbiA9IDA7XG5cbiAgdGhpcy5idWZmZXIgPSBbXTtcblxuICAvLyBUcnVlIGlmIHRoZSBlcnJvciB3YXMgYWxyZWFkeSBlbWl0dGVkIGFuZCBzaG91bGQgbm90IGJlIHRocm93biBhZ2FpblxuICB0aGlzLmVycm9yRW1pdHRlZCA9IGZhbHNlO1xufVxuXG5mdW5jdGlvbiBXcml0YWJsZShvcHRpb25zKSB7XG4gIHZhciBEdXBsZXggPSByZXF1aXJlKCcuL19zdHJlYW1fZHVwbGV4Jyk7XG5cbiAgLy8gV3JpdGFibGUgY3RvciBpcyBhcHBsaWVkIHRvIER1cGxleGVzLCB0aG91Z2ggdGhleSdyZSBub3RcbiAgLy8gaW5zdGFuY2VvZiBXcml0YWJsZSwgdGhleSdyZSBpbnN0YW5jZW9mIFJlYWRhYmxlLlxuICBpZiAoISh0aGlzIGluc3RhbmNlb2YgV3JpdGFibGUpICYmICEodGhpcyBpbnN0YW5jZW9mIER1cGxleCkpXG4gICAgcmV0dXJuIG5ldyBXcml0YWJsZShvcHRpb25zKTtcblxuICB0aGlzLl93cml0YWJsZVN0YXRlID0gbmV3IFdyaXRhYmxlU3RhdGUob3B0aW9ucywgdGhpcyk7XG5cbiAgLy8gbGVnYWN5LlxuICB0aGlzLndyaXRhYmxlID0gdHJ1ZTtcblxuICBTdHJlYW0uY2FsbCh0aGlzKTtcbn1cblxuLy8gT3RoZXJ3aXNlIHBlb3BsZSBjYW4gcGlwZSBXcml0YWJsZSBzdHJlYW1zLCB3aGljaCBpcyBqdXN0IHdyb25nLlxuV3JpdGFibGUucHJvdG90eXBlLnBpcGUgPSBmdW5jdGlvbigpIHtcbiAgdGhpcy5lbWl0KCdlcnJvcicsIG5ldyBFcnJvcignQ2Fubm90IHBpcGUuIE5vdCByZWFkYWJsZS4nKSk7XG59O1xuXG5cbmZ1bmN0aW9uIHdyaXRlQWZ0ZXJFbmQoc3RyZWFtLCBzdGF0ZSwgY2IpIHtcbiAgdmFyIGVyID0gbmV3IEVycm9yKCd3cml0ZSBhZnRlciBlbmQnKTtcbiAgLy8gVE9ETzogZGVmZXIgZXJyb3IgZXZlbnRzIGNvbnNpc3RlbnRseSBldmVyeXdoZXJlLCBub3QganVzdCB0aGUgY2JcbiAgc3RyZWFtLmVtaXQoJ2Vycm9yJywgZXIpO1xuICBwcm9jZXNzLm5leHRUaWNrKGZ1bmN0aW9uKCkge1xuICAgIGNiKGVyKTtcbiAgfSk7XG59XG5cbi8vIElmIHdlIGdldCBzb21ldGhpbmcgdGhhdCBpcyBub3QgYSBidWZmZXIsIHN0cmluZywgbnVsbCwgb3IgdW5kZWZpbmVkLFxuLy8gYW5kIHdlJ3JlIG5vdCBpbiBvYmplY3RNb2RlLCB0aGVuIHRoYXQncyBhbiBlcnJvci5cbi8vIE90aGVyd2lzZSBzdHJlYW0gY2h1bmtzIGFyZSBhbGwgY29uc2lkZXJlZCB0byBiZSBvZiBsZW5ndGg9MSwgYW5kIHRoZVxuLy8gd2F0ZXJtYXJrcyBkZXRlcm1pbmUgaG93IG1hbnkgb2JqZWN0cyB0byBrZWVwIGluIHRoZSBidWZmZXIsIHJhdGhlciB0aGFuXG4vLyBob3cgbWFueSBieXRlcyBvciBjaGFyYWN0ZXJzLlxuZnVuY3Rpb24gdmFsaWRDaHVuayhzdHJlYW0sIHN0YXRlLCBjaHVuaywgY2IpIHtcbiAgdmFyIHZhbGlkID0gdHJ1ZTtcbiAgaWYgKCFCdWZmZXIuaXNCdWZmZXIoY2h1bmspICYmXG4gICAgICAnc3RyaW5nJyAhPT0gdHlwZW9mIGNodW5rICYmXG4gICAgICBjaHVuayAhPT0gbnVsbCAmJlxuICAgICAgY2h1bmsgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgIXN0YXRlLm9iamVjdE1vZGUpIHtcbiAgICB2YXIgZXIgPSBuZXcgVHlwZUVycm9yKCdJbnZhbGlkIG5vbi1zdHJpbmcvYnVmZmVyIGNodW5rJyk7XG4gICAgc3RyZWFtLmVtaXQoJ2Vycm9yJywgZXIpO1xuICAgIHByb2Nlc3MubmV4dFRpY2soZnVuY3Rpb24oKSB7XG4gICAgICBjYihlcik7XG4gICAgfSk7XG4gICAgdmFsaWQgPSBmYWxzZTtcbiAgfVxuICByZXR1cm4gdmFsaWQ7XG59XG5cbldyaXRhYmxlLnByb3RvdHlwZS53cml0ZSA9IGZ1bmN0aW9uKGNodW5rLCBlbmNvZGluZywgY2IpIHtcbiAgdmFyIHN0YXRlID0gdGhpcy5fd3JpdGFibGVTdGF0ZTtcbiAgdmFyIHJldCA9IGZhbHNlO1xuXG4gIGlmICh0eXBlb2YgZW5jb2RpbmcgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjYiA9IGVuY29kaW5nO1xuICAgIGVuY29kaW5nID0gbnVsbDtcbiAgfVxuXG4gIGlmIChCdWZmZXIuaXNCdWZmZXIoY2h1bmspKVxuICAgIGVuY29kaW5nID0gJ2J1ZmZlcic7XG4gIGVsc2UgaWYgKCFlbmNvZGluZylcbiAgICBlbmNvZGluZyA9IHN0YXRlLmRlZmF1bHRFbmNvZGluZztcblxuICBpZiAodHlwZW9mIGNiICE9PSAnZnVuY3Rpb24nKVxuICAgIGNiID0gZnVuY3Rpb24oKSB7fTtcblxuICBpZiAoc3RhdGUuZW5kZWQpXG4gICAgd3JpdGVBZnRlckVuZCh0aGlzLCBzdGF0ZSwgY2IpO1xuICBlbHNlIGlmICh2YWxpZENodW5rKHRoaXMsIHN0YXRlLCBjaHVuaywgY2IpKVxuICAgIHJldCA9IHdyaXRlT3JCdWZmZXIodGhpcywgc3RhdGUsIGNodW5rLCBlbmNvZGluZywgY2IpO1xuXG4gIHJldHVybiByZXQ7XG59O1xuXG5mdW5jdGlvbiBkZWNvZGVDaHVuayhzdGF0ZSwgY2h1bmssIGVuY29kaW5nKSB7XG4gIGlmICghc3RhdGUub2JqZWN0TW9kZSAmJlxuICAgICAgc3RhdGUuZGVjb2RlU3RyaW5ncyAhPT0gZmFsc2UgJiZcbiAgICAgIHR5cGVvZiBjaHVuayA9PT0gJ3N0cmluZycpIHtcbiAgICBjaHVuayA9IG5ldyBCdWZmZXIoY2h1bmssIGVuY29kaW5nKTtcbiAgfVxuICByZXR1cm4gY2h1bms7XG59XG5cbi8vIGlmIHdlJ3JlIGFscmVhZHkgd3JpdGluZyBzb21ldGhpbmcsIHRoZW4ganVzdCBwdXQgdGhpc1xuLy8gaW4gdGhlIHF1ZXVlLCBhbmQgd2FpdCBvdXIgdHVybi4gIE90aGVyd2lzZSwgY2FsbCBfd3JpdGVcbi8vIElmIHdlIHJldHVybiBmYWxzZSwgdGhlbiB3ZSBuZWVkIGEgZHJhaW4gZXZlbnQsIHNvIHNldCB0aGF0IGZsYWcuXG5mdW5jdGlvbiB3cml0ZU9yQnVmZmVyKHN0cmVhbSwgc3RhdGUsIGNodW5rLCBlbmNvZGluZywgY2IpIHtcbiAgY2h1bmsgPSBkZWNvZGVDaHVuayhzdGF0ZSwgY2h1bmssIGVuY29kaW5nKTtcbiAgaWYgKEJ1ZmZlci5pc0J1ZmZlcihjaHVuaykpXG4gICAgZW5jb2RpbmcgPSAnYnVmZmVyJztcbiAgdmFyIGxlbiA9IHN0YXRlLm9iamVjdE1vZGUgPyAxIDogY2h1bmsubGVuZ3RoO1xuXG4gIHN0YXRlLmxlbmd0aCArPSBsZW47XG5cbiAgdmFyIHJldCA9IHN0YXRlLmxlbmd0aCA8IHN0YXRlLmhpZ2hXYXRlck1hcms7XG4gIC8vIHdlIG11c3QgZW5zdXJlIHRoYXQgcHJldmlvdXMgbmVlZERyYWluIHdpbGwgbm90IGJlIHJlc2V0IHRvIGZhbHNlLlxuICBpZiAoIXJldClcbiAgICBzdGF0ZS5uZWVkRHJhaW4gPSB0cnVlO1xuXG4gIGlmIChzdGF0ZS53cml0aW5nKVxuICAgIHN0YXRlLmJ1ZmZlci5wdXNoKG5ldyBXcml0ZVJlcShjaHVuaywgZW5jb2RpbmcsIGNiKSk7XG4gIGVsc2VcbiAgICBkb1dyaXRlKHN0cmVhbSwgc3RhdGUsIGxlbiwgY2h1bmssIGVuY29kaW5nLCBjYik7XG5cbiAgcmV0dXJuIHJldDtcbn1cblxuZnVuY3Rpb24gZG9Xcml0ZShzdHJlYW0sIHN0YXRlLCBsZW4sIGNodW5rLCBlbmNvZGluZywgY2IpIHtcbiAgc3RhdGUud3JpdGVsZW4gPSBsZW47XG4gIHN0YXRlLndyaXRlY2IgPSBjYjtcbiAgc3RhdGUud3JpdGluZyA9IHRydWU7XG4gIHN0YXRlLnN5bmMgPSB0cnVlO1xuICBzdHJlYW0uX3dyaXRlKGNodW5rLCBlbmNvZGluZywgc3RhdGUub253cml0ZSk7XG4gIHN0YXRlLnN5bmMgPSBmYWxzZTtcbn1cblxuZnVuY3Rpb24gb253cml0ZUVycm9yKHN0cmVhbSwgc3RhdGUsIHN5bmMsIGVyLCBjYikge1xuICBpZiAoc3luYylcbiAgICBwcm9jZXNzLm5leHRUaWNrKGZ1bmN0aW9uKCkge1xuICAgICAgY2IoZXIpO1xuICAgIH0pO1xuICBlbHNlXG4gICAgY2IoZXIpO1xuXG4gIHN0cmVhbS5fd3JpdGFibGVTdGF0ZS5lcnJvckVtaXR0ZWQgPSB0cnVlO1xuICBzdHJlYW0uZW1pdCgnZXJyb3InLCBlcik7XG59XG5cbmZ1bmN0aW9uIG9ud3JpdGVTdGF0ZVVwZGF0ZShzdGF0ZSkge1xuICBzdGF0ZS53cml0aW5nID0gZmFsc2U7XG4gIHN0YXRlLndyaXRlY2IgPSBudWxsO1xuICBzdGF0ZS5sZW5ndGggLT0gc3RhdGUud3JpdGVsZW47XG4gIHN0YXRlLndyaXRlbGVuID0gMDtcbn1cblxuZnVuY3Rpb24gb253cml0ZShzdHJlYW0sIGVyKSB7XG4gIHZhciBzdGF0ZSA9IHN0cmVhbS5fd3JpdGFibGVTdGF0ZTtcbiAgdmFyIHN5bmMgPSBzdGF0ZS5zeW5jO1xuICB2YXIgY2IgPSBzdGF0ZS53cml0ZWNiO1xuXG4gIG9ud3JpdGVTdGF0ZVVwZGF0ZShzdGF0ZSk7XG5cbiAgaWYgKGVyKVxuICAgIG9ud3JpdGVFcnJvcihzdHJlYW0sIHN0YXRlLCBzeW5jLCBlciwgY2IpO1xuICBlbHNlIHtcbiAgICAvLyBDaGVjayBpZiB3ZSdyZSBhY3R1YWxseSByZWFkeSB0byBmaW5pc2gsIGJ1dCBkb24ndCBlbWl0IHlldFxuICAgIHZhciBmaW5pc2hlZCA9IG5lZWRGaW5pc2goc3RyZWFtLCBzdGF0ZSk7XG5cbiAgICBpZiAoIWZpbmlzaGVkICYmICFzdGF0ZS5idWZmZXJQcm9jZXNzaW5nICYmIHN0YXRlLmJ1ZmZlci5sZW5ndGgpXG4gICAgICBjbGVhckJ1ZmZlcihzdHJlYW0sIHN0YXRlKTtcblxuICAgIGlmIChzeW5jKSB7XG4gICAgICBwcm9jZXNzLm5leHRUaWNrKGZ1bmN0aW9uKCkge1xuICAgICAgICBhZnRlcldyaXRlKHN0cmVhbSwgc3RhdGUsIGZpbmlzaGVkLCBjYik7XG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgYWZ0ZXJXcml0ZShzdHJlYW0sIHN0YXRlLCBmaW5pc2hlZCwgY2IpO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBhZnRlcldyaXRlKHN0cmVhbSwgc3RhdGUsIGZpbmlzaGVkLCBjYikge1xuICBpZiAoIWZpbmlzaGVkKVxuICAgIG9ud3JpdGVEcmFpbihzdHJlYW0sIHN0YXRlKTtcbiAgY2IoKTtcbiAgaWYgKGZpbmlzaGVkKVxuICAgIGZpbmlzaE1heWJlKHN0cmVhbSwgc3RhdGUpO1xufVxuXG4vLyBNdXN0IGZvcmNlIGNhbGxiYWNrIHRvIGJlIGNhbGxlZCBvbiBuZXh0VGljaywgc28gdGhhdCB3ZSBkb24ndFxuLy8gZW1pdCAnZHJhaW4nIGJlZm9yZSB0aGUgd3JpdGUoKSBjb25zdW1lciBnZXRzIHRoZSAnZmFsc2UnIHJldHVyblxuLy8gdmFsdWUsIGFuZCBoYXMgYSBjaGFuY2UgdG8gYXR0YWNoIGEgJ2RyYWluJyBsaXN0ZW5lci5cbmZ1bmN0aW9uIG9ud3JpdGVEcmFpbihzdHJlYW0sIHN0YXRlKSB7XG4gIGlmIChzdGF0ZS5sZW5ndGggPT09IDAgJiYgc3RhdGUubmVlZERyYWluKSB7XG4gICAgc3RhdGUubmVlZERyYWluID0gZmFsc2U7XG4gICAgc3RyZWFtLmVtaXQoJ2RyYWluJyk7XG4gIH1cbn1cblxuXG4vLyBpZiB0aGVyZSdzIHNvbWV0aGluZyBpbiB0aGUgYnVmZmVyIHdhaXRpbmcsIHRoZW4gcHJvY2VzcyBpdFxuZnVuY3Rpb24gY2xlYXJCdWZmZXIoc3RyZWFtLCBzdGF0ZSkge1xuICBzdGF0ZS5idWZmZXJQcm9jZXNzaW5nID0gdHJ1ZTtcblxuICBmb3IgKHZhciBjID0gMDsgYyA8IHN0YXRlLmJ1ZmZlci5sZW5ndGg7IGMrKykge1xuICAgIHZhciBlbnRyeSA9IHN0YXRlLmJ1ZmZlcltjXTtcbiAgICB2YXIgY2h1bmsgPSBlbnRyeS5jaHVuaztcbiAgICB2YXIgZW5jb2RpbmcgPSBlbnRyeS5lbmNvZGluZztcbiAgICB2YXIgY2IgPSBlbnRyeS5jYWxsYmFjaztcbiAgICB2YXIgbGVuID0gc3RhdGUub2JqZWN0TW9kZSA/IDEgOiBjaHVuay5sZW5ndGg7XG5cbiAgICBkb1dyaXRlKHN0cmVhbSwgc3RhdGUsIGxlbiwgY2h1bmssIGVuY29kaW5nLCBjYik7XG5cbiAgICAvLyBpZiB3ZSBkaWRuJ3QgY2FsbCB0aGUgb253cml0ZSBpbW1lZGlhdGVseSwgdGhlblxuICAgIC8vIGl0IG1lYW5zIHRoYXQgd2UgbmVlZCB0byB3YWl0IHVudGlsIGl0IGRvZXMuXG4gICAgLy8gYWxzbywgdGhhdCBtZWFucyB0aGF0IHRoZSBjaHVuayBhbmQgY2IgYXJlIGN1cnJlbnRseVxuICAgIC8vIGJlaW5nIHByb2Nlc3NlZCwgc28gbW92ZSB0aGUgYnVmZmVyIGNvdW50ZXIgcGFzdCB0aGVtLlxuICAgIGlmIChzdGF0ZS53cml0aW5nKSB7XG4gICAgICBjKys7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICBzdGF0ZS5idWZmZXJQcm9jZXNzaW5nID0gZmFsc2U7XG4gIGlmIChjIDwgc3RhdGUuYnVmZmVyLmxlbmd0aClcbiAgICBzdGF0ZS5idWZmZXIgPSBzdGF0ZS5idWZmZXIuc2xpY2UoYyk7XG4gIGVsc2VcbiAgICBzdGF0ZS5idWZmZXIubGVuZ3RoID0gMDtcbn1cblxuV3JpdGFibGUucHJvdG90eXBlLl93cml0ZSA9IGZ1bmN0aW9uKGNodW5rLCBlbmNvZGluZywgY2IpIHtcbiAgY2IobmV3IEVycm9yKCdub3QgaW1wbGVtZW50ZWQnKSk7XG59O1xuXG5Xcml0YWJsZS5wcm90b3R5cGUuZW5kID0gZnVuY3Rpb24oY2h1bmssIGVuY29kaW5nLCBjYikge1xuICB2YXIgc3RhdGUgPSB0aGlzLl93cml0YWJsZVN0YXRlO1xuXG4gIGlmICh0eXBlb2YgY2h1bmsgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjYiA9IGNodW5rO1xuICAgIGNodW5rID0gbnVsbDtcbiAgICBlbmNvZGluZyA9IG51bGw7XG4gIH0gZWxzZSBpZiAodHlwZW9mIGVuY29kaW5nID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2IgPSBlbmNvZGluZztcbiAgICBlbmNvZGluZyA9IG51bGw7XG4gIH1cblxuICBpZiAodHlwZW9mIGNodW5rICE9PSAndW5kZWZpbmVkJyAmJiBjaHVuayAhPT0gbnVsbClcbiAgICB0aGlzLndyaXRlKGNodW5rLCBlbmNvZGluZyk7XG5cbiAgLy8gaWdub3JlIHVubmVjZXNzYXJ5IGVuZCgpIGNhbGxzLlxuICBpZiAoIXN0YXRlLmVuZGluZyAmJiAhc3RhdGUuZmluaXNoZWQpXG4gICAgZW5kV3JpdGFibGUodGhpcywgc3RhdGUsIGNiKTtcbn07XG5cblxuZnVuY3Rpb24gbmVlZEZpbmlzaChzdHJlYW0sIHN0YXRlKSB7XG4gIHJldHVybiAoc3RhdGUuZW5kaW5nICYmXG4gICAgICAgICAgc3RhdGUubGVuZ3RoID09PSAwICYmXG4gICAgICAgICAgIXN0YXRlLmZpbmlzaGVkICYmXG4gICAgICAgICAgIXN0YXRlLndyaXRpbmcpO1xufVxuXG5mdW5jdGlvbiBmaW5pc2hNYXliZShzdHJlYW0sIHN0YXRlKSB7XG4gIHZhciBuZWVkID0gbmVlZEZpbmlzaChzdHJlYW0sIHN0YXRlKTtcbiAgaWYgKG5lZWQpIHtcbiAgICBzdGF0ZS5maW5pc2hlZCA9IHRydWU7XG4gICAgc3RyZWFtLmVtaXQoJ2ZpbmlzaCcpO1xuICB9XG4gIHJldHVybiBuZWVkO1xufVxuXG5mdW5jdGlvbiBlbmRXcml0YWJsZShzdHJlYW0sIHN0YXRlLCBjYikge1xuICBzdGF0ZS5lbmRpbmcgPSB0cnVlO1xuICBmaW5pc2hNYXliZShzdHJlYW0sIHN0YXRlKTtcbiAgaWYgKGNiKSB7XG4gICAgaWYgKHN0YXRlLmZpbmlzaGVkKVxuICAgICAgcHJvY2Vzcy5uZXh0VGljayhjYik7XG4gICAgZWxzZVxuICAgICAgc3RyZWFtLm9uY2UoJ2ZpbmlzaCcsIGNiKTtcbiAgfVxuICBzdGF0ZS5lbmRlZCA9IHRydWU7XG59XG5cbn0pLmNhbGwodGhpcyxyZXF1aXJlKCdfcHJvY2VzcycpKSIsIihmdW5jdGlvbiAoQnVmZmVyKXtcbi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG4vLyBOT1RFOiBUaGVzZSB0eXBlIGNoZWNraW5nIGZ1bmN0aW9ucyBpbnRlbnRpb25hbGx5IGRvbid0IHVzZSBgaW5zdGFuY2VvZmBcbi8vIGJlY2F1c2UgaXQgaXMgZnJhZ2lsZSBhbmQgY2FuIGJlIGVhc2lseSBmYWtlZCB3aXRoIGBPYmplY3QuY3JlYXRlKClgLlxuZnVuY3Rpb24gaXNBcnJheShhcikge1xuICByZXR1cm4gQXJyYXkuaXNBcnJheShhcik7XG59XG5leHBvcnRzLmlzQXJyYXkgPSBpc0FycmF5O1xuXG5mdW5jdGlvbiBpc0Jvb2xlYW4oYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnYm9vbGVhbic7XG59XG5leHBvcnRzLmlzQm9vbGVhbiA9IGlzQm9vbGVhbjtcblxuZnVuY3Rpb24gaXNOdWxsKGFyZykge1xuICByZXR1cm4gYXJnID09PSBudWxsO1xufVxuZXhwb3J0cy5pc051bGwgPSBpc051bGw7XG5cbmZ1bmN0aW9uIGlzTnVsbE9yVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gYXJnID09IG51bGw7XG59XG5leHBvcnRzLmlzTnVsbE9yVW5kZWZpbmVkID0gaXNOdWxsT3JVbmRlZmluZWQ7XG5cbmZ1bmN0aW9uIGlzTnVtYmVyKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ251bWJlcic7XG59XG5leHBvcnRzLmlzTnVtYmVyID0gaXNOdW1iZXI7XG5cbmZ1bmN0aW9uIGlzU3RyaW5nKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ3N0cmluZyc7XG59XG5leHBvcnRzLmlzU3RyaW5nID0gaXNTdHJpbmc7XG5cbmZ1bmN0aW9uIGlzU3ltYm9sKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ3N5bWJvbCc7XG59XG5leHBvcnRzLmlzU3ltYm9sID0gaXNTeW1ib2w7XG5cbmZ1bmN0aW9uIGlzVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gYXJnID09PSB2b2lkIDA7XG59XG5leHBvcnRzLmlzVW5kZWZpbmVkID0gaXNVbmRlZmluZWQ7XG5cbmZ1bmN0aW9uIGlzUmVnRXhwKHJlKSB7XG4gIHJldHVybiBpc09iamVjdChyZSkgJiYgb2JqZWN0VG9TdHJpbmcocmUpID09PSAnW29iamVjdCBSZWdFeHBdJztcbn1cbmV4cG9ydHMuaXNSZWdFeHAgPSBpc1JlZ0V4cDtcblxuZnVuY3Rpb24gaXNPYmplY3QoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBhcmcgIT09IG51bGw7XG59XG5leHBvcnRzLmlzT2JqZWN0ID0gaXNPYmplY3Q7XG5cbmZ1bmN0aW9uIGlzRGF0ZShkKSB7XG4gIHJldHVybiBpc09iamVjdChkKSAmJiBvYmplY3RUb1N0cmluZyhkKSA9PT0gJ1tvYmplY3QgRGF0ZV0nO1xufVxuZXhwb3J0cy5pc0RhdGUgPSBpc0RhdGU7XG5cbmZ1bmN0aW9uIGlzRXJyb3IoZSkge1xuICByZXR1cm4gaXNPYmplY3QoZSkgJiZcbiAgICAgIChvYmplY3RUb1N0cmluZyhlKSA9PT0gJ1tvYmplY3QgRXJyb3JdJyB8fCBlIGluc3RhbmNlb2YgRXJyb3IpO1xufVxuZXhwb3J0cy5pc0Vycm9yID0gaXNFcnJvcjtcblxuZnVuY3Rpb24gaXNGdW5jdGlvbihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdmdW5jdGlvbic7XG59XG5leHBvcnRzLmlzRnVuY3Rpb24gPSBpc0Z1bmN0aW9uO1xuXG5mdW5jdGlvbiBpc1ByaW1pdGl2ZShhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gbnVsbCB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ2Jvb2xlYW4nIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnbnVtYmVyJyB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ3N0cmluZycgfHxcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICdzeW1ib2wnIHx8ICAvLyBFUzYgc3ltYm9sXG4gICAgICAgICB0eXBlb2YgYXJnID09PSAndW5kZWZpbmVkJztcbn1cbmV4cG9ydHMuaXNQcmltaXRpdmUgPSBpc1ByaW1pdGl2ZTtcblxuZnVuY3Rpb24gaXNCdWZmZXIoYXJnKSB7XG4gIHJldHVybiBCdWZmZXIuaXNCdWZmZXIoYXJnKTtcbn1cbmV4cG9ydHMuaXNCdWZmZXIgPSBpc0J1ZmZlcjtcblxuZnVuY3Rpb24gb2JqZWN0VG9TdHJpbmcobykge1xuICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKG8pO1xufVxufSkuY2FsbCh0aGlzLHJlcXVpcmUoXCJidWZmZXJcIikuQnVmZmVyKSIsIm1vZHVsZS5leHBvcnRzID0gcmVxdWlyZShcIi4vbGliL19zdHJlYW1fcGFzc3Rocm91Z2guanNcIilcbiIsInZhciBTdHJlYW0gPSByZXF1aXJlKCdzdHJlYW0nKTsgLy8gaGFjayB0byBmaXggYSBjaXJjdWxhciBkZXBlbmRlbmN5IGlzc3VlIHdoZW4gdXNlZCB3aXRoIGJyb3dzZXJpZnlcbmV4cG9ydHMgPSBtb2R1bGUuZXhwb3J0cyA9IHJlcXVpcmUoJy4vbGliL19zdHJlYW1fcmVhZGFibGUuanMnKTtcbmV4cG9ydHMuU3RyZWFtID0gU3RyZWFtO1xuZXhwb3J0cy5SZWFkYWJsZSA9IGV4cG9ydHM7XG5leHBvcnRzLldyaXRhYmxlID0gcmVxdWlyZSgnLi9saWIvX3N0cmVhbV93cml0YWJsZS5qcycpO1xuZXhwb3J0cy5EdXBsZXggPSByZXF1aXJlKCcuL2xpYi9fc3RyZWFtX2R1cGxleC5qcycpO1xuZXhwb3J0cy5UcmFuc2Zvcm0gPSByZXF1aXJlKCcuL2xpYi9fc3RyZWFtX3RyYW5zZm9ybS5qcycpO1xuZXhwb3J0cy5QYXNzVGhyb3VnaCA9IHJlcXVpcmUoJy4vbGliL19zdHJlYW1fcGFzc3Rocm91Z2guanMnKTtcbiIsIm1vZHVsZS5leHBvcnRzID0gcmVxdWlyZShcIi4vbGliL19zdHJlYW1fdHJhbnNmb3JtLmpzXCIpXG4iLCJtb2R1bGUuZXhwb3J0cyA9IHJlcXVpcmUoXCIuL2xpYi9fc3RyZWFtX3dyaXRhYmxlLmpzXCIpXG4iLCIvLyBDb3B5cmlnaHQgSm95ZW50LCBJbmMuIGFuZCBvdGhlciBOb2RlIGNvbnRyaWJ1dG9ycy5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYVxuLy8gY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZVxuLy8gXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nXG4vLyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsXG4vLyBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0XG4vLyBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGVcbi8vIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkXG4vLyBpbiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTXG4vLyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GXG4vLyBNRVJDSEFOVEFCSUxJVFksIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOXG4vLyBOTyBFVkVOVCBTSEFMTCBUSEUgQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSxcbi8vIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUlxuLy8gT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRVxuLy8gVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxubW9kdWxlLmV4cG9ydHMgPSBTdHJlYW07XG5cbnZhciBFRSA9IHJlcXVpcmUoJ2V2ZW50cycpLkV2ZW50RW1pdHRlcjtcbnZhciBpbmhlcml0cyA9IHJlcXVpcmUoJ2luaGVyaXRzJyk7XG5cbmluaGVyaXRzKFN0cmVhbSwgRUUpO1xuU3RyZWFtLlJlYWRhYmxlID0gcmVxdWlyZSgncmVhZGFibGUtc3RyZWFtL3JlYWRhYmxlLmpzJyk7XG5TdHJlYW0uV3JpdGFibGUgPSByZXF1aXJlKCdyZWFkYWJsZS1zdHJlYW0vd3JpdGFibGUuanMnKTtcblN0cmVhbS5EdXBsZXggPSByZXF1aXJlKCdyZWFkYWJsZS1zdHJlYW0vZHVwbGV4LmpzJyk7XG5TdHJlYW0uVHJhbnNmb3JtID0gcmVxdWlyZSgncmVhZGFibGUtc3RyZWFtL3RyYW5zZm9ybS5qcycpO1xuU3RyZWFtLlBhc3NUaHJvdWdoID0gcmVxdWlyZSgncmVhZGFibGUtc3RyZWFtL3Bhc3N0aHJvdWdoLmpzJyk7XG5cbi8vIEJhY2t3YXJkcy1jb21wYXQgd2l0aCBub2RlIDAuNC54XG5TdHJlYW0uU3RyZWFtID0gU3RyZWFtO1xuXG5cblxuLy8gb2xkLXN0eWxlIHN0cmVhbXMuICBOb3RlIHRoYXQgdGhlIHBpcGUgbWV0aG9kICh0aGUgb25seSByZWxldmFudFxuLy8gcGFydCBvZiB0aGlzIGNsYXNzKSBpcyBvdmVycmlkZGVuIGluIHRoZSBSZWFkYWJsZSBjbGFzcy5cblxuZnVuY3Rpb24gU3RyZWFtKCkge1xuICBFRS5jYWxsKHRoaXMpO1xufVxuXG5TdHJlYW0ucHJvdG90eXBlLnBpcGUgPSBmdW5jdGlvbihkZXN0LCBvcHRpb25zKSB7XG4gIHZhciBzb3VyY2UgPSB0aGlzO1xuXG4gIGZ1bmN0aW9uIG9uZGF0YShjaHVuaykge1xuICAgIGlmIChkZXN0LndyaXRhYmxlKSB7XG4gICAgICBpZiAoZmFsc2UgPT09IGRlc3Qud3JpdGUoY2h1bmspICYmIHNvdXJjZS5wYXVzZSkge1xuICAgICAgICBzb3VyY2UucGF1c2UoKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBzb3VyY2Uub24oJ2RhdGEnLCBvbmRhdGEpO1xuXG4gIGZ1bmN0aW9uIG9uZHJhaW4oKSB7XG4gICAgaWYgKHNvdXJjZS5yZWFkYWJsZSAmJiBzb3VyY2UucmVzdW1lKSB7XG4gICAgICBzb3VyY2UucmVzdW1lKCk7XG4gICAgfVxuICB9XG5cbiAgZGVzdC5vbignZHJhaW4nLCBvbmRyYWluKTtcblxuICAvLyBJZiB0aGUgJ2VuZCcgb3B0aW9uIGlzIG5vdCBzdXBwbGllZCwgZGVzdC5lbmQoKSB3aWxsIGJlIGNhbGxlZCB3aGVuXG4gIC8vIHNvdXJjZSBnZXRzIHRoZSAnZW5kJyBvciAnY2xvc2UnIGV2ZW50cy4gIE9ubHkgZGVzdC5lbmQoKSBvbmNlLlxuICBpZiAoIWRlc3QuX2lzU3RkaW8gJiYgKCFvcHRpb25zIHx8IG9wdGlvbnMuZW5kICE9PSBmYWxzZSkpIHtcbiAgICBzb3VyY2Uub24oJ2VuZCcsIG9uZW5kKTtcbiAgICBzb3VyY2Uub24oJ2Nsb3NlJywgb25jbG9zZSk7XG4gIH1cblxuICB2YXIgZGlkT25FbmQgPSBmYWxzZTtcbiAgZnVuY3Rpb24gb25lbmQoKSB7XG4gICAgaWYgKGRpZE9uRW5kKSByZXR1cm47XG4gICAgZGlkT25FbmQgPSB0cnVlO1xuXG4gICAgZGVzdC5lbmQoKTtcbiAgfVxuXG5cbiAgZnVuY3Rpb24gb25jbG9zZSgpIHtcbiAgICBpZiAoZGlkT25FbmQpIHJldHVybjtcbiAgICBkaWRPbkVuZCA9IHRydWU7XG5cbiAgICBpZiAodHlwZW9mIGRlc3QuZGVzdHJveSA9PT0gJ2Z1bmN0aW9uJykgZGVzdC5kZXN0cm95KCk7XG4gIH1cblxuICAvLyBkb24ndCBsZWF2ZSBkYW5nbGluZyBwaXBlcyB3aGVuIHRoZXJlIGFyZSBlcnJvcnMuXG4gIGZ1bmN0aW9uIG9uZXJyb3IoZXIpIHtcbiAgICBjbGVhbnVwKCk7XG4gICAgaWYgKEVFLmxpc3RlbmVyQ291bnQodGhpcywgJ2Vycm9yJykgPT09IDApIHtcbiAgICAgIHRocm93IGVyOyAvLyBVbmhhbmRsZWQgc3RyZWFtIGVycm9yIGluIHBpcGUuXG4gICAgfVxuICB9XG5cbiAgc291cmNlLm9uKCdlcnJvcicsIG9uZXJyb3IpO1xuICBkZXN0Lm9uKCdlcnJvcicsIG9uZXJyb3IpO1xuXG4gIC8vIHJlbW92ZSBhbGwgdGhlIGV2ZW50IGxpc3RlbmVycyB0aGF0IHdlcmUgYWRkZWQuXG4gIGZ1bmN0aW9uIGNsZWFudXAoKSB7XG4gICAgc291cmNlLnJlbW92ZUxpc3RlbmVyKCdkYXRhJywgb25kYXRhKTtcbiAgICBkZXN0LnJlbW92ZUxpc3RlbmVyKCdkcmFpbicsIG9uZHJhaW4pO1xuXG4gICAgc291cmNlLnJlbW92ZUxpc3RlbmVyKCdlbmQnLCBvbmVuZCk7XG4gICAgc291cmNlLnJlbW92ZUxpc3RlbmVyKCdjbG9zZScsIG9uY2xvc2UpO1xuXG4gICAgc291cmNlLnJlbW92ZUxpc3RlbmVyKCdlcnJvcicsIG9uZXJyb3IpO1xuICAgIGRlc3QucmVtb3ZlTGlzdGVuZXIoJ2Vycm9yJywgb25lcnJvcik7XG5cbiAgICBzb3VyY2UucmVtb3ZlTGlzdGVuZXIoJ2VuZCcsIGNsZWFudXApO1xuICAgIHNvdXJjZS5yZW1vdmVMaXN0ZW5lcignY2xvc2UnLCBjbGVhbnVwKTtcblxuICAgIGRlc3QucmVtb3ZlTGlzdGVuZXIoJ2Nsb3NlJywgY2xlYW51cCk7XG4gIH1cblxuICBzb3VyY2Uub24oJ2VuZCcsIGNsZWFudXApO1xuICBzb3VyY2Uub24oJ2Nsb3NlJywgY2xlYW51cCk7XG5cbiAgZGVzdC5vbignY2xvc2UnLCBjbGVhbnVwKTtcblxuICBkZXN0LmVtaXQoJ3BpcGUnLCBzb3VyY2UpO1xuXG4gIC8vIEFsbG93IGZvciB1bml4LWxpa2UgdXNhZ2U6IEEucGlwZShCKS5waXBlKEMpXG4gIHJldHVybiBkZXN0O1xufTtcbiIsIi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG52YXIgQnVmZmVyID0gcmVxdWlyZSgnYnVmZmVyJykuQnVmZmVyO1xuXG52YXIgaXNCdWZmZXJFbmNvZGluZyA9IEJ1ZmZlci5pc0VuY29kaW5nXG4gIHx8IGZ1bmN0aW9uKGVuY29kaW5nKSB7XG4gICAgICAgc3dpdGNoIChlbmNvZGluZyAmJiBlbmNvZGluZy50b0xvd2VyQ2FzZSgpKSB7XG4gICAgICAgICBjYXNlICdoZXgnOiBjYXNlICd1dGY4JzogY2FzZSAndXRmLTgnOiBjYXNlICdhc2NpaSc6IGNhc2UgJ2JpbmFyeSc6IGNhc2UgJ2Jhc2U2NCc6IGNhc2UgJ3VjczInOiBjYXNlICd1Y3MtMic6IGNhc2UgJ3V0ZjE2bGUnOiBjYXNlICd1dGYtMTZsZSc6IGNhc2UgJ3Jhdyc6IHJldHVybiB0cnVlO1xuICAgICAgICAgZGVmYXVsdDogcmV0dXJuIGZhbHNlO1xuICAgICAgIH1cbiAgICAgfVxuXG5cbmZ1bmN0aW9uIGFzc2VydEVuY29kaW5nKGVuY29kaW5nKSB7XG4gIGlmIChlbmNvZGluZyAmJiAhaXNCdWZmZXJFbmNvZGluZyhlbmNvZGluZykpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gZW5jb2Rpbmc6ICcgKyBlbmNvZGluZyk7XG4gIH1cbn1cblxuLy8gU3RyaW5nRGVjb2RlciBwcm92aWRlcyBhbiBpbnRlcmZhY2UgZm9yIGVmZmljaWVudGx5IHNwbGl0dGluZyBhIHNlcmllcyBvZlxuLy8gYnVmZmVycyBpbnRvIGEgc2VyaWVzIG9mIEpTIHN0cmluZ3Mgd2l0aG91dCBicmVha2luZyBhcGFydCBtdWx0aS1ieXRlXG4vLyBjaGFyYWN0ZXJzLiBDRVNVLTggaXMgaGFuZGxlZCBhcyBwYXJ0IG9mIHRoZSBVVEYtOCBlbmNvZGluZy5cbi8vXG4vLyBAVE9ETyBIYW5kbGluZyBhbGwgZW5jb2RpbmdzIGluc2lkZSBhIHNpbmdsZSBvYmplY3QgbWFrZXMgaXQgdmVyeSBkaWZmaWN1bHRcbi8vIHRvIHJlYXNvbiBhYm91dCB0aGlzIGNvZGUsIHNvIGl0IHNob3VsZCBiZSBzcGxpdCB1cCBpbiB0aGUgZnV0dXJlLlxuLy8gQFRPRE8gVGhlcmUgc2hvdWxkIGJlIGEgdXRmOC1zdHJpY3QgZW5jb2RpbmcgdGhhdCByZWplY3RzIGludmFsaWQgVVRGLTggY29kZVxuLy8gcG9pbnRzIGFzIHVzZWQgYnkgQ0VTVS04LlxudmFyIFN0cmluZ0RlY29kZXIgPSBleHBvcnRzLlN0cmluZ0RlY29kZXIgPSBmdW5jdGlvbihlbmNvZGluZykge1xuICB0aGlzLmVuY29kaW5nID0gKGVuY29kaW5nIHx8ICd1dGY4JykudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bLV9dLywgJycpO1xuICBhc3NlcnRFbmNvZGluZyhlbmNvZGluZyk7XG4gIHN3aXRjaCAodGhpcy5lbmNvZGluZykge1xuICAgIGNhc2UgJ3V0ZjgnOlxuICAgICAgLy8gQ0VTVS04IHJlcHJlc2VudHMgZWFjaCBvZiBTdXJyb2dhdGUgUGFpciBieSAzLWJ5dGVzXG4gICAgICB0aGlzLnN1cnJvZ2F0ZVNpemUgPSAzO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAndWNzMic6XG4gICAgY2FzZSAndXRmMTZsZSc6XG4gICAgICAvLyBVVEYtMTYgcmVwcmVzZW50cyBlYWNoIG9mIFN1cnJvZ2F0ZSBQYWlyIGJ5IDItYnl0ZXNcbiAgICAgIHRoaXMuc3Vycm9nYXRlU2l6ZSA9IDI7XG4gICAgICB0aGlzLmRldGVjdEluY29tcGxldGVDaGFyID0gdXRmMTZEZXRlY3RJbmNvbXBsZXRlQ2hhcjtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ2Jhc2U2NCc6XG4gICAgICAvLyBCYXNlLTY0IHN0b3JlcyAzIGJ5dGVzIGluIDQgY2hhcnMsIGFuZCBwYWRzIHRoZSByZW1haW5kZXIuXG4gICAgICB0aGlzLnN1cnJvZ2F0ZVNpemUgPSAzO1xuICAgICAgdGhpcy5kZXRlY3RJbmNvbXBsZXRlQ2hhciA9IGJhc2U2NERldGVjdEluY29tcGxldGVDaGFyO1xuICAgICAgYnJlYWs7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRoaXMud3JpdGUgPSBwYXNzVGhyb3VnaFdyaXRlO1xuICAgICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gRW5vdWdoIHNwYWNlIHRvIHN0b3JlIGFsbCBieXRlcyBvZiBhIHNpbmdsZSBjaGFyYWN0ZXIuIFVURi04IG5lZWRzIDRcbiAgLy8gYnl0ZXMsIGJ1dCBDRVNVLTggbWF5IHJlcXVpcmUgdXAgdG8gNiAoMyBieXRlcyBwZXIgc3Vycm9nYXRlKS5cbiAgdGhpcy5jaGFyQnVmZmVyID0gbmV3IEJ1ZmZlcig2KTtcbiAgLy8gTnVtYmVyIG9mIGJ5dGVzIHJlY2VpdmVkIGZvciB0aGUgY3VycmVudCBpbmNvbXBsZXRlIG11bHRpLWJ5dGUgY2hhcmFjdGVyLlxuICB0aGlzLmNoYXJSZWNlaXZlZCA9IDA7XG4gIC8vIE51bWJlciBvZiBieXRlcyBleHBlY3RlZCBmb3IgdGhlIGN1cnJlbnQgaW5jb21wbGV0ZSBtdWx0aS1ieXRlIGNoYXJhY3Rlci5cbiAgdGhpcy5jaGFyTGVuZ3RoID0gMDtcbn07XG5cblxuLy8gd3JpdGUgZGVjb2RlcyB0aGUgZ2l2ZW4gYnVmZmVyIGFuZCByZXR1cm5zIGl0IGFzIEpTIHN0cmluZyB0aGF0IGlzXG4vLyBndWFyYW50ZWVkIHRvIG5vdCBjb250YWluIGFueSBwYXJ0aWFsIG11bHRpLWJ5dGUgY2hhcmFjdGVycy4gQW55IHBhcnRpYWxcbi8vIGNoYXJhY3RlciBmb3VuZCBhdCB0aGUgZW5kIG9mIHRoZSBidWZmZXIgaXMgYnVmZmVyZWQgdXAsIGFuZCB3aWxsIGJlXG4vLyByZXR1cm5lZCB3aGVuIGNhbGxpbmcgd3JpdGUgYWdhaW4gd2l0aCB0aGUgcmVtYWluaW5nIGJ5dGVzLlxuLy9cbi8vIE5vdGU6IENvbnZlcnRpbmcgYSBCdWZmZXIgY29udGFpbmluZyBhbiBvcnBoYW4gc3Vycm9nYXRlIHRvIGEgU3RyaW5nXG4vLyBjdXJyZW50bHkgd29ya3MsIGJ1dCBjb252ZXJ0aW5nIGEgU3RyaW5nIHRvIGEgQnVmZmVyICh2aWEgYG5ldyBCdWZmZXJgLCBvclxuLy8gQnVmZmVyI3dyaXRlKSB3aWxsIHJlcGxhY2UgaW5jb21wbGV0ZSBzdXJyb2dhdGVzIHdpdGggdGhlIHVuaWNvZGVcbi8vIHJlcGxhY2VtZW50IGNoYXJhY3Rlci4gU2VlIGh0dHBzOi8vY29kZXJldmlldy5jaHJvbWl1bS5vcmcvMTIxMTczMDA5LyAuXG5TdHJpbmdEZWNvZGVyLnByb3RvdHlwZS53cml0ZSA9IGZ1bmN0aW9uKGJ1ZmZlcikge1xuICB2YXIgY2hhclN0ciA9ICcnO1xuICAvLyBpZiBvdXIgbGFzdCB3cml0ZSBlbmRlZCB3aXRoIGFuIGluY29tcGxldGUgbXVsdGlieXRlIGNoYXJhY3RlclxuICB3aGlsZSAodGhpcy5jaGFyTGVuZ3RoKSB7XG4gICAgLy8gZGV0ZXJtaW5lIGhvdyBtYW55IHJlbWFpbmluZyBieXRlcyB0aGlzIGJ1ZmZlciBoYXMgdG8gb2ZmZXIgZm9yIHRoaXMgY2hhclxuICAgIHZhciBhdmFpbGFibGUgPSAoYnVmZmVyLmxlbmd0aCA+PSB0aGlzLmNoYXJMZW5ndGggLSB0aGlzLmNoYXJSZWNlaXZlZCkgP1xuICAgICAgICB0aGlzLmNoYXJMZW5ndGggLSB0aGlzLmNoYXJSZWNlaXZlZCA6XG4gICAgICAgIGJ1ZmZlci5sZW5ndGg7XG5cbiAgICAvLyBhZGQgdGhlIG5ldyBieXRlcyB0byB0aGUgY2hhciBidWZmZXJcbiAgICBidWZmZXIuY29weSh0aGlzLmNoYXJCdWZmZXIsIHRoaXMuY2hhclJlY2VpdmVkLCAwLCBhdmFpbGFibGUpO1xuICAgIHRoaXMuY2hhclJlY2VpdmVkICs9IGF2YWlsYWJsZTtcblxuICAgIGlmICh0aGlzLmNoYXJSZWNlaXZlZCA8IHRoaXMuY2hhckxlbmd0aCkge1xuICAgICAgLy8gc3RpbGwgbm90IGVub3VnaCBjaGFycyBpbiB0aGlzIGJ1ZmZlcj8gd2FpdCBmb3IgbW9yZSAuLi5cbiAgICAgIHJldHVybiAnJztcbiAgICB9XG5cbiAgICAvLyByZW1vdmUgYnl0ZXMgYmVsb25naW5nIHRvIHRoZSBjdXJyZW50IGNoYXJhY3RlciBmcm9tIHRoZSBidWZmZXJcbiAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoYXZhaWxhYmxlLCBidWZmZXIubGVuZ3RoKTtcblxuICAgIC8vIGdldCB0aGUgY2hhcmFjdGVyIHRoYXQgd2FzIHNwbGl0XG4gICAgY2hhclN0ciA9IHRoaXMuY2hhckJ1ZmZlci5zbGljZSgwLCB0aGlzLmNoYXJMZW5ndGgpLnRvU3RyaW5nKHRoaXMuZW5jb2RpbmcpO1xuXG4gICAgLy8gQ0VTVS04OiBsZWFkIHN1cnJvZ2F0ZSAoRDgwMC1EQkZGKSBpcyBhbHNvIHRoZSBpbmNvbXBsZXRlIGNoYXJhY3RlclxuICAgIHZhciBjaGFyQ29kZSA9IGNoYXJTdHIuY2hhckNvZGVBdChjaGFyU3RyLmxlbmd0aCAtIDEpO1xuICAgIGlmIChjaGFyQ29kZSA+PSAweEQ4MDAgJiYgY2hhckNvZGUgPD0gMHhEQkZGKSB7XG4gICAgICB0aGlzLmNoYXJMZW5ndGggKz0gdGhpcy5zdXJyb2dhdGVTaXplO1xuICAgICAgY2hhclN0ciA9ICcnO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHRoaXMuY2hhclJlY2VpdmVkID0gdGhpcy5jaGFyTGVuZ3RoID0gMDtcblxuICAgIC8vIGlmIHRoZXJlIGFyZSBubyBtb3JlIGJ5dGVzIGluIHRoaXMgYnVmZmVyLCBqdXN0IGVtaXQgb3VyIGNoYXJcbiAgICBpZiAoYnVmZmVyLmxlbmd0aCA9PT0gMCkge1xuICAgICAgcmV0dXJuIGNoYXJTdHI7XG4gICAgfVxuICAgIGJyZWFrO1xuICB9XG5cbiAgLy8gZGV0ZXJtaW5lIGFuZCBzZXQgY2hhckxlbmd0aCAvIGNoYXJSZWNlaXZlZFxuICB0aGlzLmRldGVjdEluY29tcGxldGVDaGFyKGJ1ZmZlcik7XG5cbiAgdmFyIGVuZCA9IGJ1ZmZlci5sZW5ndGg7XG4gIGlmICh0aGlzLmNoYXJMZW5ndGgpIHtcbiAgICAvLyBidWZmZXIgdGhlIGluY29tcGxldGUgY2hhcmFjdGVyIGJ5dGVzIHdlIGdvdFxuICAgIGJ1ZmZlci5jb3B5KHRoaXMuY2hhckJ1ZmZlciwgMCwgYnVmZmVyLmxlbmd0aCAtIHRoaXMuY2hhclJlY2VpdmVkLCBlbmQpO1xuICAgIGVuZCAtPSB0aGlzLmNoYXJSZWNlaXZlZDtcbiAgfVxuXG4gIGNoYXJTdHIgKz0gYnVmZmVyLnRvU3RyaW5nKHRoaXMuZW5jb2RpbmcsIDAsIGVuZCk7XG5cbiAgdmFyIGVuZCA9IGNoYXJTdHIubGVuZ3RoIC0gMTtcbiAgdmFyIGNoYXJDb2RlID0gY2hhclN0ci5jaGFyQ29kZUF0KGVuZCk7XG4gIC8vIENFU1UtODogbGVhZCBzdXJyb2dhdGUgKEQ4MDAtREJGRikgaXMgYWxzbyB0aGUgaW5jb21wbGV0ZSBjaGFyYWN0ZXJcbiAgaWYgKGNoYXJDb2RlID49IDB4RDgwMCAmJiBjaGFyQ29kZSA8PSAweERCRkYpIHtcbiAgICB2YXIgc2l6ZSA9IHRoaXMuc3Vycm9nYXRlU2l6ZTtcbiAgICB0aGlzLmNoYXJMZW5ndGggKz0gc2l6ZTtcbiAgICB0aGlzLmNoYXJSZWNlaXZlZCArPSBzaXplO1xuICAgIHRoaXMuY2hhckJ1ZmZlci5jb3B5KHRoaXMuY2hhckJ1ZmZlciwgc2l6ZSwgMCwgc2l6ZSk7XG4gICAgYnVmZmVyLmNvcHkodGhpcy5jaGFyQnVmZmVyLCAwLCAwLCBzaXplKTtcbiAgICByZXR1cm4gY2hhclN0ci5zdWJzdHJpbmcoMCwgZW5kKTtcbiAgfVxuXG4gIC8vIG9yIGp1c3QgZW1pdCB0aGUgY2hhclN0clxuICByZXR1cm4gY2hhclN0cjtcbn07XG5cbi8vIGRldGVjdEluY29tcGxldGVDaGFyIGRldGVybWluZXMgaWYgdGhlcmUgaXMgYW4gaW5jb21wbGV0ZSBVVEYtOCBjaGFyYWN0ZXIgYXRcbi8vIHRoZSBlbmQgb2YgdGhlIGdpdmVuIGJ1ZmZlci4gSWYgc28sIGl0IHNldHMgdGhpcy5jaGFyTGVuZ3RoIHRvIHRoZSBieXRlXG4vLyBsZW5ndGggdGhhdCBjaGFyYWN0ZXIsIGFuZCBzZXRzIHRoaXMuY2hhclJlY2VpdmVkIHRvIHRoZSBudW1iZXIgb2YgYnl0ZXNcbi8vIHRoYXQgYXJlIGF2YWlsYWJsZSBmb3IgdGhpcyBjaGFyYWN0ZXIuXG5TdHJpbmdEZWNvZGVyLnByb3RvdHlwZS5kZXRlY3RJbmNvbXBsZXRlQ2hhciA9IGZ1bmN0aW9uKGJ1ZmZlcikge1xuICAvLyBkZXRlcm1pbmUgaG93IG1hbnkgYnl0ZXMgd2UgaGF2ZSB0byBjaGVjayBhdCB0aGUgZW5kIG9mIHRoaXMgYnVmZmVyXG4gIHZhciBpID0gKGJ1ZmZlci5sZW5ndGggPj0gMykgPyAzIDogYnVmZmVyLmxlbmd0aDtcblxuICAvLyBGaWd1cmUgb3V0IGlmIG9uZSBvZiB0aGUgbGFzdCBpIGJ5dGVzIG9mIG91ciBidWZmZXIgYW5ub3VuY2VzIGFuXG4gIC8vIGluY29tcGxldGUgY2hhci5cbiAgZm9yICg7IGkgPiAwOyBpLS0pIHtcbiAgICB2YXIgYyA9IGJ1ZmZlcltidWZmZXIubGVuZ3RoIC0gaV07XG5cbiAgICAvLyBTZWUgaHR0cDovL2VuLndpa2lwZWRpYS5vcmcvd2lraS9VVEYtOCNEZXNjcmlwdGlvblxuXG4gICAgLy8gMTEwWFhYWFhcbiAgICBpZiAoaSA9PSAxICYmIGMgPj4gNSA9PSAweDA2KSB7XG4gICAgICB0aGlzLmNoYXJMZW5ndGggPSAyO1xuICAgICAgYnJlYWs7XG4gICAgfVxuXG4gICAgLy8gMTExMFhYWFhcbiAgICBpZiAoaSA8PSAyICYmIGMgPj4gNCA9PSAweDBFKSB7XG4gICAgICB0aGlzLmNoYXJMZW5ndGggPSAzO1xuICAgICAgYnJlYWs7XG4gICAgfVxuXG4gICAgLy8gMTExMTBYWFhcbiAgICBpZiAoaSA8PSAzICYmIGMgPj4gMyA9PSAweDFFKSB7XG4gICAgICB0aGlzLmNoYXJMZW5ndGggPSA0O1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG4gIHRoaXMuY2hhclJlY2VpdmVkID0gaTtcbn07XG5cblN0cmluZ0RlY29kZXIucHJvdG90eXBlLmVuZCA9IGZ1bmN0aW9uKGJ1ZmZlcikge1xuICB2YXIgcmVzID0gJyc7XG4gIGlmIChidWZmZXIgJiYgYnVmZmVyLmxlbmd0aClcbiAgICByZXMgPSB0aGlzLndyaXRlKGJ1ZmZlcik7XG5cbiAgaWYgKHRoaXMuY2hhclJlY2VpdmVkKSB7XG4gICAgdmFyIGNyID0gdGhpcy5jaGFyUmVjZWl2ZWQ7XG4gICAgdmFyIGJ1ZiA9IHRoaXMuY2hhckJ1ZmZlcjtcbiAgICB2YXIgZW5jID0gdGhpcy5lbmNvZGluZztcbiAgICByZXMgKz0gYnVmLnNsaWNlKDAsIGNyKS50b1N0cmluZyhlbmMpO1xuICB9XG5cbiAgcmV0dXJuIHJlcztcbn07XG5cbmZ1bmN0aW9uIHBhc3NUaHJvdWdoV3JpdGUoYnVmZmVyKSB7XG4gIHJldHVybiBidWZmZXIudG9TdHJpbmcodGhpcy5lbmNvZGluZyk7XG59XG5cbmZ1bmN0aW9uIHV0ZjE2RGV0ZWN0SW5jb21wbGV0ZUNoYXIoYnVmZmVyKSB7XG4gIHRoaXMuY2hhclJlY2VpdmVkID0gYnVmZmVyLmxlbmd0aCAlIDI7XG4gIHRoaXMuY2hhckxlbmd0aCA9IHRoaXMuY2hhclJlY2VpdmVkID8gMiA6IDA7XG59XG5cbmZ1bmN0aW9uIGJhc2U2NERldGVjdEluY29tcGxldGVDaGFyKGJ1ZmZlcikge1xuICB0aGlzLmNoYXJSZWNlaXZlZCA9IGJ1ZmZlci5sZW5ndGggJSAzO1xuICB0aGlzLmNoYXJMZW5ndGggPSB0aGlzLmNoYXJSZWNlaXZlZCA/IDMgOiAwO1xufVxuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBpc0J1ZmZlcihhcmcpIHtcbiAgcmV0dXJuIGFyZyAmJiB0eXBlb2YgYXJnID09PSAnb2JqZWN0J1xuICAgICYmIHR5cGVvZiBhcmcuY29weSA9PT0gJ2Z1bmN0aW9uJ1xuICAgICYmIHR5cGVvZiBhcmcuZmlsbCA9PT0gJ2Z1bmN0aW9uJ1xuICAgICYmIHR5cGVvZiBhcmcucmVhZFVJbnQ4ID09PSAnZnVuY3Rpb24nO1xufSIsIihmdW5jdGlvbiAocHJvY2VzcyxnbG9iYWwpe1xuLy8gQ29weXJpZ2h0IEpveWVudCwgSW5jLiBhbmQgb3RoZXIgTm9kZSBjb250cmlidXRvcnMuXG4vL1xuLy8gUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGFcbi8vIGNvcHkgb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGVcbi8vIFwiU29mdHdhcmVcIiksIHRvIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZ1xuLy8gd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLFxuLy8gZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdFxuLy8gcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlXG4vLyBmb2xsb3dpbmcgY29uZGl0aW9uczpcbi8vXG4vLyBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZFxuLy8gaW4gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4vL1xuLy8gVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTU1xuLy8gT1IgSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRlxuLy8gTUVSQ0hBTlRBQklMSVRZLCBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTlxuLy8gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sXG4vLyBEQU1BR0VTIE9SIE9USEVSIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1Jcbi8vIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLCBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEVcbi8vIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuXG5cbnZhciBmb3JtYXRSZWdFeHAgPSAvJVtzZGolXS9nO1xuZXhwb3J0cy5mb3JtYXQgPSBmdW5jdGlvbihmKSB7XG4gIGlmICghaXNTdHJpbmcoZikpIHtcbiAgICB2YXIgb2JqZWN0cyA9IFtdO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBvYmplY3RzLnB1c2goaW5zcGVjdChhcmd1bWVudHNbaV0pKTtcbiAgICB9XG4gICAgcmV0dXJuIG9iamVjdHMuam9pbignICcpO1xuICB9XG5cbiAgdmFyIGkgPSAxO1xuICB2YXIgYXJncyA9IGFyZ3VtZW50cztcbiAgdmFyIGxlbiA9IGFyZ3MubGVuZ3RoO1xuICB2YXIgc3RyID0gU3RyaW5nKGYpLnJlcGxhY2UoZm9ybWF0UmVnRXhwLCBmdW5jdGlvbih4KSB7XG4gICAgaWYgKHggPT09ICclJScpIHJldHVybiAnJSc7XG4gICAgaWYgKGkgPj0gbGVuKSByZXR1cm4geDtcbiAgICBzd2l0Y2ggKHgpIHtcbiAgICAgIGNhc2UgJyVzJzogcmV0dXJuIFN0cmluZyhhcmdzW2krK10pO1xuICAgICAgY2FzZSAnJWQnOiByZXR1cm4gTnVtYmVyKGFyZ3NbaSsrXSk7XG4gICAgICBjYXNlICclaic6XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGFyZ3NbaSsrXSk7XG4gICAgICAgIH0gY2F0Y2ggKF8pIHtcbiAgICAgICAgICByZXR1cm4gJ1tDaXJjdWxhcl0nO1xuICAgICAgICB9XG4gICAgICBkZWZhdWx0OlxuICAgICAgICByZXR1cm4geDtcbiAgICB9XG4gIH0pO1xuICBmb3IgKHZhciB4ID0gYXJnc1tpXTsgaSA8IGxlbjsgeCA9IGFyZ3NbKytpXSkge1xuICAgIGlmIChpc051bGwoeCkgfHwgIWlzT2JqZWN0KHgpKSB7XG4gICAgICBzdHIgKz0gJyAnICsgeDtcbiAgICB9IGVsc2Uge1xuICAgICAgc3RyICs9ICcgJyArIGluc3BlY3QoeCk7XG4gICAgfVxuICB9XG4gIHJldHVybiBzdHI7XG59O1xuXG5cbi8vIE1hcmsgdGhhdCBhIG1ldGhvZCBzaG91bGQgbm90IGJlIHVzZWQuXG4vLyBSZXR1cm5zIGEgbW9kaWZpZWQgZnVuY3Rpb24gd2hpY2ggd2FybnMgb25jZSBieSBkZWZhdWx0LlxuLy8gSWYgLS1uby1kZXByZWNhdGlvbiBpcyBzZXQsIHRoZW4gaXQgaXMgYSBuby1vcC5cbmV4cG9ydHMuZGVwcmVjYXRlID0gZnVuY3Rpb24oZm4sIG1zZykge1xuICAvLyBBbGxvdyBmb3IgZGVwcmVjYXRpbmcgdGhpbmdzIGluIHRoZSBwcm9jZXNzIG9mIHN0YXJ0aW5nIHVwLlxuICBpZiAoaXNVbmRlZmluZWQoZ2xvYmFsLnByb2Nlc3MpKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgcmV0dXJuIGV4cG9ydHMuZGVwcmVjYXRlKGZuLCBtc2cpLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfTtcbiAgfVxuXG4gIGlmIChwcm9jZXNzLm5vRGVwcmVjYXRpb24gPT09IHRydWUpIHtcbiAgICByZXR1cm4gZm47XG4gIH1cblxuICB2YXIgd2FybmVkID0gZmFsc2U7XG4gIGZ1bmN0aW9uIGRlcHJlY2F0ZWQoKSB7XG4gICAgaWYgKCF3YXJuZWQpIHtcbiAgICAgIGlmIChwcm9jZXNzLnRocm93RGVwcmVjYXRpb24pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1zZyk7XG4gICAgICB9IGVsc2UgaWYgKHByb2Nlc3MudHJhY2VEZXByZWNhdGlvbikge1xuICAgICAgICBjb25zb2xlLnRyYWNlKG1zZyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmVycm9yKG1zZyk7XG4gICAgICB9XG4gICAgICB3YXJuZWQgPSB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgfVxuXG4gIHJldHVybiBkZXByZWNhdGVkO1xufTtcblxuXG52YXIgZGVidWdzID0ge307XG52YXIgZGVidWdFbnZpcm9uO1xuZXhwb3J0cy5kZWJ1Z2xvZyA9IGZ1bmN0aW9uKHNldCkge1xuICBpZiAoaXNVbmRlZmluZWQoZGVidWdFbnZpcm9uKSlcbiAgICBkZWJ1Z0Vudmlyb24gPSBwcm9jZXNzLmVudi5OT0RFX0RFQlVHIHx8ICcnO1xuICBzZXQgPSBzZXQudG9VcHBlckNhc2UoKTtcbiAgaWYgKCFkZWJ1Z3Nbc2V0XSkge1xuICAgIGlmIChuZXcgUmVnRXhwKCdcXFxcYicgKyBzZXQgKyAnXFxcXGInLCAnaScpLnRlc3QoZGVidWdFbnZpcm9uKSkge1xuICAgICAgdmFyIHBpZCA9IHByb2Nlc3MucGlkO1xuICAgICAgZGVidWdzW3NldF0gPSBmdW5jdGlvbigpIHtcbiAgICAgICAgdmFyIG1zZyA9IGV4cG9ydHMuZm9ybWF0LmFwcGx5KGV4cG9ydHMsIGFyZ3VtZW50cyk7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoJyVzICVkOiAlcycsIHNldCwgcGlkLCBtc2cpO1xuICAgICAgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgZGVidWdzW3NldF0gPSBmdW5jdGlvbigpIHt9O1xuICAgIH1cbiAgfVxuICByZXR1cm4gZGVidWdzW3NldF07XG59O1xuXG5cbi8qKlxuICogRWNob3MgdGhlIHZhbHVlIG9mIGEgdmFsdWUuIFRyeXMgdG8gcHJpbnQgdGhlIHZhbHVlIG91dFxuICogaW4gdGhlIGJlc3Qgd2F5IHBvc3NpYmxlIGdpdmVuIHRoZSBkaWZmZXJlbnQgdHlwZXMuXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IG9iaiBUaGUgb2JqZWN0IHRvIHByaW50IG91dC5cbiAqIEBwYXJhbSB7T2JqZWN0fSBvcHRzIE9wdGlvbmFsIG9wdGlvbnMgb2JqZWN0IHRoYXQgYWx0ZXJzIHRoZSBvdXRwdXQuXG4gKi9cbi8qIGxlZ2FjeTogb2JqLCBzaG93SGlkZGVuLCBkZXB0aCwgY29sb3JzKi9cbmZ1bmN0aW9uIGluc3BlY3Qob2JqLCBvcHRzKSB7XG4gIC8vIGRlZmF1bHQgb3B0aW9uc1xuICB2YXIgY3R4ID0ge1xuICAgIHNlZW46IFtdLFxuICAgIHN0eWxpemU6IHN0eWxpemVOb0NvbG9yXG4gIH07XG4gIC8vIGxlZ2FjeS4uLlxuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+PSAzKSBjdHguZGVwdGggPSBhcmd1bWVudHNbMl07XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID49IDQpIGN0eC5jb2xvcnMgPSBhcmd1bWVudHNbM107XG4gIGlmIChpc0Jvb2xlYW4ob3B0cykpIHtcbiAgICAvLyBsZWdhY3kuLi5cbiAgICBjdHguc2hvd0hpZGRlbiA9IG9wdHM7XG4gIH0gZWxzZSBpZiAob3B0cykge1xuICAgIC8vIGdvdCBhbiBcIm9wdGlvbnNcIiBvYmplY3RcbiAgICBleHBvcnRzLl9leHRlbmQoY3R4LCBvcHRzKTtcbiAgfVxuICAvLyBzZXQgZGVmYXVsdCBvcHRpb25zXG4gIGlmIChpc1VuZGVmaW5lZChjdHguc2hvd0hpZGRlbikpIGN0eC5zaG93SGlkZGVuID0gZmFsc2U7XG4gIGlmIChpc1VuZGVmaW5lZChjdHguZGVwdGgpKSBjdHguZGVwdGggPSAyO1xuICBpZiAoaXNVbmRlZmluZWQoY3R4LmNvbG9ycykpIGN0eC5jb2xvcnMgPSBmYWxzZTtcbiAgaWYgKGlzVW5kZWZpbmVkKGN0eC5jdXN0b21JbnNwZWN0KSkgY3R4LmN1c3RvbUluc3BlY3QgPSB0cnVlO1xuICBpZiAoY3R4LmNvbG9ycykgY3R4LnN0eWxpemUgPSBzdHlsaXplV2l0aENvbG9yO1xuICByZXR1cm4gZm9ybWF0VmFsdWUoY3R4LCBvYmosIGN0eC5kZXB0aCk7XG59XG5leHBvcnRzLmluc3BlY3QgPSBpbnNwZWN0O1xuXG5cbi8vIGh0dHA6Ly9lbi53aWtpcGVkaWEub3JnL3dpa2kvQU5TSV9lc2NhcGVfY29kZSNncmFwaGljc1xuaW5zcGVjdC5jb2xvcnMgPSB7XG4gICdib2xkJyA6IFsxLCAyMl0sXG4gICdpdGFsaWMnIDogWzMsIDIzXSxcbiAgJ3VuZGVybGluZScgOiBbNCwgMjRdLFxuICAnaW52ZXJzZScgOiBbNywgMjddLFxuICAnd2hpdGUnIDogWzM3LCAzOV0sXG4gICdncmV5JyA6IFs5MCwgMzldLFxuICAnYmxhY2snIDogWzMwLCAzOV0sXG4gICdibHVlJyA6IFszNCwgMzldLFxuICAnY3lhbicgOiBbMzYsIDM5XSxcbiAgJ2dyZWVuJyA6IFszMiwgMzldLFxuICAnbWFnZW50YScgOiBbMzUsIDM5XSxcbiAgJ3JlZCcgOiBbMzEsIDM5XSxcbiAgJ3llbGxvdycgOiBbMzMsIDM5XVxufTtcblxuLy8gRG9uJ3QgdXNlICdibHVlJyBub3QgdmlzaWJsZSBvbiBjbWQuZXhlXG5pbnNwZWN0LnN0eWxlcyA9IHtcbiAgJ3NwZWNpYWwnOiAnY3lhbicsXG4gICdudW1iZXInOiAneWVsbG93JyxcbiAgJ2Jvb2xlYW4nOiAneWVsbG93JyxcbiAgJ3VuZGVmaW5lZCc6ICdncmV5JyxcbiAgJ251bGwnOiAnYm9sZCcsXG4gICdzdHJpbmcnOiAnZ3JlZW4nLFxuICAnZGF0ZSc6ICdtYWdlbnRhJyxcbiAgLy8gXCJuYW1lXCI6IGludGVudGlvbmFsbHkgbm90IHN0eWxpbmdcbiAgJ3JlZ2V4cCc6ICdyZWQnXG59O1xuXG5cbmZ1bmN0aW9uIHN0eWxpemVXaXRoQ29sb3Ioc3RyLCBzdHlsZVR5cGUpIHtcbiAgdmFyIHN0eWxlID0gaW5zcGVjdC5zdHlsZXNbc3R5bGVUeXBlXTtcblxuICBpZiAoc3R5bGUpIHtcbiAgICByZXR1cm4gJ1xcdTAwMWJbJyArIGluc3BlY3QuY29sb3JzW3N0eWxlXVswXSArICdtJyArIHN0ciArXG4gICAgICAgICAgICdcXHUwMDFiWycgKyBpbnNwZWN0LmNvbG9yc1tzdHlsZV1bMV0gKyAnbSc7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIHN0cjtcbiAgfVxufVxuXG5cbmZ1bmN0aW9uIHN0eWxpemVOb0NvbG9yKHN0ciwgc3R5bGVUeXBlKSB7XG4gIHJldHVybiBzdHI7XG59XG5cblxuZnVuY3Rpb24gYXJyYXlUb0hhc2goYXJyYXkpIHtcbiAgdmFyIGhhc2ggPSB7fTtcblxuICBhcnJheS5mb3JFYWNoKGZ1bmN0aW9uKHZhbCwgaWR4KSB7XG4gICAgaGFzaFt2YWxdID0gdHJ1ZTtcbiAgfSk7XG5cbiAgcmV0dXJuIGhhc2g7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0VmFsdWUoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzKSB7XG4gIC8vIFByb3ZpZGUgYSBob29rIGZvciB1c2VyLXNwZWNpZmllZCBpbnNwZWN0IGZ1bmN0aW9ucy5cbiAgLy8gQ2hlY2sgdGhhdCB2YWx1ZSBpcyBhbiBvYmplY3Qgd2l0aCBhbiBpbnNwZWN0IGZ1bmN0aW9uIG9uIGl0XG4gIGlmIChjdHguY3VzdG9tSW5zcGVjdCAmJlxuICAgICAgdmFsdWUgJiZcbiAgICAgIGlzRnVuY3Rpb24odmFsdWUuaW5zcGVjdCkgJiZcbiAgICAgIC8vIEZpbHRlciBvdXQgdGhlIHV0aWwgbW9kdWxlLCBpdCdzIGluc3BlY3QgZnVuY3Rpb24gaXMgc3BlY2lhbFxuICAgICAgdmFsdWUuaW5zcGVjdCAhPT0gZXhwb3J0cy5pbnNwZWN0ICYmXG4gICAgICAvLyBBbHNvIGZpbHRlciBvdXQgYW55IHByb3RvdHlwZSBvYmplY3RzIHVzaW5nIHRoZSBjaXJjdWxhciBjaGVjay5cbiAgICAgICEodmFsdWUuY29uc3RydWN0b3IgJiYgdmFsdWUuY29uc3RydWN0b3IucHJvdG90eXBlID09PSB2YWx1ZSkpIHtcbiAgICB2YXIgcmV0ID0gdmFsdWUuaW5zcGVjdChyZWN1cnNlVGltZXMsIGN0eCk7XG4gICAgaWYgKCFpc1N0cmluZyhyZXQpKSB7XG4gICAgICByZXQgPSBmb3JtYXRWYWx1ZShjdHgsIHJldCwgcmVjdXJzZVRpbWVzKTtcbiAgICB9XG4gICAgcmV0dXJuIHJldDtcbiAgfVxuXG4gIC8vIFByaW1pdGl2ZSB0eXBlcyBjYW5ub3QgaGF2ZSBwcm9wZXJ0aWVzXG4gIHZhciBwcmltaXRpdmUgPSBmb3JtYXRQcmltaXRpdmUoY3R4LCB2YWx1ZSk7XG4gIGlmIChwcmltaXRpdmUpIHtcbiAgICByZXR1cm4gcHJpbWl0aXZlO1xuICB9XG5cbiAgLy8gTG9vayB1cCB0aGUga2V5cyBvZiB0aGUgb2JqZWN0LlxuICB2YXIga2V5cyA9IE9iamVjdC5rZXlzKHZhbHVlKTtcbiAgdmFyIHZpc2libGVLZXlzID0gYXJyYXlUb0hhc2goa2V5cyk7XG5cbiAgaWYgKGN0eC5zaG93SGlkZGVuKSB7XG4gICAga2V5cyA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eU5hbWVzKHZhbHVlKTtcbiAgfVxuXG4gIC8vIElFIGRvZXNuJ3QgbWFrZSBlcnJvciBmaWVsZHMgbm9uLWVudW1lcmFibGVcbiAgLy8gaHR0cDovL21zZG4ubWljcm9zb2Z0LmNvbS9lbi11cy9saWJyYXJ5L2llL2R3dzUyc2J0KHY9dnMuOTQpLmFzcHhcbiAgaWYgKGlzRXJyb3IodmFsdWUpXG4gICAgICAmJiAoa2V5cy5pbmRleE9mKCdtZXNzYWdlJykgPj0gMCB8fCBrZXlzLmluZGV4T2YoJ2Rlc2NyaXB0aW9uJykgPj0gMCkpIHtcbiAgICByZXR1cm4gZm9ybWF0RXJyb3IodmFsdWUpO1xuICB9XG5cbiAgLy8gU29tZSB0eXBlIG9mIG9iamVjdCB3aXRob3V0IHByb3BlcnRpZXMgY2FuIGJlIHNob3J0Y3V0dGVkLlxuICBpZiAoa2V5cy5sZW5ndGggPT09IDApIHtcbiAgICBpZiAoaXNGdW5jdGlvbih2YWx1ZSkpIHtcbiAgICAgIHZhciBuYW1lID0gdmFsdWUubmFtZSA/ICc6ICcgKyB2YWx1ZS5uYW1lIDogJyc7XG4gICAgICByZXR1cm4gY3R4LnN0eWxpemUoJ1tGdW5jdGlvbicgKyBuYW1lICsgJ10nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgICBpZiAoaXNSZWdFeHAodmFsdWUpKSB7XG4gICAgICByZXR1cm4gY3R4LnN0eWxpemUoUmVnRXhwLnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHZhbHVlKSwgJ3JlZ2V4cCcpO1xuICAgIH1cbiAgICBpZiAoaXNEYXRlKHZhbHVlKSkge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKERhdGUucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpLCAnZGF0ZScpO1xuICAgIH1cbiAgICBpZiAoaXNFcnJvcih2YWx1ZSkpIHtcbiAgICAgIHJldHVybiBmb3JtYXRFcnJvcih2YWx1ZSk7XG4gICAgfVxuICB9XG5cbiAgdmFyIGJhc2UgPSAnJywgYXJyYXkgPSBmYWxzZSwgYnJhY2VzID0gWyd7JywgJ30nXTtcblxuICAvLyBNYWtlIEFycmF5IHNheSB0aGF0IHRoZXkgYXJlIEFycmF5XG4gIGlmIChpc0FycmF5KHZhbHVlKSkge1xuICAgIGFycmF5ID0gdHJ1ZTtcbiAgICBicmFjZXMgPSBbJ1snLCAnXSddO1xuICB9XG5cbiAgLy8gTWFrZSBmdW5jdGlvbnMgc2F5IHRoYXQgdGhleSBhcmUgZnVuY3Rpb25zXG4gIGlmIChpc0Z1bmN0aW9uKHZhbHVlKSkge1xuICAgIHZhciBuID0gdmFsdWUubmFtZSA/ICc6ICcgKyB2YWx1ZS5uYW1lIDogJyc7XG4gICAgYmFzZSA9ICcgW0Z1bmN0aW9uJyArIG4gKyAnXSc7XG4gIH1cblxuICAvLyBNYWtlIFJlZ0V4cHMgc2F5IHRoYXQgdGhleSBhcmUgUmVnRXhwc1xuICBpZiAoaXNSZWdFeHAodmFsdWUpKSB7XG4gICAgYmFzZSA9ICcgJyArIFJlZ0V4cC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSk7XG4gIH1cblxuICAvLyBNYWtlIGRhdGVzIHdpdGggcHJvcGVydGllcyBmaXJzdCBzYXkgdGhlIGRhdGVcbiAgaWYgKGlzRGF0ZSh2YWx1ZSkpIHtcbiAgICBiYXNlID0gJyAnICsgRGF0ZS5wcm90b3R5cGUudG9VVENTdHJpbmcuY2FsbCh2YWx1ZSk7XG4gIH1cblxuICAvLyBNYWtlIGVycm9yIHdpdGggbWVzc2FnZSBmaXJzdCBzYXkgdGhlIGVycm9yXG4gIGlmIChpc0Vycm9yKHZhbHVlKSkge1xuICAgIGJhc2UgPSAnICcgKyBmb3JtYXRFcnJvcih2YWx1ZSk7XG4gIH1cblxuICBpZiAoa2V5cy5sZW5ndGggPT09IDAgJiYgKCFhcnJheSB8fCB2YWx1ZS5sZW5ndGggPT0gMCkpIHtcbiAgICByZXR1cm4gYnJhY2VzWzBdICsgYmFzZSArIGJyYWNlc1sxXTtcbiAgfVxuXG4gIGlmIChyZWN1cnNlVGltZXMgPCAwKSB7XG4gICAgaWYgKGlzUmVnRXhwKHZhbHVlKSkge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKFJlZ0V4cC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSksICdyZWdleHAnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKCdbT2JqZWN0XScsICdzcGVjaWFsJyk7XG4gICAgfVxuICB9XG5cbiAgY3R4LnNlZW4ucHVzaCh2YWx1ZSk7XG5cbiAgdmFyIG91dHB1dDtcbiAgaWYgKGFycmF5KSB7XG4gICAgb3V0cHV0ID0gZm9ybWF0QXJyYXkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5cyk7XG4gIH0gZWxzZSB7XG4gICAgb3V0cHV0ID0ga2V5cy5tYXAoZnVuY3Rpb24oa2V5KSB7XG4gICAgICByZXR1cm4gZm9ybWF0UHJvcGVydHkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5LCBhcnJheSk7XG4gICAgfSk7XG4gIH1cblxuICBjdHguc2Vlbi5wb3AoKTtcblxuICByZXR1cm4gcmVkdWNlVG9TaW5nbGVTdHJpbmcob3V0cHV0LCBiYXNlLCBicmFjZXMpO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdFByaW1pdGl2ZShjdHgsIHZhbHVlKSB7XG4gIGlmIChpc1VuZGVmaW5lZCh2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCd1bmRlZmluZWQnLCAndW5kZWZpbmVkJyk7XG4gIGlmIChpc1N0cmluZyh2YWx1ZSkpIHtcbiAgICB2YXIgc2ltcGxlID0gJ1xcJycgKyBKU09OLnN0cmluZ2lmeSh2YWx1ZSkucmVwbGFjZSgvXlwifFwiJC9nLCAnJylcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIilcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXFxcXCIvZywgJ1wiJykgKyAnXFwnJztcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoc2ltcGxlLCAnc3RyaW5nJyk7XG4gIH1cbiAgaWYgKGlzTnVtYmVyKHZhbHVlKSlcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoJycgKyB2YWx1ZSwgJ251bWJlcicpO1xuICBpZiAoaXNCb29sZWFuKHZhbHVlKSlcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoJycgKyB2YWx1ZSwgJ2Jvb2xlYW4nKTtcbiAgLy8gRm9yIHNvbWUgcmVhc29uIHR5cGVvZiBudWxsIGlzIFwib2JqZWN0XCIsIHNvIHNwZWNpYWwgY2FzZSBoZXJlLlxuICBpZiAoaXNOdWxsKHZhbHVlKSlcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoJ251bGwnLCAnbnVsbCcpO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdEVycm9yKHZhbHVlKSB7XG4gIHJldHVybiAnWycgKyBFcnJvci5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSkgKyAnXSc7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0QXJyYXkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5cykge1xuICB2YXIgb3V0cHV0ID0gW107XG4gIGZvciAodmFyIGkgPSAwLCBsID0gdmFsdWUubGVuZ3RoOyBpIDwgbDsgKytpKSB7XG4gICAgaWYgKGhhc093blByb3BlcnR5KHZhbHVlLCBTdHJpbmcoaSkpKSB7XG4gICAgICBvdXRwdXQucHVzaChmb3JtYXRQcm9wZXJ0eShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLFxuICAgICAgICAgIFN0cmluZyhpKSwgdHJ1ZSkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBvdXRwdXQucHVzaCgnJyk7XG4gICAgfVxuICB9XG4gIGtleXMuZm9yRWFjaChmdW5jdGlvbihrZXkpIHtcbiAgICBpZiAoIWtleS5tYXRjaCgvXlxcZCskLykpIHtcbiAgICAgIG91dHB1dC5wdXNoKGZvcm1hdFByb3BlcnR5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsXG4gICAgICAgICAga2V5LCB0cnVlKSk7XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIG91dHB1dDtcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRQcm9wZXJ0eShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLCBrZXksIGFycmF5KSB7XG4gIHZhciBuYW1lLCBzdHIsIGRlc2M7XG4gIGRlc2MgPSBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKHZhbHVlLCBrZXkpIHx8IHsgdmFsdWU6IHZhbHVlW2tleV0gfTtcbiAgaWYgKGRlc2MuZ2V0KSB7XG4gICAgaWYgKGRlc2Muc2V0KSB7XG4gICAgICBzdHIgPSBjdHguc3R5bGl6ZSgnW0dldHRlci9TZXR0ZXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3RyID0gY3R4LnN0eWxpemUoJ1tHZXR0ZXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgaWYgKGRlc2Muc2V0KSB7XG4gICAgICBzdHIgPSBjdHguc3R5bGl6ZSgnW1NldHRlcl0nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgfVxuICBpZiAoIWhhc093blByb3BlcnR5KHZpc2libGVLZXlzLCBrZXkpKSB7XG4gICAgbmFtZSA9ICdbJyArIGtleSArICddJztcbiAgfVxuICBpZiAoIXN0cikge1xuICAgIGlmIChjdHguc2Vlbi5pbmRleE9mKGRlc2MudmFsdWUpIDwgMCkge1xuICAgICAgaWYgKGlzTnVsbChyZWN1cnNlVGltZXMpKSB7XG4gICAgICAgIHN0ciA9IGZvcm1hdFZhbHVlKGN0eCwgZGVzYy52YWx1ZSwgbnVsbCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzdHIgPSBmb3JtYXRWYWx1ZShjdHgsIGRlc2MudmFsdWUsIHJlY3Vyc2VUaW1lcyAtIDEpO1xuICAgICAgfVxuICAgICAgaWYgKHN0ci5pbmRleE9mKCdcXG4nKSA+IC0xKSB7XG4gICAgICAgIGlmIChhcnJheSkge1xuICAgICAgICAgIHN0ciA9IHN0ci5zcGxpdCgnXFxuJykubWFwKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgICAgICAgIHJldHVybiAnICAnICsgbGluZTtcbiAgICAgICAgICB9KS5qb2luKCdcXG4nKS5zdWJzdHIoMik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc3RyID0gJ1xcbicgKyBzdHIuc3BsaXQoJ1xcbicpLm1hcChmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgICAgICByZXR1cm4gJyAgICcgKyBsaW5lO1xuICAgICAgICAgIH0pLmpvaW4oJ1xcbicpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0ciA9IGN0eC5zdHlsaXplKCdbQ2lyY3VsYXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gIH1cbiAgaWYgKGlzVW5kZWZpbmVkKG5hbWUpKSB7XG4gICAgaWYgKGFycmF5ICYmIGtleS5tYXRjaCgvXlxcZCskLykpIHtcbiAgICAgIHJldHVybiBzdHI7XG4gICAgfVxuICAgIG5hbWUgPSBKU09OLnN0cmluZ2lmeSgnJyArIGtleSk7XG4gICAgaWYgKG5hbWUubWF0Y2goL15cIihbYS16QS1aX11bYS16QS1aXzAtOV0qKVwiJC8pKSB7XG4gICAgICBuYW1lID0gbmFtZS5zdWJzdHIoMSwgbmFtZS5sZW5ndGggLSAyKTtcbiAgICAgIG5hbWUgPSBjdHguc3R5bGl6ZShuYW1lLCAnbmFtZScpO1xuICAgIH0gZWxzZSB7XG4gICAgICBuYW1lID0gbmFtZS5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIilcbiAgICAgICAgICAgICAgICAgLnJlcGxhY2UoL1xcXFxcIi9nLCAnXCInKVxuICAgICAgICAgICAgICAgICAucmVwbGFjZSgvKF5cInxcIiQpL2csIFwiJ1wiKTtcbiAgICAgIG5hbWUgPSBjdHguc3R5bGl6ZShuYW1lLCAnc3RyaW5nJyk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG5hbWUgKyAnOiAnICsgc3RyO1xufVxuXG5cbmZ1bmN0aW9uIHJlZHVjZVRvU2luZ2xlU3RyaW5nKG91dHB1dCwgYmFzZSwgYnJhY2VzKSB7XG4gIHZhciBudW1MaW5lc0VzdCA9IDA7XG4gIHZhciBsZW5ndGggPSBvdXRwdXQucmVkdWNlKGZ1bmN0aW9uKHByZXYsIGN1cikge1xuICAgIG51bUxpbmVzRXN0Kys7XG4gICAgaWYgKGN1ci5pbmRleE9mKCdcXG4nKSA+PSAwKSBudW1MaW5lc0VzdCsrO1xuICAgIHJldHVybiBwcmV2ICsgY3VyLnJlcGxhY2UoL1xcdTAwMWJcXFtcXGRcXGQ/bS9nLCAnJykubGVuZ3RoICsgMTtcbiAgfSwgMCk7XG5cbiAgaWYgKGxlbmd0aCA+IDYwKSB7XG4gICAgcmV0dXJuIGJyYWNlc1swXSArXG4gICAgICAgICAgIChiYXNlID09PSAnJyA/ICcnIDogYmFzZSArICdcXG4gJykgK1xuICAgICAgICAgICAnICcgK1xuICAgICAgICAgICBvdXRwdXQuam9pbignLFxcbiAgJykgK1xuICAgICAgICAgICAnICcgK1xuICAgICAgICAgICBicmFjZXNbMV07XG4gIH1cblxuICByZXR1cm4gYnJhY2VzWzBdICsgYmFzZSArICcgJyArIG91dHB1dC5qb2luKCcsICcpICsgJyAnICsgYnJhY2VzWzFdO1xufVxuXG5cbi8vIE5PVEU6IFRoZXNlIHR5cGUgY2hlY2tpbmcgZnVuY3Rpb25zIGludGVudGlvbmFsbHkgZG9uJ3QgdXNlIGBpbnN0YW5jZW9mYFxuLy8gYmVjYXVzZSBpdCBpcyBmcmFnaWxlIGFuZCBjYW4gYmUgZWFzaWx5IGZha2VkIHdpdGggYE9iamVjdC5jcmVhdGUoKWAuXG5mdW5jdGlvbiBpc0FycmF5KGFyKSB7XG4gIHJldHVybiBBcnJheS5pc0FycmF5KGFyKTtcbn1cbmV4cG9ydHMuaXNBcnJheSA9IGlzQXJyYXk7XG5cbmZ1bmN0aW9uIGlzQm9vbGVhbihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdib29sZWFuJztcbn1cbmV4cG9ydHMuaXNCb29sZWFuID0gaXNCb29sZWFuO1xuXG5mdW5jdGlvbiBpc051bGwoYXJnKSB7XG4gIHJldHVybiBhcmcgPT09IG51bGw7XG59XG5leHBvcnRzLmlzTnVsbCA9IGlzTnVsbDtcblxuZnVuY3Rpb24gaXNOdWxsT3JVbmRlZmluZWQoYXJnKSB7XG4gIHJldHVybiBhcmcgPT0gbnVsbDtcbn1cbmV4cG9ydHMuaXNOdWxsT3JVbmRlZmluZWQgPSBpc051bGxPclVuZGVmaW5lZDtcblxuZnVuY3Rpb24gaXNOdW1iZXIoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnbnVtYmVyJztcbn1cbmV4cG9ydHMuaXNOdW1iZXIgPSBpc051bWJlcjtcblxuZnVuY3Rpb24gaXNTdHJpbmcoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnc3RyaW5nJztcbn1cbmV4cG9ydHMuaXNTdHJpbmcgPSBpc1N0cmluZztcblxuZnVuY3Rpb24gaXNTeW1ib2woYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnc3ltYm9sJztcbn1cbmV4cG9ydHMuaXNTeW1ib2wgPSBpc1N5bWJvbDtcblxuZnVuY3Rpb24gaXNVbmRlZmluZWQoYXJnKSB7XG4gIHJldHVybiBhcmcgPT09IHZvaWQgMDtcbn1cbmV4cG9ydHMuaXNVbmRlZmluZWQgPSBpc1VuZGVmaW5lZDtcblxuZnVuY3Rpb24gaXNSZWdFeHAocmUpIHtcbiAgcmV0dXJuIGlzT2JqZWN0KHJlKSAmJiBvYmplY3RUb1N0cmluZyhyZSkgPT09ICdbb2JqZWN0IFJlZ0V4cF0nO1xufVxuZXhwb3J0cy5pc1JlZ0V4cCA9IGlzUmVnRXhwO1xuXG5mdW5jdGlvbiBpc09iamVjdChhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdvYmplY3QnICYmIGFyZyAhPT0gbnVsbDtcbn1cbmV4cG9ydHMuaXNPYmplY3QgPSBpc09iamVjdDtcblxuZnVuY3Rpb24gaXNEYXRlKGQpIHtcbiAgcmV0dXJuIGlzT2JqZWN0KGQpICYmIG9iamVjdFRvU3RyaW5nKGQpID09PSAnW29iamVjdCBEYXRlXSc7XG59XG5leHBvcnRzLmlzRGF0ZSA9IGlzRGF0ZTtcblxuZnVuY3Rpb24gaXNFcnJvcihlKSB7XG4gIHJldHVybiBpc09iamVjdChlKSAmJlxuICAgICAgKG9iamVjdFRvU3RyaW5nKGUpID09PSAnW29iamVjdCBFcnJvcl0nIHx8IGUgaW5zdGFuY2VvZiBFcnJvcik7XG59XG5leHBvcnRzLmlzRXJyb3IgPSBpc0Vycm9yO1xuXG5mdW5jdGlvbiBpc0Z1bmN0aW9uKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ2Z1bmN0aW9uJztcbn1cbmV4cG9ydHMuaXNGdW5jdGlvbiA9IGlzRnVuY3Rpb247XG5cbmZ1bmN0aW9uIGlzUHJpbWl0aXZlKGFyZykge1xuICByZXR1cm4gYXJnID09PSBudWxsIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnYm9vbGVhbicgfHxcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICdudW1iZXInIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnc3RyaW5nJyB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ3N5bWJvbCcgfHwgIC8vIEVTNiBzeW1ib2xcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICd1bmRlZmluZWQnO1xufVxuZXhwb3J0cy5pc1ByaW1pdGl2ZSA9IGlzUHJpbWl0aXZlO1xuXG5leHBvcnRzLmlzQnVmZmVyID0gcmVxdWlyZSgnLi9zdXBwb3J0L2lzQnVmZmVyJyk7XG5cbmZ1bmN0aW9uIG9iamVjdFRvU3RyaW5nKG8pIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChvKTtcbn1cblxuXG5mdW5jdGlvbiBwYWQobikge1xuICByZXR1cm4gbiA8IDEwID8gJzAnICsgbi50b1N0cmluZygxMCkgOiBuLnRvU3RyaW5nKDEwKTtcbn1cblxuXG52YXIgbW9udGhzID0gWydKYW4nLCAnRmViJywgJ01hcicsICdBcHInLCAnTWF5JywgJ0p1bicsICdKdWwnLCAnQXVnJywgJ1NlcCcsXG4gICAgICAgICAgICAgICdPY3QnLCAnTm92JywgJ0RlYyddO1xuXG4vLyAyNiBGZWIgMTY6MTk6MzRcbmZ1bmN0aW9uIHRpbWVzdGFtcCgpIHtcbiAgdmFyIGQgPSBuZXcgRGF0ZSgpO1xuICB2YXIgdGltZSA9IFtwYWQoZC5nZXRIb3VycygpKSxcbiAgICAgICAgICAgICAgcGFkKGQuZ2V0TWludXRlcygpKSxcbiAgICAgICAgICAgICAgcGFkKGQuZ2V0U2Vjb25kcygpKV0uam9pbignOicpO1xuICByZXR1cm4gW2QuZ2V0RGF0ZSgpLCBtb250aHNbZC5nZXRNb250aCgpXSwgdGltZV0uam9pbignICcpO1xufVxuXG5cbi8vIGxvZyBpcyBqdXN0IGEgdGhpbiB3cmFwcGVyIHRvIGNvbnNvbGUubG9nIHRoYXQgcHJlcGVuZHMgYSB0aW1lc3RhbXBcbmV4cG9ydHMubG9nID0gZnVuY3Rpb24oKSB7XG4gIGNvbnNvbGUubG9nKCclcyAtICVzJywgdGltZXN0YW1wKCksIGV4cG9ydHMuZm9ybWF0LmFwcGx5KGV4cG9ydHMsIGFyZ3VtZW50cykpO1xufTtcblxuXG4vKipcbiAqIEluaGVyaXQgdGhlIHByb3RvdHlwZSBtZXRob2RzIGZyb20gb25lIGNvbnN0cnVjdG9yIGludG8gYW5vdGhlci5cbiAqXG4gKiBUaGUgRnVuY3Rpb24ucHJvdG90eXBlLmluaGVyaXRzIGZyb20gbGFuZy5qcyByZXdyaXR0ZW4gYXMgYSBzdGFuZGFsb25lXG4gKiBmdW5jdGlvbiAobm90IG9uIEZ1bmN0aW9uLnByb3RvdHlwZSkuIE5PVEU6IElmIHRoaXMgZmlsZSBpcyB0byBiZSBsb2FkZWRcbiAqIGR1cmluZyBib290c3RyYXBwaW5nIHRoaXMgZnVuY3Rpb24gbmVlZHMgdG8gYmUgcmV3cml0dGVuIHVzaW5nIHNvbWUgbmF0aXZlXG4gKiBmdW5jdGlvbnMgYXMgcHJvdG90eXBlIHNldHVwIHVzaW5nIG5vcm1hbCBKYXZhU2NyaXB0IGRvZXMgbm90IHdvcmsgYXNcbiAqIGV4cGVjdGVkIGR1cmluZyBib290c3RyYXBwaW5nIChzZWUgbWlycm9yLmpzIGluIHIxMTQ5MDMpLlxuICpcbiAqIEBwYXJhbSB7ZnVuY3Rpb259IGN0b3IgQ29uc3RydWN0b3IgZnVuY3Rpb24gd2hpY2ggbmVlZHMgdG8gaW5oZXJpdCB0aGVcbiAqICAgICBwcm90b3R5cGUuXG4gKiBAcGFyYW0ge2Z1bmN0aW9ufSBzdXBlckN0b3IgQ29uc3RydWN0b3IgZnVuY3Rpb24gdG8gaW5oZXJpdCBwcm90b3R5cGUgZnJvbS5cbiAqL1xuZXhwb3J0cy5pbmhlcml0cyA9IHJlcXVpcmUoJ2luaGVyaXRzJyk7XG5cbmV4cG9ydHMuX2V4dGVuZCA9IGZ1bmN0aW9uKG9yaWdpbiwgYWRkKSB7XG4gIC8vIERvbid0IGRvIGFueXRoaW5nIGlmIGFkZCBpc24ndCBhbiBvYmplY3RcbiAgaWYgKCFhZGQgfHwgIWlzT2JqZWN0KGFkZCkpIHJldHVybiBvcmlnaW47XG5cbiAgdmFyIGtleXMgPSBPYmplY3Qua2V5cyhhZGQpO1xuICB2YXIgaSA9IGtleXMubGVuZ3RoO1xuICB3aGlsZSAoaS0tKSB7XG4gICAgb3JpZ2luW2tleXNbaV1dID0gYWRkW2tleXNbaV1dO1xuICB9XG4gIHJldHVybiBvcmlnaW47XG59O1xuXG5mdW5jdGlvbiBoYXNPd25Qcm9wZXJ0eShvYmosIHByb3ApIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIHByb3ApO1xufVxuXG59KS5jYWxsKHRoaXMscmVxdWlyZSgnX3Byb2Nlc3MnKSx0eXBlb2YgZ2xvYmFsICE9PSBcInVuZGVmaW5lZFwiID8gZ2xvYmFsIDogdHlwZW9mIHNlbGYgIT09IFwidW5kZWZpbmVkXCIgPyBzZWxmIDogdHlwZW9mIHdpbmRvdyAhPT0gXCJ1bmRlZmluZWRcIiA/IHdpbmRvdyA6IHt9KSIsInZhciBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKS5FdmVudEVtaXR0ZXI7XG52YXIgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcblxudmFyIFNwcmF5ID0gcmVxdWlyZSgnc3ByYXktd3J0YycpO1xudmFyIENhdXNhbEJyb2FkY2FzdCA9IHJlcXVpcmUoJ2NhdXNhbC1icm9hZGNhc3QtZGVmaW5pdGlvbicpO1xudmFyIFZWd0UgPSByZXF1aXJlKCd2ZXJzaW9uLXZlY3Rvci13aXRoLWV4Y2VwdGlvbnMnKTtcbnZhciBMU0VRVHJlZSA9IHJlcXVpcmUoJ2xzZXF0cmVlJyk7XG52YXIgR1VJRCA9IHJlcXVpcmUoJy4vZ3VpZC5qcycpO1xuXG52YXIgTUluc2VydE9wZXJhdGlvbiA9IHJlcXVpcmUoJy4vbWVzc2FnZXMuanMnKS5NSW5zZXJ0T3BlcmF0aW9uO1xudmFyIE1BRUluc2VydE9wZXJhdGlvbiA9IHJlcXVpcmUoJy4vbWVzc2FnZXMuanMnKS5NQUVJbnNlcnRPcGVyYXRpb247XG52YXIgTVJlbW92ZU9wZXJhdGlvbiA9IHJlcXVpcmUoJy4vbWVzc2FnZXMuanMnKS5NUmVtb3ZlT3BlcmF0aW9uO1xuXG51dGlsLmluaGVyaXRzKENyYXRlQ29yZSwgRXZlbnRFbWl0dGVyKTtcblxuLyohXG4gKiBcXGJyaWVmIGxpbmsgdG9nZXRoZXIgYWxsIGNvbXBvbmVudHMgb2YgdGhlIG1vZGVsIG9mIHRoZSBDUkFURSBlZGl0b3JcbiAqIFxccGFyYW0gaWQgdGhlIHVuaXF1ZSBzaXRlIGlkZW50aWZpZXJcbiAqIFxccGFyYW0gb3B0aW9ucyB0aGUgd2VicnRjIHNwZWNpZmljIG9wdGlvbnMgXG4gKi9cbmZ1bmN0aW9uIENyYXRlQ29yZShpZCwgb3B0aW9ucyl7XG4gICAgRXZlbnRFbWl0dGVyLmNhbGwodGhpcyk7XG4gICAgXG4gICAgdGhpcy5pZCA9IGlkIHx8IEdVSUQoKTtcbiAgICB0aGlzLm9wdGlvbnMgPSBvcHRpb25zO1xuICAgIHRoaXMuYnJvYWRjYXN0ID0gbmV3IENhdXNhbEJyb2FkY2FzdChuZXcgU3ByYXkodGhpcy5pZCwgdGhpcy5vcHRpb25zKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmV3IFZWd0UodGhpcy5pZCkpO1xuICAgIHRoaXMuc2VxdWVuY2UgPSBuZXcgTFNFUVRyZWUodGhpcy5pZCk7XG5cbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgLy8gI0EgcmVndWxhciByZWNlaXZlXG4gICAgdGhpcy5icm9hZGNhc3Qub24oJ3JlY2VpdmUnLCBmdW5jdGlvbihyZWNlaXZlZEJyb2FkY2FzdE1lc3NhZ2Upe1xuICAgICAgICBzd2l0Y2ggKHJlY2VpdmVkQnJvYWRjYXN0TWVzc2FnZS50eXBlKXtcbiAgICAgICAgY2FzZSAnTVJlbW92ZU9wZXJhdGlvbic6XG4gICAgICAgICAgICBzZWxmLnJlbW90ZVJlbW92ZShyZWNlaXZlZEJyb2FkY2FzdE1lc3NhZ2UucmVtb3ZlKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdNSW5zZXJ0T3BlcmF0aW9uJzpcbiAgICAgICAgICAgIHNlbGYucmVtb3RlSW5zZXJ0KHJlY2VpdmVkQnJvYWRjYXN0TWVzc2FnZS5pbnNlcnQpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIH07XG4gICAgfSk7XG4gICAgLy8gI0IgYW50aS1lbnRyb3B5IGZvciB0aGUgbWlzc2luZyBvcGVyYXRpb25cbiAgICB0aGlzLmJyb2FkY2FzdC5vbignYW50aUVudHJvcHknLCBmdW5jdGlvbihzb2NrZXQsIHJlbW90ZVZWd0UsIGxvY2FsVlZ3RSl7XG4gICAgICAgIC8qdmFyIHJlbW90ZVZWd0UgPSAobmV3IFZWd0UobnVsbCkpLmZyb21KU09OKHJlbW90ZVZWd0UpOyAvLyBjYXN0XG4gICAgICAgIHZhciB0b1NlYXJjaCA9IFtdO1xuICAgICAgICAvLyAjMSBmb3IgZWFjaCBlbnRyeSBvZiBvdXIgVlZ3RSwgbG9vayBpZiB0aGUgcmVtb3RlIFZWd0Uga25vd3MgbGVzc1xuICAgICAgICBmb3IgKHZhciBpPTA7IGk8bG9jYWxWVndFLnZlY3Rvci5hcnIubGVuZ3RoOyArK2kpe1xuICAgICAgICAgICAgdmFyIGxvY2FsRW50cnkgPSBsb2NhbFZWd0UudmVjdG9yLmFycltpXTtcbiAgICAgICAgICAgIHZhciBpbmRleCA9IHJlbW90ZVZWd0UudmVjdG9yLmluZGV4T2YobG9jYWxWVndFLnZlY3Rvci5hcnJbaV0pO1xuICAgICAgICAgICAgdmFyIHN0YXJ0ID0gMTtcbiAgICAgICAgICAgIC8vICNBIGNoZWNrIGlmIHRoZSBlbnRyeSBleGlzdHMgaW4gdGhlIHJlbW90ZSB2dndlXG4gICAgICAgICAgICBpZiAoaW5kZXggPj0wKXsgc3RhcnQgPSByZW1vdGVWVndFLnZlY3Rvci5hcnJbaW5kZXhdLnYgKyAxOyB9O1xuICAgICAgICAgICAgZm9yICh2YXIgaj1zdGFydDsgajw9bG9jYWxFbnRyeS52OyArK2ope1xuICAgICAgICAgICAgICAgIC8vICNCIGNoZWNrIGlmIG5vdCBvbmUgb2YgdGhlIGxvY2FsIGV4Y2VwdGlvbnNcbiAgICAgICAgICAgICAgICBpZiAobG9jYWxFbnRyeS54LmluZGV4T2Yoaik8MCl7XG4gICAgICAgICAgICAgICAgICAgIHRvU2VhcmNoLnB1c2goe19lOiBsb2NhbEVudHJ5LmUsIF9jOiBqfSk7XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICAvLyAjQyBoYW5kbGUgdGhlIGV4Y2VwdGlvbnMgb2YgdGhlIHJlbW90ZSB2ZWN0b3JcbiAgICAgICAgICAgIGlmIChpbmRleCA+PTApe1xuICAgICAgICAgICAgICAgIGZvciAodmFyIGo9MDsgajxyZW1vdGVWVndFLnZlY3Rvci5hcnJbaW5kZXhdLngubGVuZ3RoOysrail7XG4gICAgICAgICAgICAgICAgICAgIHZhciBleGNlcHQgPSByZW1vdGVWVndFLnZlY3Rvci5hcnJbaW5kZXhdLnhbal07XG4gICAgICAgICAgICAgICAgICAgIGlmIChsb2NhbEVudHJ5LnguaW5kZXhPZihleGNlcHQpPDAgJiYgZXhjZXB0PD1sb2NhbEVudHJ5LnYpe1xuICAgICAgICAgICAgICAgICAgICAgICAgdG9TZWFyY2gucHVzaCh7X2U6IGxvY2FsRW50cnkuZSwgX2M6IGV4Y2VwdH0pO1xuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9O1xuICAgICAgICB9O1xuICAgICAgICB2YXIgZWxlbWVudHMgPSBzZWxmLmdldEVsZW1lbnRzKHRvU2VhcmNoKTsqL1xuICAgICAgICB2YXIgZWxlbWVudHMgPSBbXTtcbiAgICAgICAgLy8gIzIgc2VuZCBiYWNrIHRoZSBmb3VuZCBlbGVtZW50c1xuICAgICAgICBzZWxmLmJyb2FkY2FzdC5zZW5kQW50aUVudHJvcHlSZXNwb25zZShzb2NrZXQsIGxvY2FsVlZ3RSwgZWxlbWVudHMpO1xuICAgIH0pO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNyZWF0ZSB0aGUgY29yZSBmcm9tIGFuIGV4aXN0aW5nIG9iamVjdFxuICogXFxwYXJhbSBvYmplY3QgdGhlIG9iamVjdCB0byBpbml0aWFsaXplIHRoZSBjb3JlIG1vZGVsIG9mIGNyYXRlIGNvbnRhaW5pbmcgYSBcbiAqIHNlcXVlbmNlIGFuZCBjYXVzYWxpdHkgdHJhY2tpbmcgbWV0YWRhdGFcbiAqL1xuQ3JhdGVDb3JlLnByb3RvdHlwZS5pbml0ID0gZnVuY3Rpb24ob2JqZWN0KXtcbiAgICAvLyAoVE9ETylcbiAgICAvKiB0aGlzLmJyb2FkY2FzdCA9IG5ldyBDYXVzYWxCcm9hZGNhc3QobmV3IFNwcmF5KHRoaXMuaWQsIHRoaXMub3B0aW9ucyksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIChuZXcgVlZ3RSh0aGlzLmlkKSkuZnJvbUpTT04oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3QuY2F1c2FsaXR5KSk7XG4gICAgdGhpcy5zZXF1ZW5jZSA9IChuZXcgTFNFUVRyZWUoaWQpKS5mcm9tSlNPTihvYmplY3Quc2VxdWVuY2UpOyovXG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgbG9jYWwgaW5zZXJ0aW9uIG9mIGEgY2hhcmFjdGVyIGluc2lkZSB0aGUgc2VxdWVuY2Ugc3RydWN0dXJlLiBJdFxuICogYnJvYWRjYXN0cyB0aGUgb3BlcmF0aW9uIHRvIHRoZSByZXN0IG9mIHRoZSBuZXR3b3JrLlxuICogXFxwYXJhbSBjaGFyYWN0ZXIgdGhlIGNoYXJhY3RlciB0byBpbnNlcnQgaW4gdGhlIHNlcXVlbmNlXG4gKiBcXHBhcmFtIGluZGV4IHRoZSBpbmRleCBpbiB0aGUgc2VxdWVuY2UgdG8gaW5zZXJ0XG4gKiBcXHJldHVybiB0aGUgaWRlbnRpZmllciBmcmVzaGx5IGFsbG9jYXRlZFxuICovXG5DcmF0ZUNvcmUucHJvdG90eXBlLmluc2VydCA9IGZ1bmN0aW9uKGNoYXJhY3RlciwgaW5kZXgpe1xuICAgIHZhciBlaSA9IHRoaXMuc2VxdWVuY2UuaW5zZXJ0KGNoYXJhY3RlciwgaW5kZXgpO1xuICAgIHZhciBpZCA9IHtfZTogZWkuX2kuX3NbZWkuX2kuX3MubGVuZ3RoLTFdLCBfYzogZWkuX2kuX2NbZWkuX2kuX2MubGVuZ3RoLTFdfTtcbiAgICB0aGlzLmJyb2FkY2FzdC5zZW5kKG5ldyBNSW5zZXJ0T3BlcmF0aW9uKGVpKSwgaWQsIG51bGwpO1xuICAgIHJldHVybiBlaTtcbn07XG5cbi8qIVxuICogXFxicmllZiBsb2NhbCBkZWxldGlvbiBvZiBhIGNoYXJhY3RlciBmcm9tIHRoZSBzZXF1ZW5jZSBzdHJ1Y3R1cmUuIEl0IFxuICogYnJvYWRjYXN0cyB0aGUgb3BlcmF0aW9uIHRvIHRoZSByZXN0IG9mIHRoZSBuZXR3b3JrLlxuICogXFxwYXJhbSBpbmRleCB0aGUgaW5kZXggb2YgdGhlIGVsZW1lbnQgdG8gcmVtb3ZlXG4gKiBcXHJldHVybiB0aGUgaWRlbnRpZmllciBmcmVzaGx5IHJlbW92ZWRcbiAqL1xuQ3JhdGVDb3JlLnByb3RvdHlwZS5yZW1vdmUgPSBmdW5jdGlvbihpbmRleCl7XG4gICAgdmFyIGkgPSB0aGlzLnNlcXVlbmNlLnJlbW92ZShpbmRleCk7XG4gICAgdmFyIGlzUmVhZHkgPSB7X2U6IGkuX3NbaS5fcy5sZW5ndGgtMV0sIF9jOiBpLl9jW2kuX2MubGVuZ3RoLTFdfTtcbiAgICB0aGlzLnNlcXVlbmNlLl9jICs9IDE7XG4gICAgdmFyIGlkID0ge19lOnRoaXMuc2VxdWVuY2UuX3MsIF9jOiB0aGlzLnNlcXVlbmNlLl9jIH0gLy8gKFRPRE8pIGZpeCB1Z2x5bmVzc1xuICAgIHRoaXMuYnJvYWRjYXN0LnNlbmQobmV3IE1SZW1vdmVPcGVyYXRpb24oaSksIGlkLCBpc1JlYWR5KTtcbiAgICByZXR1cm4gaTtcbn07XG5cbi8qIVxuICogXFxicmllZiBpbnNlcnRpb24gb2YgYW4gZWxlbWVudCBmcm9tIGEgcmVtb3RlIHNpdGUuIEl0IGVtaXRzICdyZW1vdGVJbnNlcnQnIFxuICogd2l0aCB0aGUgaW5kZXggb2YgdGhlIGVsZW1lbnQgdG8gaW5zZXJ0LCAtMSBpZiBhbHJlYWR5IGV4aXN0aW5nLlxuICogXFxwYXJhbSBlaSB0aGUgcmVzdWx0IG9mIHRoZSByZW1vdGUgaW5zZXJ0IG9wZXJhdGlvblxuICovXG5DcmF0ZUNvcmUucHJvdG90eXBlLnJlbW90ZUluc2VydCA9IGZ1bmN0aW9uKGVpKXtcbiAgICB0aGlzLmVtaXQoJ3JlbW90ZUluc2VydCcsXG4gICAgICAgICAgICAgIGVpLl9lLFxuICAgICAgICAgICAgICB0aGlzLnNlcXVlbmNlLmFwcGx5SW5zZXJ0KGVpLl9lLCBlaS5faSwgdHJ1ZSkpO1xuICAgIC8vIChUT0RPKSBmaXggdGhlIG5vSW5kZXggdGhpbmdcbn07XG5cbi8qIVxuICogXFxicmllZiByZW1vdmFsIG9mIGFuIGVsZW1lbnQgZnJvbSBhIHJlbW90ZSBzaXRlLiAgSXQgZW1pdHMgJ3JlbW90ZVJlbW92ZSdcbiAqIHdpdGggdGhlIGluZGV4IG9mIHRoZSBlbGVtZW50IHRvIHJlbW92ZSwgLTEgaWYgZG9lcyBub3QgZXhpc3RcbiAqIFxccGFyYW0gaWQgdGhlIHJlc3VsdCBvZiB0aGUgcmVtb3RlIGluc2VydCBvcGVyYXRpb25cbiAqL1xuQ3JhdGVDb3JlLnByb3RvdHlwZS5yZW1vdGVSZW1vdmUgPSBmdW5jdGlvbihpZCl7XG4gICAgdGhpcy5lbWl0KCdyZW1vdGVSZW1vdmUnLCB0aGlzLnNlcXVlbmNlLmFwcGx5UmVtb3ZlKGlkKSk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgc2VhcmNoIGEgc2V0IG9mIGVsZW1lbnRzIGluIG91ciBzZXF1ZW5jZSBhbmQgcmV0dXJuIHRoZW1cbiAqIFxccGFyYW0gdG9TZWFyY2ggdGhlIGFycmF5IG9mIGVsZW1lbnRzIHtfZSwgX2N9IHRvIHNlYXJjaFxuICogXFxyZXR1cm5zIGFuIGFycmF5IG9mIG5vZGVzXG4gKi9cbkNyYXRlQ29yZS5wcm90b3R5cGUuZ2V0RWxlbWVudHMgPSBmdW5jdGlvbih0b1NlYXJjaCl7XG4gICAgdmFyIHJlc3VsdCA9IFtdLCBmb3VuZCwgbm9kZSwgdGVtcE5vZGUsIGk9dGhpcy5zZXF1ZW5jZS5sZW5ndGgsIGo9MDtcbiAgICAvLyAoVE9ETykgaW1wcm92ZSByZXNlYXJjaCBieSBleHBsb2l0aW5nIHRoZSBmYWN0IHRoYXQgaWYgYSBub2RlIGlzXG4gICAgLy8gbWlzc2luZywgYWxsIGl0cyBjaGlsZHJlbiBhcmUgbWlzc2luZyB0b28uXG4gICAgLy8gKFRPRE8pIGltcHJvdmUgdGhlIHJldHVybmVkIHJlcHJlc2VudGF0aW9uOiBlaXRoZXIgYSB0cmVlIHRvIGZhY3Rvcml6ZVxuICAgIC8vIGNvbW1vbiBwYXJ0cyBvZiB0aGUgc3RydWN0dXJlIG9yIGlkZW50aWZpZXJzIHRvIGdldCB0aGUgcG9seWxvZyBzaXplXG4gICAgLy8gKFRPRE8pIGltcHJvdmUgdGhlIHNlYXJjaCBieSB1c2luZyB0aGUgZmFjdCB0aGF0IHRvU2VhcmNoIGlzIGEgc29ydGVkXG4gICAgLy8gYXJyYXksIHBvc3NpYmx5IHJlc3RydWN0dXJlIHRoaXMgYXJndW1lbnQgdG8gYmUgZXZlbiBtb3JlIGVmZmljaWVudFxuICAgIHdoaWxlICh0b1NlYXJjaC5sZW5ndGggPiAwICYmIGk8PXRoaXMuc2VxdWVuY2UubGVuZ3RoICYmIGk+MCl7XG4gICAgICAgIG5vZGUgPSB0aGlzLnNlcXVlbmNlLmdldChpKTtcbiAgICAgICAgdGVtcE5vZGUgPSBub2RlO1xuICAgICAgICB3aGlsZSggdGVtcE5vZGUuY2hpbGRyZW4ubGVuZ3RoID4gMCl7XG4gICAgICAgICAgICB0ZW1wTm9kZSA9IHRlbXBOb2RlLmNoaWxkcmVuWzBdO1xuICAgICAgICB9O1xuICAgICAgICBqID0gMDtcbiAgICAgICAgZm91bmQgPSBmYWxzZTtcbiAgICAgICAgd2hpbGUgKGogPCB0b1NlYXJjaC5sZW5ndGggJiYgIWZvdW5kKXtcbiAgICAgICAgICAgIGlmICh0ZW1wTm9kZS50LnMgPT09IHRvU2VhcmNoW2pdLl9lICYmXG4gICAgICAgICAgICAgICAgdGVtcE5vZGUudC5jID09PSB0b1NlYXJjaFtqXS5fYyl7XG4gICAgICAgICAgICAgICAgZm91bmQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJlc3VsdC5wdXNoKG5ldyBNQUVJbnNlcnRPcGVyYXRpb24oe19lOiB0ZW1wTm9kZS5lLCBfaTpub2RlfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtfZTogdG9TZWFyY2hbal0uX2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgX2M6IHRvU2VhcmNoW2pdLl9jfSApKTtcbiAgICAgICAgICAgICAgICB0b1NlYXJjaC5zcGxpY2UoaiwxKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgKytqO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfTtcbiAgICAgICAgLy8gICAgICAgICsraTtcbiAgICAgICAgLS1pO1xuICAgIH07XG4gICAgIHJldHVybiByZXN1bHQ7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IENyYXRlQ29yZTtcbiJdfQ==
