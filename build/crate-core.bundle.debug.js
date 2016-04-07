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
 * \param origin the origin of the insertion
 */
function MInsertOperation(insert, origin){
    this.type = "MInsertOperation";
    this.insert = insert;
    this.origin = origin;
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
 * \param origin the origin of the removal
 */
function MRemoveOperation(remove, origin){
    this.type = "MRemoveOperation";
    this.remove = remove;
    this.origin = origin;
};
module.exports.MRemoveOperation = MRemoveOperation;

/*!
 * \brief object that represents the result of a caretMoved Operation
 * \param range the selection range
 * \param origin the origin of the selection
 */
function MCaretMovedOperation(range, origin){
    this.type = "MCaretMovedOperation";
    this.range = range;
    this.origin = origin;
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
    this.protocol = name || 'causal';
    this.source = source;
    this.causality = causality;
    this.deltaAntiEntropy = 1000*60*1/2; // (TODO) configurable (currently 30s)
    this.unicast = new Unicast(this.source, this.name+'-unicast');

    // buffer of operations
    this.buffer = []; 
    // buffer of anti-entropy messages (chunkified because of large size)
    this.bufferAntiEntropy = new MAntiEntropyResponse('init');
    
    var self = this;
    this.source.on('receive', function(id, message){
        if (!message || !message.protocol){ return ; };
        switch (message.protocol){
        case self.protocol: self.receiveBroadcast(message); break;
        case self.protocol+'-unicast': self.receiveUnicast(id, message); break;
        };
    });
    
//    this.source.on('statechange', function(state){
//        if (state==='connect'){
//            self.unicast.send(new MAntiEntropyRequest(self.causality));
//        };
//    });
    
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
    var links = this.source.getPeers();
    var mBroadcast = new MBroadcast(this.protocol,id||GUID(),isReady, message);
    // #2 register the message in the structure
    this.causality.incrementFrom(id);

    // #3 send the message to the neighborhood
    for (var i = 0; i < links.o.length; ++i){
        this.source.send(links.o[i], mBroadcast);
    };
    for (var i = 0; i < links.i.length; ++i){
        this.source.send(links.i[i], mBroadcast);
    };
};

/*!
 * \brief answers to an antientropy request message with the missing elements
 * \param origin the origin of the request
 * \param causalityAtReceipt the local causality structure when the message was
 * received
 * \param messages the missing messages
 */ 
CausalBroadcast.prototype.sendAntiEntropyResponse =
    function(origin, causalityAtReceipt, messages){
        var id = GUID();
        // #1 metadata of the antientropy response
        this.unicast.send(new MAntiEntropyResponse(this.protocol, id,
                                                   causalityAtReceipt,
                                                   messages.length), origin);
        for (var i = 0; i < messages.length; ++i){
            this.unicast.send(new MAntiEntropyResponse(this.protocol, id,
                                                       null,
                                                       messages.length,
                                                       messages[i]),  origin);
        };
    };

/*!
 * \brief receive a broadcast message
 * \param message the received message
 */
CausalBroadcast.prototype.receiveBroadcast = function(message){
    var id = message.id, isReady = message.isReady;
    if (!this.stopPropagation(message)){
        // #1 register the operation
        this.buffer.push(message);
        // #2 deliver
        this.reviewBuffer();
        // #3 rebroadcast
        var links = this.source.getPeers();
        for (var i = 0; i < links.o.length; ++i){
            this.source.send(links.o[i], message);
        };
        for (var i = 0; i < links.i.length; ++i){
            this.source.send(links.i[i], message);
        };        
    };
};

/*!
 * \brief go through the buffer of messages and delivers all
 * ready operations
 */
CausalBroadcast.prototype.reviewBuffer = function(){
    var found = false, i = this.buffer.length - 1;
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
 * \brief id the identifier of the origin of the unicast
 * \brief message the message received 
 */
CausalBroadcast.prototype.receiveUnicast = function(id, message){
    switch (message.type){
    case 'MAntiEntropyRequest':
        this.emit('antiEntropy',
                  id, message.causality, this.causality.clone());
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

},{"./guid.js":4,"./messages":5,"./messages.js":5,"events":61,"unicast-definition":7,"util":65}],4:[function(require,module,exports){
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
    this.protocol = name;
    this.id = id;
    this.isReady = isReady;
    this.payload = payload;
};
module.exports.MBroadcast = MBroadcast;

/*!
 * \brief message that request an AntiEntropy 
 * \param causality the causality structure
 */
function MAntiEntropyRequest(name, causality){
    this.type = 'MAntiEntropyRequest';
    this.protocol = name;
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
function MAntiEntropyResponse(name, id, causality, nbElements, element){
    this.type = 'MAntiEntropyResponse';
    this.id = id;
    this.causality = causality;
    this.protocol = name;
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
    this.source.on(self.name+'-receive', function(id, message){
        self.emit('receive', id, message.payload);
    });    
};

/*!
 * \brief send the message to one random participant
 * \param message the message to send
 * \param id optionnal identifier of the channel to use for sending the msg
 * \param return true if it seems to have sent the message, false otherwise.
 */
Unicast.prototype.send = function(message, id){
    // #1 get the neighborhood and create the message
    var links = (id && {o:[id], i:[]}) || this.source.getPeers(1);
    var link;
    var mUnicast = new MUnicast(this.name, message);

    // #2 send the message
    if (links.o.length === 0 && links.i.length === 0){return false;};
    if (links.o.length > 0) {
        link = links.o[0];
    } else {
        link = links.i[0];
    };
    return this.source.send(link, mUnicast);
};

module.exports = Unicast;

},{"./messages":6,"events":61,"util":65}],8:[function(require,module,exports){
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
var SortedArray = require('sorted-cmp-array');

SortedArray.prototype.get = function(entry){
    var index = this.indexOf(entry);
    return ((index >= 0)&&this.arr[index]) || null;
};


SortedArray.prototype.contains = function(entry){
    return (this.indexOf(entry) >= 0);
};

module.exports = SortedArray;

},{"sorted-cmp-array":51}],17:[function(require,module,exports){
module.exports=require(1)
},{"/Users/chat-wane/Desktop/project/crate-core/lib/guid.js":1}],18:[function(require,module,exports){
/*!
 * \brief message requesting an exchange of neighborhood
 * \param inview the identifier of the inview
 * \param outview the identifier of the outview
 * \param protocol the protocol that creates the message
 */
module.exports.MExchange = function(inview, outview, protocol){
    return {protocol: 'spray-wrtc',
            type: 'MExchange',
            inview: inview,
            outview: outview,
            protocol: protocol};
};

},{}],19:[function(require,module,exports){
var SortedArray = require("./extended-sorted-array.js");

/*!
 * \brief structure containing the neighborhood of a peer.
 */
function PartialView(){
    // #1 initialize the partial view as an array sorted by age
    // entries are {age, id, socketId}
    this.array = new SortedArray(Comparator);
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
PartialView.prototype.increment = function(){
    for (var i=0; i<this.array.arr.length; ++i){
        this.array.arr[i].age += 1;
    };
};

/*!
 * \brief get a sample of the partial view
 * \param neighbor the neighbor which performs the exchange with us
 * \param isInitiator whether or not the caller is the initiator of the
 * exchange
 * \return an array containing neighbors from this partial view
 */
PartialView.prototype.getSample = function(neighbor, isInitiator){
    var sample = [];
    // #1 copy the partial view
    var clone = new SortedArray(Comparator);
    for (var i = 0; i < this.array.arr.length; ++i){
        clone.arr.push(this.array.arr[i]);
    };

    // #2 process the size of the sample
    var sampleSize = Math.ceil(this.array.arr.length/2.);
    
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
 * \param id the peer to add to the partial view
 */
PartialView.prototype.addNeighbor = function(id){
    this.array.insert({age: 0, id: id, rand: Math.random()});
};


/*!
 * \brief get the index of the peer in the partialview
 * \return the index of the peer in the array, -1 if not found
 */
PartialView.prototype.getIndex = function(id){
    var i =  this.array.arr.length-1, index = -1, found = false;
    while (!found && i >= 0){
        if (id === this.array.arr[i].id){
            found = true;
            index = i;
        };
        --i;
    };
    return index;
};

/*!
 * \brief remove the peer from the partial view
 * \param peer the peer to remove
 * \return the removed entry if it exists, null otherwise
 */
PartialView.prototype.removePeer = function(id, age){
    if (!age){    
        var index = this.getIndex(id), removedEntry = null;
        if (index > -1){
            removedEntry = this.array.arr[index];
            this.array.arr.splice(index, 1);
        };
        return removedEntry;
    } else {
        removePeerAge.call(this, id, age);
    };
};

/*!
 * \brief remove the peer with the associated age from the partial view
 * \param peer the peer to remove
 * \param age the age of the peer to remove
 * \return the removed entry if it exists, null otherwise
 */
function removePeerAge(id, age){
    var found = false, i = 0, removedEntry = null;
    while(!found && i < this.array.arr.length){
        if (id === this.array.arr[i].id && age === this.array.arr[i].age){
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
PartialView.prototype.removeAll = function(id){
    var occ = 0, i = 0;
    while (i < this.array.arr.length){
        if (this.array.arr[i].id === id){
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
        this.removePeer(sample[i].id, sample[i].age);
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
PartialView.prototype.contains = function(id){
    return this.getIndex(id)>=0;
};

/*!
 * \brief remove all elements from the partial view
 */
PartialView.prototype.clear = function(){
    this.array.arr.splice(0, this.array.arr.length);
};


/*!
 * \brief get the array of pairs (age, id)
 */
PartialView.prototype.get = function(){
    return this.array.arr;
};

function Comparator(a, b){
    var first = a.age || a;
    var second = b.age || b;
    if (first < second){ return -1;};
    if (first > second){ return  1;};
    if (a.rand < b.rand){ return -1;};
    if (a.rand > b.rand){ return  1;};
    return 0;
};

module.exports = PartialView;

},{"./extended-sorted-array.js":16}],20:[function(require,module,exports){
var EventEmitter = require('events').EventEmitter;
var NO = require('n2n-overlay-wrtc');
var clone = require('clone');
var util = require('util');

var PartialView = require('./partialview.js');
var GUID = require('./guid.js');

var MExchange = require('./messages.js').MExchange;

util.inherits(Spray, EventEmitter);

/*!
 * \brief Implementation of the random peer sampling Spray
 */
function Spray(options){
    EventEmitter.call(this);
    // #A constants
    this.protocol = (options && options.protocol) || 'spray-wrtc';
    this.DELTATIME = (options && options.deltatime) || 1000 * 60 * 2; // 2min

    var opts = (options && clone(options)) || {};
    opts.protocol = this.protocol+'-n2n';
    // #B protocol variables
    this.partialView = new PartialView();
    this.neighborhoods = new NO(opts);
    this.state = 'disconnect'; // (TODO) update state

    // #C periodic shuffling
    var self = this;
    setInterval(function(){
        (self.partialView.length()>0) && exchange.call(self);
    }, this.DELTATIME);
    
    // #D receive event
    function receive(id, message){
        // #0 must contain a message and a protocol, otherwise forward
        if (!message || message.protocol!==self.protocol){
            self.emit('receive', id, message);
            return;
        };
        // #2 handle messages from spray
        switch (message.type){
        case 'MExchange':
            onExchange.call(self, message);
            break;
        };
    };

    this.neighborhoods.on('receive', receive);
    this.neighborhoods.on('ready', function (id, view){
        (view === 'outview') && self.partialView.addNeighbor(id);
        updateState.call(self);
    });
    
    this.neighborhoods.on('fail', function(id, view){
        (view === 'outview') && onArcDown.call(self);
    });
    
    this.neighborhoods.on('disconnect', function (id, view){
        updateState.call(self);
    });
    
    // (TODO) remove fast access usefull 4 debug
    this.exchange = function(){ exchange.call(self) };
};


/*!
 * \brief Joining as; or contacted by an outsider
 * \param callbacks the callbacks function, see module 'n2n-overlay-wrtc'.
 */
Spray.prototype.connection = function(callbacks, message){
    var self = this;
    var onReadyFunction = callbacks && callbacks.onReady;
    // #1 if this peer is the contact, overload the onready function
    // with the spray joining mechanism that will inject log(x) arcs in
    // the network
    if (message){ 
        callbacks.onReady = function(id){
            if (self.partialView.length() > 0){
                // #A signal the arrival of a new peer to its outview
                self.partialView.get().forEach(function(n){
                    self.neighborhoods.connect(n, id);
                });
            } else {
                // #B adds it to its own outview (for only 2-peers network)
                self.neighborhoods.connect(null, id);
            };
            // #C callback the original onReady function
            onReadyFunction && onReadyFunction(id);
        };
    };
    // #2 start establishing the first connection
    this.neighborhoods.connection(callbacks, message);    
};
    
/*!
 * \brief Leave the network
 * \param timer the timeout before really shutting down. The time can
 * be spent on healing the network before departure.
 */
Spray.prototype.leave = function(timer){
    this.partialView.clear(); 
    this.neighborhoods.disconnect();
};

/*!
 * \brief get a set of neighbors from both inview and outview. It is worth
 * noting that each peer controls its outview, but not its inview. Thus, the 
 * outview may be less versatile.
 * \param k the number of neighbors requested, if k is not defined, it returns
 * every known identifiers.
 * \return { i:[id1,id2...idk], o:[id1,id2...idk] }
 */
Spray.prototype.getPeers = function(k){
    var result = {i:[], o:[]};
    // #A copy the identifiers of the inview
    var inview = this.neighborhoods.get('inview');
    for (var i = 0; i < inview.length; ++i){
        result.i.push(inview[i].id);
    };
    // #B remove entries if there are too many
    while (k && (result.i.length > k) && (result.i.length > 0)){
        var rn = Math.floor(Math.random()*result.i.length);
        result.i.splice(rn, 1);
    };
    // #C copy the identifiers of the outview
    var outview = this.neighborhoods.get('outview');
    for (var i = 0; i < outview.length; ++i){
        result.o.push(outview[i].id);
    };
    // #D remove entries if there are too many
    while (k && (result.o.length > k) && (result.o.length > 0)){
        var rn = Math.floor(Math.random()*result.o.length);
        result.o.splice(rn, 1);
    };
    return result;
};

/*!
 * \brief send a message using the id of the arc used to communicate
 * \param id the identifier of the communication channel
 * \param message the message to send
 * \param return true if the message is sent, false otherwise
 */
Spray.prototype.send = function(id, message){
    var result = this.neighborhoods.send(id, message);
    (!result) && onPeerDown.call(this,id);
    return result;
};


/*!
 * \brief get the string representation of the partial view of spray
 */ 
Spray.prototype.toString = function(){
    var result = '@'+this.neighborhoods.inview.ID +';'+
        this.neighborhoods.outview.ID + '   [ ';
    var pv = this.partialView.get();
    for (var i = 0; i < pv.length; ++i){
        result += '('+(pv[i].age + ' ' + pv[i].id +') ');
    };
    result += ']';
    return result;
};

//////////////////////////////////////
//        PRIVATE functions         //
//////////////////////////////////////

/*!
 * \brief update the local connection state of the peer and emit an event
 * if the state is different than at the previous call of this function.
 * The emitted event is 'statechange' with the 
 * arguments 'connect' | 'partial' | 'disconnect'
 */
function updateState(){
    // (TODO) handle it without reaching the neighbor-wrtc module...
    if (this.partialView.length() > 0 &&
        this.neighborhoods.i.living.ms.arr.length > 0 &&
        this.state !== 'connect'){
        // #1 connected means (1+ inview, 1+ outview)
        this.state = 'connect';
        this.emit('statechange', 'connect');
    } else if (
        (this.partialView.length() === 0 ||
         this.neighborhoods.i.living.ms.arr.length === 0) &&
            (this.partialView.length() > 0 ||
             this.neighborhoods.i.living.ms.arr.length > 0) &&
            (this.state !== 'partial')){
        // #2 partially connected means (1+ inview, 0 outview) or (0 i, 1+ o)
        this.state = 'partial';
        this.emit('statechange', 'partial');
    } else if (this.partialView.length() === 0 &&
               this.neighborhoods.i.living.ms.arr.length === 0 &&               
               this.state !== 'disconnect'){
        // #3 disconnected means (0 inview, 0 outview)
        this.state = 'disconnect';
        this.emit('statechange', 'disconnect');
    };
};

/*******************************************************************************
 * Spray's protocol implementation
 ******************************************************************************/

/*!
 * \brief periodically called function that aims to balance the partial view
 * and to mix the neighborhoods
 */
function exchange(){
    var self = this, oldest = null, sent = false;
    this.partialView.increment();
    // #1 get the oldest neighbor reachable
    while (!oldest && !sent && this.partialView.length()>0){
        oldest = this.partialView.getOldest();
        sent = this.send(oldest.id, MExchange(this.neighborhoods.i.ID,
                                              this.neighborhoods.o.ID,
                                              this.protocol));
        sent || onPeerDown.call(this, oldest);
    };
    if (this.partialView.length()===0){return;}; // ugly return
    // #2 get a sample from our partial view (TODO) before sending the exchange request
    var sample = this.partialView.getSample(oldest, true); 
    // #3 establish connections oldest -> sample
    // #A remove the chosen arcs
    sample.forEach(function(e){
        self.neighborhoods.disconnect(e.id);
        self.partialView.removePeer(e.id, e.age);
    });
    // #B from oldest to chosen neighbor
    sample.forEach(function(e){
        self.neighborhoods.connect(oldest.id, (e.id !== oldest.id) && e.id);
    });
};

/*!
 * \brief event executed when we receive an exchange request
 * \param msg message containing the identifier of the peer that started the 
 * exchange
 */
function onExchange(msg){
    var self = this;
    // #1 get a sample of neighbors from our partial view
    this.partialView.increment();
    var sample = this.partialView.getSample(msg.inview, false);
    // #A remove the chosen neighbor from our partialview
    sample.forEach(function(e){
        self.neighborhoods.disconnect(e.id);
        self.partialView.removePeer(e.id, e.age);
    });
    // #B from initiator to chosen neigbhor
    sample.forEach(function(e){
        self.neighborhoods.connect(msg.outview, (e.id !== msg.inview) && e.id);
    });
};

/*!
 * \brief the function called when a neighbor is unreachable and supposedly
 * crashed/departed. It probabilistically keeps an arc up
 * \param id the identifier of the channel that seems down
 */
function onPeerDown(id){
    console.log('peerdown');
    // #A remove all occurrences of the peer in the partial view
    var occ = this.partialView.removeAll(id);
    // #B probabilistically recreate an arc to a known peer
    if (this.partialView.length() > 0){
        for (var i = 0; i < occ; ++i){
            if (Math.random() > (1/(this.partialView.length()+occ))){
                var rn = Math.floor(Math.random()*this.partialView.length());
                this.neighborhoods.connect(null,this.partialView.array.arr[rn]);
            };
        };
    };
};

/*!
 * \brief a connection failed to establish properly, systematically duplicates
 * an element of the partial view. (TODO) integrates this
 */
function onArcDown(){
    console.log('arcdown');
    if (this.partialView.length()>0){
        var rn = Math.floor(Math.random()*this.partialView.length());
        this.neighborhoods.connect(null, this.partialView.array.arr[rn]);
    };
};

module.exports = Spray;

},{"./guid.js":17,"./messages.js":18,"./partialview.js":19,"clone":22,"events":61,"n2n-overlay-wrtc":24,"util":65}],21:[function(require,module,exports){
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

},{}],22:[function(require,module,exports){
(function (Buffer){
var clone = (function() {
'use strict';

/**
 * Clones (copies) an Object using deep copying.
 *
 * This function supports circular references by default, but if you are certain
 * there are no circular references in your object, you can save some CPU time
 * by calling clone(obj, false).
 *
 * Caution: if `circular` is false and `parent` contains circular references,
 * your program may enter an infinite loop and crash.
 *
 * @param `parent` - the object to be cloned
 * @param `circular` - set to true if the object to be cloned may contain
 *    circular references. (optional - true by default)
 * @param `depth` - set to a number if the object is only to be cloned to
 *    a particular depth. (optional - defaults to Infinity)
 * @param `prototype` - sets the prototype to be used when cloning an object.
 *    (optional - defaults to parent prototype).
*/
function clone(parent, circular, depth, prototype) {
  var filter;
  if (typeof circular === 'object') {
    depth = circular.depth;
    prototype = circular.prototype;
    filter = circular.filter;
    circular = circular.circular
  }
  // maintain two arrays for circular references, where corresponding parents
  // and children have the same index
  var allParents = [];
  var allChildren = [];

  var useBuffer = typeof Buffer != 'undefined';

  if (typeof circular == 'undefined')
    circular = true;

  if (typeof depth == 'undefined')
    depth = Infinity;

  // recurse this function so we don't reset allParents and allChildren
  function _clone(parent, depth) {
    // cloning null always returns null
    if (parent === null)
      return null;

    if (depth == 0)
      return parent;

    var child;
    var proto;
    if (typeof parent != 'object') {
      return parent;
    }

    if (clone.__isArray(parent)) {
      child = [];
    } else if (clone.__isRegExp(parent)) {
      child = new RegExp(parent.source, __getRegExpFlags(parent));
      if (parent.lastIndex) child.lastIndex = parent.lastIndex;
    } else if (clone.__isDate(parent)) {
      child = new Date(parent.getTime());
    } else if (useBuffer && Buffer.isBuffer(parent)) {
      child = new Buffer(parent.length);
      parent.copy(child);
      return child;
    } else {
      if (typeof prototype == 'undefined') {
        proto = Object.getPrototypeOf(parent);
        child = Object.create(proto);
      }
      else {
        child = Object.create(prototype);
        proto = prototype;
      }
    }

    if (circular) {
      var index = allParents.indexOf(parent);

      if (index != -1) {
        return allChildren[index];
      }
      allParents.push(parent);
      allChildren.push(child);
    }

    for (var i in parent) {
      var attrs;
      if (proto) {
        attrs = Object.getOwnPropertyDescriptor(proto, i);
      }

      if (attrs && attrs.set == null) {
        continue;
      }
      child[i] = _clone(parent[i], depth - 1);
    }

    return child;
  }

  return _clone(parent, depth);
}

/**
 * Simple flat clone using prototype, accepts only objects, usefull for property
 * override on FLAT configuration object (no nested props).
 *
 * USE WITH CAUTION! This may not behave as you wish if you do not know how this
 * works.
 */
clone.clonePrototype = function clonePrototype(parent) {
  if (parent === null)
    return null;

  var c = function () {};
  c.prototype = parent;
  return new c();
};

// private utility functions

function __objToStr(o) {
  return Object.prototype.toString.call(o);
};
clone.__objToStr = __objToStr;

function __isDate(o) {
  return typeof o === 'object' && __objToStr(o) === '[object Date]';
};
clone.__isDate = __isDate;

function __isArray(o) {
  return typeof o === 'object' && __objToStr(o) === '[object Array]';
};
clone.__isArray = __isArray;

function __isRegExp(o) {
  return typeof o === 'object' && __objToStr(o) === '[object RegExp]';
};
clone.__isRegExp = __isRegExp;

function __getRegExpFlags(re) {
  var flags = '';
  if (re.global) flags += 'g';
  if (re.ignoreCase) flags += 'i';
  if (re.multiline) flags += 'm';
  return flags;
};
clone.__getRegExpFlags = __getRegExpFlags;

return clone;
})();

if (typeof module === 'object' && module.exports) {
  module.exports = clone;
}

}).call(this,require("buffer").Buffer)
},{"buffer":57}],23:[function(require,module,exports){

module.exports.MConnectTo = function(protocol, from, to){
    return { protocol: protocol,
             type: 'MConnectTo',
             from: from,
             to: to };
};

module.exports.MForwardTo = function(from, to, message, protocol){
    return { protocol: protocol,
             type: 'MForwardTo',
             from: from,
             to: to,
             message: message };
};

module.exports.MForwarded = function(from, to, message, protocol){
    return { protocol: protocol,
             type: 'MForwarded',
             from: from,
             to: to,
             message: message };
};

module.exports.MDirect = function(from, message, protocol){
    return { protocol: protocol,
             type: 'MDirect',
             from: from,
             message: message };
};

},{}],24:[function(require,module,exports){
var Neighborhood = require('neighborhood-wrtc');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

util.inherits(Neighbor, EventEmitter);

var MForwardTo = require('./messages.js').MForwardTo;
var MForwarded = require('./messages.js').MForwarded;
var MConnectTo = require('./messages.js').MConnectTo;
var MDirect = require('./messages.js').MDirect;


/*!
 * \brief A neighbor has an inview and an outview and is able to act as a bridge
 * between its neighbors so they can establish their own communication channels
 */
function Neighbor(options){
    EventEmitter.call(this);
    var protocol = (options && options.protocol) || 'n2n-overlay-wrtc';
    // #1 dissociate entering arcs from outgoing arcs
    this.inview = (options && options.inview) || new Neighborhood(options);
    this.outview = (options && options.outview) || new Neighborhood(options);
    // #2 concise access
    this.i = this.inview;
    this.o = this.outview;
    
    var self = this;
    // #A callbacks when there is a bridge to create a connection
    var callbacks = function(id, message, view){
        return {
            onInitiate: function(offer){
                self.send(id, MForwardTo(message.from, message.to,
                                         offer,
                                         protocol));
            },
            onAccept: function(offer){
                self.send(id, MForwardTo(message.to, message.from,
                                         offer,
                                         protocol));
            }
        };
    };
    // #B callbacks when it establishes a connection to a neighbor, either
    // this -> neighbor or neigbhor -> this. It is worth noting that if it
    // a channel exists in the inview and we want to create an identical in the
    // outview, a new channel must be created; for the peer that owns the arc
    // in its outview can destroy it without warning.
    var directCallbacks = function(id, idView, view){
        return {
            onInitiate: function(offer){
                self.send(id, MDirect(idView, offer, protocol));
            },
            onAccept: function(offer){
                self.send(id, MDirect(idView, offer, protocol));
            }
        };
    };      

    // #C receive a message from an arc, it forwards it to a listener
    // of this module, otherwise, it keeps and interprets it.
    function receive(id, message){
        // #1 redirect       
        if (!message.protocol || message.protocol!==protocol){
            self.emit('receive', id, message);
            return; // ugly early return
        };
        // #2 otherwise, interpret
        switch (message.type){
        case 'MConnectTo': // #A a neighbor asks us to connect to a remote one
            if (message.to && message.from){
                self.connection(callbacks(id, message, 'outview'));
            } else { // #B a neighbor asks us to connect to him
                self.connection(directCallbacks(id, self.outview.ID,'outview'));
            };
            break;
        case 'MForwardTo': // #C a message is to be forwarded to a neighbor
            self.send(message.to, MForwarded(message.from, message.to,
                                             message.message,
                                             message.protocol));
            break;
        case 'MForwarded': // #D a message has been forwarded to us, deliver
            self.inview.connection(callbacks(id, message, 'inview'),
                                   message.message) ||
                self.outview.connection(message.message);
            break;
        case 'MDirect': // #E a direct neigbhor sends offers to accept
            self.inview.connection(
                directCallbacks(id, message.from, 'inview'),
                message.message) ||
                self.outview.connection(message.message);
            break;            
        };
    };

    this.inview.on('receive', receive);
    this.outview.on('receive', receive);
    
    // #D an arc in one of the view is ready, redirect event
    function ready(view){
        return function(id){ self.emit('ready', id, view); };
    };

    this.inview.on('ready-'+protocol, ready('inview'));
    this.outview.on('ready-'+protocol, ready('outview'));

    // #E a connection failed to establish
    function fail(view){
        return function(){ self.emit('fail', view); };
    };
    
    this.inview.on('fail', fail('inview'));
    this.outview.on('fail', fail('outview'));

    // #F an arc has been remove
    function disconnect(view){
        return function(id) { self.emit('disconnect', id, view); };
    };
    
    this.inview.on('disconnect', disconnect('inview'));
    this.outview.on('disconnect', disconnect('outview'));
    
    /*!
     * \brief connect the peers at the other ends of sockets identified
     * \param from the identifier of the socket leading to a peer which will add
     * a socket in its outview
     * \param to the identifier of the socket leading to a peer which will add 
     * a socket in its inview
     */
    this.connect = function(from, to){
        if (!from && to){
            // #A only the 'to' argument implicitly means from = this
            // this -> to
            self.connection(directCallbacks( to, self.outview.ID, 'outview'));
        } else if (from && !to){
            // #B only the 'from' argument implicitly means to = this
            // from -> this
            self.send(from, MConnectTo(protocol));
        } else {
            // #C ask to the from-peer to the to-peer
            // from -> to
            self.send(from, MConnectTo(protocol, from, to));
        };
    };
    
    /*!
     * \brief bootstrap the network, i.e. first join the network. This peer
     * will add a peer which already belong to the network. The rest of 
     * protocol can be done inside the network with the function connect.
     * \param callbacks see callbacks of neighborhood-wrtc
     * \param message see messages of neighborhood-wrtc
     * \return the id of the socket
     */
    this.connection = function(callbacks, message){
        if (!message || (message && message.type==='MResponse')){
            return this.outview.connection(callbacks, message, protocol);
        } else {
            return this.inview.connection(callbacks, message, protocol);
        };
    };
};

/*!
 * \brief remove an arc of the outview or all arcs
 * \param id the arc to remove, if none, remove all arcs
 */
Neighbor.prototype.disconnect = function(id){
    if (!id){
        this.outview.disconnect();
        this.inview.disconnect();
    } else {
        this.outview.disconnect(id);
    };
};



/*!
 * \brief tries to send the message to the peer identified by id
 * \param id the identifier of the socket used to send the message
 * \param message the message to send
 * \param return true if the message has been sent, false otherwise
 */
Neighbor.prototype.send = function(id, message){
    return this.outview.send(id, message) || this.inview.send(id, message);
};

/*!
 * \brief get the socket corresponding to the id in argument and views
 * \param idOrView id or 'inview' or 'outview'
 * \return a list of entries or an entry
 */
Neighbor.prototype.get = function(idOrView){
    return  ((idOrView==='inview') && this.inview.living.ms.arr) ||// all inview
    ((idOrView==='outview') && this.outview.living.ms.arr) || // all outview
    (idOrView && (this.outview.get(idOrView) ||
                  this.inview.get(idOrView))); // cherry picking
};

/*!
 * \brief simple string representing the in and out views
 * \return a string with in and out views
 */
Neighbor.prototype.toString = function(){
    var result = '';
    result += 'IDS [' + this.inview.ID +', '+ this.outview.ID +'] ';
    result += 'In {';
    var I = this.get('inview');
    for (var i = 0; i < I.length; ++i){
        result +=  I[i].id + ' x' + I[i].occ + '; ';
    };
    result += '}  Out {';
    var O = this.get('outview');
    for (var i = 0; i < O.length; ++i){
        result +=  O[i].id + ' x' + O[i].occ + '; ';
    };
    result += '}';
    return result;
};

module.exports = Neighbor;

},{"./messages.js":23,"events":61,"neighborhood-wrtc":28,"util":65}],25:[function(require,module,exports){
module.exports=require(16)
},{"/Users/chat-wane/Desktop/project/crate-core/node_modules/spray-wrtc/lib/extended-sorted-array.js":16,"sorted-cmp-array":47}],26:[function(require,module,exports){
module.exports.MRequest = function(tid, pid, offer, protocol){
    return { tid: tid,
             pid: pid,
             protocol: protocol,
             type: 'MRequest',
             offer: offer };
};

module.exports.MResponse = function(tid, pid, offer, protocol){
    return { tid: tid,
             pid: pid,
             protocol: protocol,
             type: 'MResponse',
             offer: offer };
};

},{}],27:[function(require,module,exports){
var SortedArray = require('./extended-sorted-array');

function MultiSet(Comparator){
    this.ms = new SortedArray(Comparator||defaultComparator);
};

MultiSet.prototype.insert = function(entryOrId){
    var object = this.ms.get(entryOrId);
    if (object){
        // #1 if the object already exists, increment its occurrence
        object.occ += 1;
    } else {
        // #2 initalize the occurrence to 1 and insert it otherwise
        entryOrId.occ = 1;
        this.ms.insert(entryOrId);
    };
    return object;
};

MultiSet.prototype.remove = function(entryOrId){
    var object = this.ms.get(entryOrId);
    if (object){
        object.occ -= 1;
        (object.occ <= 0) && this.ms.remove(entryOrId);
    };
    return object;
};

MultiSet.prototype.removeAll = function(entryOrId){
    var object = this.ms.get(entryOrId);
    if (object){
//        object.occ = 0;
        this.ms.remove(entryOrId);
    };
    return object;
};

MultiSet.prototype.contains = function(entryOrId){
    return this.ms.contains(entryOrId);
};

MultiSet.prototype.get = function(entryOrId){
    return this.ms.get(entryOrId);
};

function defaultComparator(a, b){
    var first = a.id || a;
    var second = b.id || b;
    if (first < second){return -1};
    if (first > second){return  1};
    return 0;
};


module.exports = MultiSet;

},{"./extended-sorted-array":25}],28:[function(require,module,exports){
var EventEmitter = require('events').EventEmitter;
var Socket = require('simple-peer');
var util = require('util');

util.inherits(Neighborhood, EventEmitter);

var SortedArray = require('./extended-sorted-array.js');
var MultiSet = require('./multiset.js');
//var GUID = require('./guid.js'); (TODO) uncomment
var GUID = function(){return (''+Math.ceil(Math.random()*100000)+''); };

var MRequest = require('./messages.js').MRequest;
var MResponse = require('./messages.js').MResponse;


/*!
 * \brief neigbhorhood table providing easy establishment and management of
 * connections
 * \param options the options available to the connections, e.g. timeout before
 * connection are truely removed, WebRTC options
 */
function Neighborhood(options){
    EventEmitter.call(this);
    this.PROTOCOL = 'neighborhood-wrtc';
    this.ID = GUID();   
    // #1 save options
    this.options = (options && options.webrtc) || {};
    this.options.trickle = (options && options.webrtc &&
                            options.webrtc.trickle) || false;
    this.TIMEOUT = (options && options.timeout) || (2 * 60 * 1000); // 2 minutes
    // #2 initialize tables    
    this.pending = new SortedArray(Comparator); // not finalized yet
    this.living = new MultiSet(Comparator); // live and usable
    this.dying = new SortedArray(Comparator); // being remove
};

/*!
 * \brief creates a new incomming or outgoing connection depending on arguments
 * \param callback the callback function when the stun/ice server returns the
 * offer
 * \param object empty if it must initiate a connection, or the message received
 * if it must answer or finalize one
 * \param protocol the connection is established for a specific protocol
 * \return the id of the socket
 */
Neighborhood.prototype.connection = function(callbacks, message, protocol){
    var msg = (callbacks && callbacks.type && callbacks) || message;
    var result;
    
    if (!msg){
        result = initiate.call(this, callbacks, protocol);
    } else if (msg.type==='MRequest'){
        result = accept.call(this, msg, callbacks);
        result = alreadyExists.call(this, msg, callbacks) || result;
    } else if (msg.type==='MResponse'){
        result = finalize.call(this, msg);
        result = alreadyExists.call(this, msg) || result;
    };

    return result && result.id;
};


/*!
 * \brief disconnect one of the arc with the identifier in argument. If 
 * it was the last arc with such id, the socket is relocated to the dying
 * table. The socket will be destroy after a bit. If there is no argument,
 * disconnect the whole.
 */
Neighborhood.prototype.disconnect = function(id){
    if (!id){
        // #1 disconnect everything
        this.pending.arr.forEach(function(e){
            e.socket && e.socket.destroy();            
        });
        while (this.living.ms.arr.length>0){
            var e = this.living.ms.arr[0];
            e.socket && e.socket.destroy();
        };
        while (this.dying.arr.length>0){
            var e = this.dying.arr[0];
            e.socket && e.socket.destroy();
        };
    } else {
        // #2 remove one arc
        var entry = this.living.remove(id);
        entry && this.emit('disconnect', entry.id);
        if (entry && entry.occ <= 0){
            entry.timeout = setTimeout(function(){
                entry.socket.destroy();
            }, this.TIMEOUT);
            this.dying.insert(entry);
        };
    };
};


/*!
 * \brief get the entry corresponding to the id in argument. The entry contains
 * the socket.
 * \param id the identifier of the socket to retrieve
 * \return an entry from tables. It priorizes entries in living, then dying,
 * then pending.
 */
Neighborhood.prototype.get = function(id){
    return this.living.get(id) || this.dying.get(id) || this.pending.get(id);
};


/*!
 * \brief send a message to the socket in argument
 * \param id the identifier of the socket
 * \param message the message to send 
 * \return true if the message is sent, false otherwise
 */
Neighborhood.prototype.send = function(id, message){
    // #1 convert message to string (TODO) check if there is a better way
    var msg = ((message instanceof String) && message) ||
        JSON.stringify(message);
    // #2 get the socket to use
    var entry = this.get(id);
    var socket = entry && entry.socket;
    // #3 send
    var result = msg && socket && socket.connected && socket._channel &&
        (socket._channel.readyState === 'open');
    result && socket.send(msg);
    return result;
};


// // // // // // // // // //
//    PRIVATE functions    //
// // // // // // // // // //

/*!
 * \brief initiates a connection with another peer -- the id of which is unknown
 * \param callbacks the function to call when signaling info are received and
 * when the connection is ready to be used
 */
function initiate(callbacks, protocol){
    var self = this;
    var opts = this.options;
    opts.initiator = true;        
    var socket = new Socket(opts);
    var entry = {id: GUID(),
                 socket: socket,
                 protocol: protocol,
                 successful: false, // not yet
                 onOffer: callbacks && callbacks.onInitiate,
                 onReady: callbacks && callbacks.onReady };
    
    this.pending.insert(entry);
    socket.on('signal', function(offer){
        entry.onOffer &&
            entry.onOffer(new MRequest(entry.id, self.ID, offer, protocol));
    });
    entry.timeout = setTimeout(function(){
        var e = self.pending.get(entry.id);
        if (e && !e.successful){ self.emit('fail'); };        
        self.pending.remove(entry) && socket.destroy();
    }, this.TIMEOUT);
    
    return entry;
};

/*!
 * \brief accept the offer of another peer
 * \param message the received message containing id and offer
 * \param callbacks the function call after receiving the offer and 
 * when the connection is ready
 */
function accept(message, callbacks){
    // #1 if already exists, use it
    var prior = this.pending.get(message.tid);
    if (prior){ return prior; };
    // #2 otherwise, create the socket
    var self = this;
    // var opts=JSON.parse(JSON.stringify(this.options));// quick but ugly copy
    opts = this.options;
    opts.initiator = false;
    var socket = new Socket(opts);
    var entry = {id: message.tid,
                 pid: message.pid,
                 protocol: message.protocol,
                 socket: socket,
                 successful: false,
                 onOffer: callbacks && callbacks.onAccept,
                 onReady: callbacks && callbacks.onReady };
    
    this.pending.insert(entry);
    socket.on('signal', function(offer){
        entry.onOffer &&
            entry.onOffer(new MResponse(entry.id,
                                        self.ID,
                                        offer,
                                        entry.protocol));
    });
    socket.on('connect', function(){
        self.get(entry.pid) && socket.destroy();
        self.pending.remove(entry);
        self.living.insert({id: entry.pid,
                            socket: entry.socket,
                            onReady: entry.onReady,
                            onOffer: entry.onOffer});        
        entry.onReady && entry.onReady(entry.pid);
        self.emit('ready', entry.pid);
        entry.protocol && self.emit('ready-'+entry.protocol, entry.pid);
        clearTimeout(entry.timeout);
        entry.timeout = null;        
    });
    socket.on('close', function(){
        if (self.pending.contains(entry.id)){
            // #A pending: entry is kept until automatic destruction
            entry.socket = null;
        } else {
            // #B living or dying: clear the tables
            entry.timeout && clearTimeout(entry.timeout);
            entry.timeout = null;
            var live = self.living.removeAll(entry.pid);
            if (live){
                for (var i = 0; i < live.occ; ++i){
                    self.emit('disconnect', entry.pid)
                };
            };
            self.dying.remove(entry.pid);
        };
    });

    common.call(this, entry);
    
    entry.timeout = setTimeout(function(){
        var e = self.pending.get(entry.id);
        if (e && !e.successful){ self.emit('fail'); };
        self.pending.remove(entry.id) && socket.destroy();
    }, this.TIMEOUT);
    
    return entry;
};

/*!
 * \brief Common behavior to initiating and accepting sockets
 * \param entry the entry in the neighborhood table
 */
function common(entry){
    var self = this, socket = entry.socket;
    
    socket.on('data', function(message){
        message = JSON.parse(message.toString());
        self.emit('receive', entry.pid, message);
    });
    socket.on('stream', function(stream){
        self.emit('stream', entry.pid, stream);
    });
    socket.on('error', function(err){
        //console.error(err); (XXX) do something useful here
    });
};

/*!
 * \brief finalize the behavior of an initiating socket
 * \param messge the received message possibly containing an answer to the
 * proposed offer
 */
function finalize(message){
    // #1 if it does not exists, stop; or if it exists but already setup
    // return it
    var prior = this.pending.get(message.tid);
    if (!prior || prior.pid){return prior;}
    // #2 otherwise set the events correctly
    prior.pid = message.pid;    
    
    var entry = {id: message.pid,
                 socket: prior.socket,
                 protocol: prior.protocol,
                 onReady: prior.onReady,
                 onOffer: prior.onOffer };
    
    var self = this, socket = entry.socket;
    socket.on('connect', function(){
        self.get(entry.id) && socket.destroy();
        self.pending.remove(prior);
        self.living.insert(entry);
        entry.onReady && entry.onReady(prior.pid);
        self.emit('ready', prior.pid);
        entry.protocol && self.emit('ready-'+entry.protocol, prior.pid);
        clearTimeout(prior.timeout);
    });
    socket.on('close', function(){
        if (self.pending.contains(message.tid)){
            self.pending.get(message.tid).socket = null;
        } else {
            prior.timeout && clearTimeout(prior.timeout);
            prior.timeout = null;
            var live = self.living.removeAll(prior.pid);
            if (live){
                for (var i = 0; i < live.occ; ++i){
                    self.emit('disconnect', prior.pid);
                };
            };
            self.dying.remove(prior.pid);
        };
    });  

    common.call(this, prior);
    
    return prior;
};

/*!
 * \brief the peer id already exists in the tables
 */
function alreadyExists(message, callbacks){
    var alreadyExists = this.get(message.pid);
    if  (!alreadyExists){
        // #A does not already exists but pending
        var entry = this.pending.get(message.tid);
        entry && entry.socket && entry.socket.signal(message.offer);
    } else {
        // #B already exists and pending
        var toRemove = this.pending.get(message.tid);        
        if (toRemove && toRemove.socket){ // exists but socket still w8in
            if (!alreadyExists.timeout){
                // #1 already in living socket, add an occurrence
                this.living.insert(message.pid);
                toRemove.successful = true;
            } else {
                // #2 was dying, resurect the socket 
                this.dying.remove(alreadyExists);
                clearTimeout(alreadyExists.timeout);
                alreadyExists.timeout = null;
                this.living.insert(alreadyExists);
                toRemove.successful = true;
            };
            toRemove.socket.destroy();
            // #C standard on accept function if it exists in arg
            message.offer &&
                callbacks &&
                callbacks.onAccept &&
                callbacks.onAccept(new MResponse(message.tid,
                                                 this.ID,
                                                 null,
                                                 message.protocol));
            (callbacks &&
             callbacks.onReady &&
             callbacks.onReady(alreadyExists.id)) ||
                (toRemove &&
                 toRemove.onReady &&
                 toRemove.onReady(alreadyExists.id));
            this.emit('ready', alreadyExists.id);
            message.protocol && this.emit('ready-'+message.protocol,
                                          alreadyExists.id);
        };
    };
    
    return alreadyExists;
};



/*!
 * \brief compare the id of entries in tables
 */
function Comparator(a, b){
    var first = a.id || a;
    var second = b.id || b;
    if (first < second){ return -1; };
    if (first > second){ return  1; };
    return 0;
};


module.exports = Neighborhood;

},{"./extended-sorted-array.js":25,"./messages.js":26,"./multiset.js":27,"events":61,"simple-peer":46,"util":65}],29:[function(require,module,exports){
module.exports=require(21)
},{"/Users/chat-wane/Desktop/project/crate-core/node_modules/spray-wrtc/node_modules/binary-search/index.js":21}],30:[function(require,module,exports){
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

function isArray(arg) {
  if (Array.isArray) {
    return Array.isArray(arg);
  }
  return objectToString(arg) === '[object Array]';
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
  return objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return (objectToString(e) === '[object Error]' || e instanceof Error);
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

exports.isBuffer = Buffer.isBuffer;

function objectToString(o) {
  return Object.prototype.toString.call(o);
}

}).call(this,require("buffer").Buffer)
},{"buffer":57}],31:[function(require,module,exports){

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

},{"./debug":32}],32:[function(require,module,exports){

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

},{"ms":37}],33:[function(require,module,exports){
// originally pulled out of simple-peer

module.exports = function getBrowserRTC () {
  if (typeof window === 'undefined') return null
  var wrtc = {
    RTCPeerConnection: window.RTCPeerConnection || window.mozRTCPeerConnection ||
      window.webkitRTCPeerConnection,
    RTCSessionDescription: window.RTCSessionDescription ||
      window.mozRTCSessionDescription || window.webkitRTCSessionDescription,
    RTCIceCandidate: window.RTCIceCandidate || window.mozRTCIceCandidate ||
      window.webkitRTCIceCandidate
  }
  if (!wrtc.RTCPeerConnection) return null
  return wrtc
}

},{}],34:[function(require,module,exports){
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

},{}],35:[function(require,module,exports){
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

},{}],36:[function(require,module,exports){
module.exports = Array.isArray || function (arr) {
  return Object.prototype.toString.call(arr) == '[object Array]';
};

},{}],37:[function(require,module,exports){
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

},{}],38:[function(require,module,exports){
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

},{"wrappy":50}],39:[function(require,module,exports){
(function (process){
'use strict';

if (!process.version ||
    process.version.indexOf('v0.') === 0 ||
    process.version.indexOf('v1.') === 0 && process.version.indexOf('v1.8.') !== 0) {
  module.exports = nextTick;
} else {
  module.exports = process.nextTick;
}

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
},{"_process":63}],40:[function(require,module,exports){
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

},{"./_stream_readable":42,"./_stream_writable":44,"core-util-is":30,"inherits":35,"process-nextick-args":39}],41:[function(require,module,exports){
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

},{"./_stream_transform":43,"core-util-is":30,"inherits":35}],42:[function(require,module,exports){
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

var EE = require('events');

/*<replacement>*/
var EElistenerCount = function(emitter, type) {
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
var debugUtil = require('util');
var debug;
if (debugUtil && debugUtil.debuglog) {
  debug = debugUtil.debuglog('stream');
} else {
  debug = function () {};
}
/*</replacement>*/

var StringDecoder;

util.inherits(Readable, Stream);

var Duplex;
function ReadableState(options, stream) {
  Duplex = Duplex || require('./_stream_duplex');

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

var Duplex;
function Readable(options) {
  Duplex = Duplex || require('./_stream_duplex');

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

// Don't raise the hwm > 8MB
var MAX_HWM = 0x800000;
function computeNewHighWaterMark(n) {
  if (n >= MAX_HWM) {
    n = MAX_HWM;
  } else {
    // Get the next highest power of 2
    n--;
    n |= n >>> 1;
    n |= n >>> 2;
    n |= n >>> 4;
    n |= n >>> 8;
    n |= n >>> 16;
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
    state.highWaterMark = computeNewHighWaterMark(n);

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

  var cleanedUp = false;
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

    cleanedUp = true;

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
      // If the user unpiped during `dest.write()`, it is possible
      // to get stuck in a permanently paused state if that write
      // also returned false.
      if (state.pipesCount === 1 &&
          state.pipes[0] === dest &&
          src.listenerCount('data') === 1 &&
          !cleanedUp) {
        debug('false write response, pause', src._readableState.awaitDrain);
        src._readableState.awaitDrain++;
      }
      src.pause();
    }
  }

  // if the dest has an error, then stop piping into it.
  // however, don't suppress the throwing behavior for this.
  function onerror(er) {
    debug('onerror', er);
    unpipe();
    dest.removeListener('error', onerror);
    if (EElistenerCount(dest, 'error') === 0)
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
    if (state.awaitDrain === 0 && EElistenerCount(src, 'data')) {
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
    else if (list.length === 1)
      ret = list[0];
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
},{"./_stream_duplex":40,"_process":63,"buffer":57,"core-util-is":30,"events":61,"inherits":35,"isarray":36,"process-nextick-args":39,"string_decoder/":48,"util":56}],43:[function(require,module,exports){
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

},{"./_stream_duplex":40,"core-util-is":30,"inherits":35}],44:[function(require,module,exports){
// A bit simpler than readable streams.
// Implement an async ._write(chunk, encoding, cb), and it'll handle all
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
var internalUtil = {
  deprecate: require('util-deprecate')
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

util.inherits(Writable, Stream);

function nop() {}

function WriteReq(chunk, encoding, cb) {
  this.chunk = chunk;
  this.encoding = encoding;
  this.callback = cb;
  this.next = null;
}

var Duplex;
function WritableState(options, stream) {
  Duplex = Duplex || require('./_stream_duplex');

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
  get: internalUtil.deprecate(function() {
    return this.getBuffer();
  }, '_writableState.buffer is deprecated. Use _writableState.getBuffer ' +
     'instead.')
});
}catch(_){}}());


var Duplex;
function Writable(options) {
  Duplex = Duplex || require('./_stream_duplex');

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

},{"./_stream_duplex":40,"buffer":57,"core-util-is":30,"events":61,"inherits":35,"process-nextick-args":39,"util-deprecate":49}],45:[function(require,module,exports){
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

},{"./lib/_stream_duplex.js":40,"./lib/_stream_passthrough.js":41,"./lib/_stream_readable.js":42,"./lib/_stream_transform.js":43,"./lib/_stream_writable.js":44}],46:[function(require,module,exports){
(function (Buffer){
module.exports = Peer

var debug = require('debug')('simple-peer')
var getBrowserRTC = require('get-browser-rtc')
var hat = require('hat')
var inherits = require('inherits')
var once = require('once')
var stream = require('readable-stream')

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
  self.channelName = opts.initiator ? (opts.channelName || hat(160)) : null
  self.config = opts.config || Peer.config
  self.constraints = opts.constraints || Peer.constraints
  self.offerConstraints = opts.offerConstraints
  self.answerConstraints = opts.answerConstraints
  self.reconnectTimer = opts.reconnectTimer || false
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

  self._isWrtc = !!opts.wrtc // HACK: to fix `wrtc` bug. See issue: #60
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
  self._pendingCandidates = []

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

  function addIceCandidate (candidate) {
    try {
      self._pc.addIceCandidate(
        new self._wrtc.RTCIceCandidate(candidate), noop, self._onError.bind(self)
      )
    } catch (err) {
      self._destroy(new Error('error adding candidate: ' + err.message))
    }
  }

  if (data.sdp) {
    self._pc.setRemoteDescription(new (self._wrtc.RTCSessionDescription)(data), function () {
      if (self.destroyed) return
      if (self._pc.remoteDescription.type === 'offer') self._createAnswer()

      self._pendingCandidates.forEach(addIceCandidate)
      self._pendingCandidates = []
    }, self._onError.bind(self))
  }
  if (data.candidate) {
    if (self._pc.remoteDescription) addIceCandidate(data.candidate)
    else self._pendingCandidates.push(data.candidate)
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

  // HACK: `wrtc` module doesn't accept node.js buffer. See issue: #60
  if (Buffer.isBuffer(chunk) && self._isWrtc) {
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
    try {
      self.send(chunk)
    } catch (err) {
      return self._onError(err)
    }
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
    offer.sdp = self.sdpTransform(offer.sdp)
    self._pc.setLocalDescription(offer, noop, self._onError.bind(self))
    var sendOffer = function () {
      var signal = self._pc.localDescription || offer
      self._debug('signal')
      self.emit('signal', {
        type: signal.type,
        sdp: signal.sdp
      })
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
    answer.sdp = self.sdpTransform(answer.sdp)
    self._pc.setLocalDescription(answer, noop, self._onError.bind(self))
    var sendAnswer = function () {
      var signal = self._pc.localDescription || answer
      self._debug('signal')
      self.emit('signal', {
        type: signal.type,
        sdp: signal.sdp
      })
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
  if (iceConnectionState === 'failed') {
    self._destroy()
  }
  if (iceConnectionState === 'closed') {
    self._destroy()
  }
}

Peer.prototype.getStats = function (cb) {
  var self = this
  if (!self._pc.getStats) { // No ability to call stats
    cb([])
  } else if (typeof window !== 'undefined' && !!window.mozRTCPeerConnection) { // Mozilla
    self._pc.getStats(null, function (res) {
      var items = []
      res.forEach(function (item) {
        items.push(item)
      })
      cb(items)
    }, self._onError.bind(self))
  } else {
    self._pc.getStats(function (res) { // Chrome
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
      cb(items)
    })
  }
}

Peer.prototype._maybeReady = function () {
  var self = this
  self._debug('maybeReady pc %s channel %s', self._pcReady, self._channelReady)
  if (self.connected || self._connecting || !self._pcReady || !self._channelReady) return
  self._connecting = true

  self.getStats(function (items) {
    self._connecting = false
    self.connected = true

    var remoteCandidates = {}
    var localCandidates = {}

    function setActiveCandidates (item) {
      var local = localCandidates[item.localCandidateId]
      var remote = remoteCandidates[item.remoteCandidateId]

      if (local) {
        self.localAddress = local.ipAddress
        self.localPort = Number(local.portNumber)
      } else if (typeof item.googLocalAddress === 'string') {
        // Sometimes `item.id` is undefined in `wrtc` and Chrome
        // See: https://github.com/feross/simple-peer/issues/66
        local = item.googLocalAddress.split(':')
        self.localAddress = local[0]
        self.localPort = Number(local[1])
      }
      self._debug('connect local: %s:%s', self.localAddress, self.localPort)

      if (remote) {
        self.remoteAddress = remote.ipAddress
        self.remotePort = Number(remote.portNumber)
        self.remoteFamily = 'IPv4'
      } else if (typeof item.googRemoteAddress === 'string') {
        remote = item.googRemoteAddress.split(':')
        self.remoteAddress = remote[0]
        self.remotePort = Number(remote[1])
        self.remoteFamily = 'IPv4'
      }
      self._debug('connect remote: %s:%s', self.remoteAddress, self.remotePort)
    }

    items.forEach(function (item) {
      if (item.type === 'remotecandidate') remoteCandidates[item.id] = item
      if (item.type === 'localcandidate') localCandidates[item.id] = item
    })

    items.forEach(function (item) {
      var isCandidatePair = (
        (item.type === 'googCandidatePair' && item.googActiveConnection === 'true') ||
        (item.type === 'candidatepair' && item.selected)
      )
      if (isCandidatePair) setActiveCandidates(item)
    })

    if (self._chunk) {
      try {
        self.send(self._chunk)
      } catch (err) {
        return self._onError(err)
      }
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
  })
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
    self.emit('signal', {
      candidate: {
        candidate: event.candidate.candidate,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        sdpMid: event.candidate.sdpMid
      }
    })
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

  if (data instanceof ArrayBuffer) data = new Buffer(data)
  self.push(data)
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

function noop () {}

}).call(this,require("buffer").Buffer)
},{"buffer":57,"debug":31,"get-browser-rtc":33,"hat":34,"inherits":35,"once":38,"readable-stream":45}],47:[function(require,module,exports){
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

},{"binary-search":29}],48:[function(require,module,exports){
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

},{"buffer":57}],49:[function(require,module,exports){
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
},{}],50:[function(require,module,exports){
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

},{}],51:[function(require,module,exports){
module.exports=require(47)
},{"/Users/chat-wane/Desktop/project/crate-core/node_modules/spray-wrtc/node_modules/n2n-overlay-wrtc/node_modules/neighborhood-wrtc/node_modules/sorted-cmp-array/index.js":47,"binary-search":21}],52:[function(require,module,exports){
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


},{"./vvweentry.js":53,"sorted-cmp-array":54}],53:[function(require,module,exports){

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

},{}],54:[function(require,module,exports){
module.exports=require(47)
},{"/Users/chat-wane/Desktop/project/crate-core/node_modules/spray-wrtc/node_modules/n2n-overlay-wrtc/node_modules/neighborhood-wrtc/node_modules/sorted-cmp-array/index.js":47,"binary-search":55}],55:[function(require,module,exports){
module.exports=require(21)
},{"/Users/chat-wane/Desktop/project/crate-core/node_modules/spray-wrtc/node_modules/binary-search/index.js":21}],56:[function(require,module,exports){

},{}],57:[function(require,module,exports){
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

},{"base64-js":58,"ieee754":59,"is-array":60}],58:[function(require,module,exports){
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

},{}],59:[function(require,module,exports){
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

},{}],60:[function(require,module,exports){

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

},{}],61:[function(require,module,exports){
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

},{}],62:[function(require,module,exports){
module.exports=require(35)
},{"/Users/chat-wane/Desktop/project/crate-core/node_modules/spray-wrtc/node_modules/n2n-overlay-wrtc/node_modules/neighborhood-wrtc/node_modules/inherits/inherits_browser.js":35}],63:[function(require,module,exports){
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

},{}],64:[function(require,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],65:[function(require,module,exports){
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
},{"./support/isBuffer":64,"_process":63,"inherits":62}],"crate-core":[function(require,module,exports){
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
    this.broadcast = new CausalBroadcast(new Spray(this.options),
                                         new VVwE(this.id));
    this.sequence = new LSEQTree(this.id);

    var self = this;
    // #A regular receive
    this.broadcast.on('receive', function(receivedBroadcastMessage){
        switch (receivedBroadcastMessage.type){
        case 'MRemoveOperation':
            self.remoteRemove(receivedBroadcastMessage.remove,
                              receivedBroadcastMessage.origin);
            break;
        case 'MInsertOperation':
            self.remoteInsert(receivedBroadcastMessage.insert,
                              receivedBroadcastMessage.origin);
            break;
        case 'MCaretMovedOperation':
            self.remoteCaretMoved(receivedBroadcastMessage.range,
                                  receivedBroadcastMessage.origin);
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
    this.broadcast.send(new MInsertOperation(ei, id._e), id, null);
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
    this.broadcast.send(new MRemoveOperation(i, id._e), id, isReady);
    return i;
};

CrateCore.prototype.caretMoved = function(range){
    this.sequence._c += 1;
    var id = {_e:this.sequence._s, _c: this.sequence._c } // (TODO) fix uglyness
    this.broadcast.send(new MCaretMovedOperation(range, id._e), id, null);
    return range;
};

/*!
 * \brief insertion of an element from a remote site. It emits 'remoteInsert' 
 * with the index of the element to insert, -1 if already existing.
 * \param ei the result of the remote insert operation
 * \param origin the origin id of the insert operation
 */
CrateCore.prototype.remoteInsert = function(ei, origin){
    var index = this.sequence.applyInsert(ei._e, ei._i, false);
    this.emit('remoteInsert', ei._e, index);
    if (index >= 0 && origin){
        this.emit('remoteCaretMoved', {start: index, end: index}, origin);
    };
};

/*!
 * \brief removal of an element from a remote site.  It emits 'remoteRemove'
 * with the index of the element to remove, -1 if does not exist
 * \param id the result of the remote insert operation
 * \param origin the origin id of the removal
 */
CrateCore.prototype.remoteRemove = function(id, origin){
    var index = this.sequence.applyRemove(id);
    this.emit('remoteRemove', index);
    if (index >= 0 && origin){
        this.emit('remoteCaretMoved', {start: index-1, end: index-1}, origin);
    };
};

CrateCore.prototype.remoteCaretMoved = function(range, origin){
    this.emit('remoteCaretMoved', range, origin);
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

},{"./guid.js":1,"./messages.js":2,"causal-broadcast-definition":3,"events":61,"lseqtree":11,"spray-wrtc":20,"util":65,"version-vector-with-exceptions":52}]},{},[])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXItcGFjay9fcHJlbHVkZS5qcyIsImxpYi9ndWlkLmpzIiwibGliL21lc3NhZ2VzLmpzIiwibm9kZV9tb2R1bGVzL2NhdXNhbC1icm9hZGNhc3QtZGVmaW5pdGlvbi9saWIvY2F1c2FsYnJvYWRjYXN0LmpzIiwibm9kZV9tb2R1bGVzL2NhdXNhbC1icm9hZGNhc3QtZGVmaW5pdGlvbi9saWIvbWVzc2FnZXMuanMiLCJub2RlX21vZHVsZXMvY2F1c2FsLWJyb2FkY2FzdC1kZWZpbml0aW9uL25vZGVfbW9kdWxlcy91bmljYXN0LWRlZmluaXRpb24vbGliL21lc3NhZ2VzLmpzIiwibm9kZV9tb2R1bGVzL2NhdXNhbC1icm9hZGNhc3QtZGVmaW5pdGlvbi9ub2RlX21vZHVsZXMvdW5pY2FzdC1kZWZpbml0aW9uL2xpYi91bmljYXN0LmpzIiwibm9kZV9tb2R1bGVzL2xzZXF0cmVlL2xpYi9iYXNlLmpzIiwibm9kZV9tb2R1bGVzL2xzZXF0cmVlL2xpYi9pZGVudGlmaWVyLmpzIiwibm9kZV9tb2R1bGVzL2xzZXF0cmVlL2xpYi9sc2Vxbm9kZS5qcyIsIm5vZGVfbW9kdWxlcy9sc2VxdHJlZS9saWIvbHNlcXRyZWUuanMiLCJub2RlX21vZHVsZXMvbHNlcXRyZWUvbGliL3N0cmF0ZWd5LmpzIiwibm9kZV9tb2R1bGVzL2xzZXF0cmVlL2xpYi90cmlwbGUuanMiLCJub2RlX21vZHVsZXMvbHNlcXRyZWUvbGliL3V0aWwuanMiLCJub2RlX21vZHVsZXMvbHNlcXRyZWUvbm9kZV9tb2R1bGVzL0JpZ0ludC9zcmMvQmlnSW50LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbGliL2V4dGVuZGVkLXNvcnRlZC1hcnJheS5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL2xpYi9tZXNzYWdlcy5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL2xpYi9wYXJ0aWFsdmlldy5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL2xpYi9zcHJheS5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9iaW5hcnktc2VhcmNoL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL2Nsb25lL2Nsb25lLmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL24ybi1vdmVybGF5LXdydGMvbGliL21lc3NhZ2VzLmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL24ybi1vdmVybGF5LXdydGMvbGliL24ybi1vdmVybGF5LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL24ybi1vdmVybGF5LXdydGMvbm9kZV9tb2R1bGVzL25laWdoYm9yaG9vZC13cnRjL2xpYi9tZXNzYWdlcy5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9uMm4tb3ZlcmxheS13cnRjL25vZGVfbW9kdWxlcy9uZWlnaGJvcmhvb2Qtd3J0Yy9saWIvbXVsdGlzZXQuanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvbjJuLW92ZXJsYXktd3J0Yy9ub2RlX21vZHVsZXMvbmVpZ2hib3Job29kLXdydGMvbGliL25laWdoYm9yaG9vZC5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9uMm4tb3ZlcmxheS13cnRjL25vZGVfbW9kdWxlcy9uZWlnaGJvcmhvb2Qtd3J0Yy9ub2RlX21vZHVsZXMvY29yZS11dGlsLWlzL2xpYi91dGlsLmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL24ybi1vdmVybGF5LXdydGMvbm9kZV9tb2R1bGVzL25laWdoYm9yaG9vZC13cnRjL25vZGVfbW9kdWxlcy9kZWJ1Zy9icm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL24ybi1vdmVybGF5LXdydGMvbm9kZV9tb2R1bGVzL25laWdoYm9yaG9vZC13cnRjL25vZGVfbW9kdWxlcy9kZWJ1Zy9kZWJ1Zy5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9uMm4tb3ZlcmxheS13cnRjL25vZGVfbW9kdWxlcy9uZWlnaGJvcmhvb2Qtd3J0Yy9ub2RlX21vZHVsZXMvZ2V0LWJyb3dzZXItcnRjL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL24ybi1vdmVybGF5LXdydGMvbm9kZV9tb2R1bGVzL25laWdoYm9yaG9vZC13cnRjL25vZGVfbW9kdWxlcy9oYXQvaW5kZXguanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvbjJuLW92ZXJsYXktd3J0Yy9ub2RlX21vZHVsZXMvbmVpZ2hib3Job29kLXdydGMvbm9kZV9tb2R1bGVzL2luaGVyaXRzL2luaGVyaXRzX2Jyb3dzZXIuanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvbjJuLW92ZXJsYXktd3J0Yy9ub2RlX21vZHVsZXMvbmVpZ2hib3Job29kLXdydGMvbm9kZV9tb2R1bGVzL2lzYXJyYXkvaW5kZXguanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvbjJuLW92ZXJsYXktd3J0Yy9ub2RlX21vZHVsZXMvbmVpZ2hib3Job29kLXdydGMvbm9kZV9tb2R1bGVzL21zL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL24ybi1vdmVybGF5LXdydGMvbm9kZV9tb2R1bGVzL25laWdoYm9yaG9vZC13cnRjL25vZGVfbW9kdWxlcy9vbmNlL29uY2UuanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvbjJuLW92ZXJsYXktd3J0Yy9ub2RlX21vZHVsZXMvbmVpZ2hib3Job29kLXdydGMvbm9kZV9tb2R1bGVzL3Byb2Nlc3MtbmV4dGljay1hcmdzL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL24ybi1vdmVybGF5LXdydGMvbm9kZV9tb2R1bGVzL25laWdoYm9yaG9vZC13cnRjL25vZGVfbW9kdWxlcy9yZWFkYWJsZS1zdHJlYW0vbGliL19zdHJlYW1fZHVwbGV4LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL24ybi1vdmVybGF5LXdydGMvbm9kZV9tb2R1bGVzL25laWdoYm9yaG9vZC13cnRjL25vZGVfbW9kdWxlcy9yZWFkYWJsZS1zdHJlYW0vbGliL19zdHJlYW1fcGFzc3Rocm91Z2guanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvbjJuLW92ZXJsYXktd3J0Yy9ub2RlX21vZHVsZXMvbmVpZ2hib3Job29kLXdydGMvbm9kZV9tb2R1bGVzL3JlYWRhYmxlLXN0cmVhbS9saWIvX3N0cmVhbV9yZWFkYWJsZS5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9uMm4tb3ZlcmxheS13cnRjL25vZGVfbW9kdWxlcy9uZWlnaGJvcmhvb2Qtd3J0Yy9ub2RlX21vZHVsZXMvcmVhZGFibGUtc3RyZWFtL2xpYi9fc3RyZWFtX3RyYW5zZm9ybS5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9uMm4tb3ZlcmxheS13cnRjL25vZGVfbW9kdWxlcy9uZWlnaGJvcmhvb2Qtd3J0Yy9ub2RlX21vZHVsZXMvcmVhZGFibGUtc3RyZWFtL2xpYi9fc3RyZWFtX3dyaXRhYmxlLmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL24ybi1vdmVybGF5LXdydGMvbm9kZV9tb2R1bGVzL25laWdoYm9yaG9vZC13cnRjL25vZGVfbW9kdWxlcy9yZWFkYWJsZS1zdHJlYW0vcmVhZGFibGUuanMiLCJub2RlX21vZHVsZXMvc3ByYXktd3J0Yy9ub2RlX21vZHVsZXMvbjJuLW92ZXJsYXktd3J0Yy9ub2RlX21vZHVsZXMvbmVpZ2hib3Job29kLXdydGMvbm9kZV9tb2R1bGVzL3NpbXBsZS1wZWVyL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL24ybi1vdmVybGF5LXdydGMvbm9kZV9tb2R1bGVzL25laWdoYm9yaG9vZC13cnRjL25vZGVfbW9kdWxlcy9zb3J0ZWQtY21wLWFycmF5L2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3NwcmF5LXdydGMvbm9kZV9tb2R1bGVzL24ybi1vdmVybGF5LXdydGMvbm9kZV9tb2R1bGVzL25laWdoYm9yaG9vZC13cnRjL25vZGVfbW9kdWxlcy9zdHJpbmdfZGVjb2Rlci9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9uMm4tb3ZlcmxheS13cnRjL25vZGVfbW9kdWxlcy9uZWlnaGJvcmhvb2Qtd3J0Yy9ub2RlX21vZHVsZXMvdXRpbC1kZXByZWNhdGUvYnJvd3Nlci5qcyIsIm5vZGVfbW9kdWxlcy9zcHJheS13cnRjL25vZGVfbW9kdWxlcy9uMm4tb3ZlcmxheS13cnRjL25vZGVfbW9kdWxlcy9uZWlnaGJvcmhvb2Qtd3J0Yy9ub2RlX21vZHVsZXMvd3JhcHB5L3dyYXBweS5qcyIsIm5vZGVfbW9kdWxlcy92ZXJzaW9uLXZlY3Rvci13aXRoLWV4Y2VwdGlvbnMvbGliL3Z2d2UuanMiLCJub2RlX21vZHVsZXMvdmVyc2lvbi12ZWN0b3Itd2l0aC1leGNlcHRpb25zL2xpYi92dndlZW50cnkuanMiLCIuLi8uLi8uLi8uLi8uLi91c3IvbG9jYWwvbGliL25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXJlc29sdmUvZW1wdHkuanMiLCIuLi8uLi8uLi8uLi8uLi91c3IvbG9jYWwvbGliL25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9idWZmZXIvaW5kZXguanMiLCIuLi8uLi8uLi8uLi8uLi91c3IvbG9jYWwvbGliL25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9idWZmZXIvbm9kZV9tb2R1bGVzL2Jhc2U2NC1qcy9saWIvYjY0LmpzIiwiLi4vLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvYnVmZmVyL25vZGVfbW9kdWxlcy9pZWVlNzU0L2luZGV4LmpzIiwiLi4vLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvYnVmZmVyL25vZGVfbW9kdWxlcy9pcy1hcnJheS9pbmRleC5qcyIsIi4uLy4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2V2ZW50cy9ldmVudHMuanMiLCIuLi8uLi8uLi8uLi8uLi91c3IvbG9jYWwvbGliL25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9wcm9jZXNzL2Jyb3dzZXIuanMiLCIuLi8uLi8uLi8uLi8uLi91c3IvbG9jYWwvbGliL25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy91dGlsL3N1cHBvcnQvaXNCdWZmZXJCcm93c2VyLmpzIiwiLi4vLi4vLi4vLi4vLi4vdXNyL2xvY2FsL2xpYi9ub2RlX21vZHVsZXMvYnJvd3NlcmlmeS9ub2RlX21vZHVsZXMvdXRpbC91dGlsLmpzIiwibGliL2NyYXRlLWNvcmUuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDeE5BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDWEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3RUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdPQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbkxBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4SkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3Z0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUNiQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hOQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuU0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbEtBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDNU5BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDcFhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0dBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDck1BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZCQTtBQUNBO0FBQ0E7QUFDQTs7QUNIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2o5QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JNQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2poQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDWkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcmlCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbkNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3TkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDakNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDakpBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7O0FDOURBOztBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM2hDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4SEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDN1NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0xBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVrQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3ZhciBmPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIik7dGhyb3cgZi5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGZ9dmFyIGw9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGwuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sbCxsLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsIi8qXG4gKiBcXHVybCBodHRwczovL2dpdGh1Yi5jb20vanVzdGF5YWsveXV0aWxzL2Jsb2IvbWFzdGVyL3l1dGlscy5qc1xuICogXFxhdXRob3IganVzdGF5YWtcbiAqL1xuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0IGEgZ2xvYmFsbHkgdW5pcXVlICh3aXRoIGhpZ2ggcHJvYmFiaWxpdHkpIGlkZW50aWZpZXJcbiAqIFxccmV0dXJuIGEgc3RyaW5nIGJlaW5nIHRoZSBpZGVudGlmaWVyXG4gKi9cbmZ1bmN0aW9uIEdVSUQoKXtcbiAgICB2YXIgZCA9IG5ldyBEYXRlKCkuZ2V0VGltZSgpO1xuICAgIHZhciBndWlkID0gJ3h4eHh4eHh4LXh4eHgtNHh4eC15eHh4LXh4eHh4eHh4eHh4eCcucmVwbGFjZSgvW3h5XS9nLCBmdW5jdGlvbiAoYykge1xuICAgICAgICB2YXIgciA9IChkICsgTWF0aC5yYW5kb20oKSAqIDE2KSAlIDE2IHwgMDtcbiAgICAgICAgZCA9IE1hdGguZmxvb3IoZCAvIDE2KTtcbiAgICAgICAgcmV0dXJuIChjID09PSAneCcgPyByIDogKHIgJiAweDMgfCAweDgpKS50b1N0cmluZygxNik7XG4gICAgfSk7XG4gICAgcmV0dXJuIGd1aWQ7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IEdVSUQ7XG4iLCIvKiFcbiAqIFxcYnJpZWYgb2JqZWN0IHRoYXQgcmVwcmVzZW50cyB0aGUgcmVzdWx0IG9mIGFuIGluc2VydCBvcGVyYXRpb25cbiAqIFxccGFyYW0gaW5zZXJ0IHRoZSByZXN1bHQgb2YgdGhlIGxvY2FsIGluc2VydCBvcGVyYXRpb25cbiAqIFxccGFyYW0gb3JpZ2luIHRoZSBvcmlnaW4gb2YgdGhlIGluc2VydGlvblxuICovXG5mdW5jdGlvbiBNSW5zZXJ0T3BlcmF0aW9uKGluc2VydCwgb3JpZ2luKXtcbiAgICB0aGlzLnR5cGUgPSBcIk1JbnNlcnRPcGVyYXRpb25cIjtcbiAgICB0aGlzLmluc2VydCA9IGluc2VydDtcbiAgICB0aGlzLm9yaWdpbiA9IG9yaWdpbjtcbn07XG5tb2R1bGUuZXhwb3J0cy5NSW5zZXJ0T3BlcmF0aW9uID0gTUluc2VydE9wZXJhdGlvbjtcblxuZnVuY3Rpb24gTUFFSW5zZXJ0T3BlcmF0aW9uKGluc2VydCwgaWQpe1xuICAgIHRoaXMudHlwZSA9IFwiTUFFSW5zZXJ0T3BlcmF0aW9uXCI7XG4gICAgdGhpcy5wYXlsb2FkID0gbmV3IE1JbnNlcnRPcGVyYXRpb24oaW5zZXJ0KTtcbiAgICB0aGlzLmlkID0gaWQ7XG4gICAgdGhpcy5pc1JlYWR5ID0gbnVsbDtcbn07XG5tb2R1bGUuZXhwb3J0cy5NQUVJbnNlcnRPcGVyYXRpb24gPSBNQUVJbnNlcnRPcGVyYXRpb247XG5cbi8qIVxuICogXFxicmllZiBvYmplY3QgdGhhdCByZXByZXNlbnRzIHRoZSByZXN1bHQgb2YgYSBkZWxldGUgb3BlcmF0aW9uXG4gKiBcXHBhcmFtIHJlbW92ZSB0aGUgcmVzdWx0IG9mIHRoZSBsb2NhbCBkZWxldGUgb3BlcmF0aW9uXG4gKiBcXHBhcmFtIG9yaWdpbiB0aGUgb3JpZ2luIG9mIHRoZSByZW1vdmFsXG4gKi9cbmZ1bmN0aW9uIE1SZW1vdmVPcGVyYXRpb24ocmVtb3ZlLCBvcmlnaW4pe1xuICAgIHRoaXMudHlwZSA9IFwiTVJlbW92ZU9wZXJhdGlvblwiO1xuICAgIHRoaXMucmVtb3ZlID0gcmVtb3ZlO1xuICAgIHRoaXMub3JpZ2luID0gb3JpZ2luO1xufTtcbm1vZHVsZS5leHBvcnRzLk1SZW1vdmVPcGVyYXRpb24gPSBNUmVtb3ZlT3BlcmF0aW9uO1xuXG4vKiFcbiAqIFxcYnJpZWYgb2JqZWN0IHRoYXQgcmVwcmVzZW50cyB0aGUgcmVzdWx0IG9mIGEgY2FyZXRNb3ZlZCBPcGVyYXRpb25cbiAqIFxccGFyYW0gcmFuZ2UgdGhlIHNlbGVjdGlvbiByYW5nZVxuICogXFxwYXJhbSBvcmlnaW4gdGhlIG9yaWdpbiBvZiB0aGUgc2VsZWN0aW9uXG4gKi9cbmZ1bmN0aW9uIE1DYXJldE1vdmVkT3BlcmF0aW9uKHJhbmdlLCBvcmlnaW4pe1xuICAgIHRoaXMudHlwZSA9IFwiTUNhcmV0TW92ZWRPcGVyYXRpb25cIjtcbiAgICB0aGlzLnJhbmdlID0gcmFuZ2U7XG4gICAgdGhpcy5vcmlnaW4gPSBvcmlnaW47XG59O1xubW9kdWxlLmV4cG9ydHMuTUNhcmV0TW92ZWRPcGVyYXRpb24gPSBNQ2FyZXRNb3ZlZE9wZXJhdGlvbjtcbiIsInZhciBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKS5FdmVudEVtaXR0ZXI7XG52YXIgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcbnZhciBHVUlEID0gcmVxdWlyZSgnLi9ndWlkLmpzJyk7XG5cbnZhciBNQnJvYWRjYXN0ID0gcmVxdWlyZSgnLi9tZXNzYWdlcycpLk1Ccm9hZGNhc3Q7XG52YXIgTUFudGlFbnRyb3B5UmVxdWVzdCA9IHJlcXVpcmUoJy4vbWVzc2FnZXMuanMnKS5NQW50aUVudHJvcHlSZXF1ZXN0O1xudmFyIE1BbnRpRW50cm9weVJlc3BvbnNlID0gcmVxdWlyZSgnLi9tZXNzYWdlcy5qcycpLk1BbnRpRW50cm9weVJlc3BvbnNlO1xuXG52YXIgVW5pY2FzdCA9IHJlcXVpcmUoJ3VuaWNhc3QtZGVmaW5pdGlvbicpO1xuXG51dGlsLmluaGVyaXRzKENhdXNhbEJyb2FkY2FzdCwgRXZlbnRFbWl0dGVyKTtcblxuLyohXG4gKiBJdCB0YWtlcyBhIHVuaXF1ZSB2YWx1ZSBmb3IgcGVlciBhbmQgYSBjb3VudGVyIHRvIGRpc3Rpbmd1aXNoIGEgbWVzc2FnZS4gSXRcbiAqIGVtaXRzICdyZWNlaXZlJyBldmVudCB3aGVuIHRoZSBtZXNzYWdlIGlzIGNvbnNpZGVyZWQgcmVhZHlcbiAqIFxccGFyYW0gc291cmNlIHRoZSBwcm90b2NvbCByZWNlaXZpbmcgdGhlIG1lc3NhZ2VzXG4gKiBcXHBhcmFtIGNhdXNhbGl0eSB0aGUgY2F1c2FsaXR5IHRyYWNraW5nIHN0cnVjdHVyZVxuICovXG5mdW5jdGlvbiBDYXVzYWxCcm9hZGNhc3Qoc291cmNlLCBjYXVzYWxpdHksIG5hbWUpIHtcbiAgICBFdmVudEVtaXR0ZXIuY2FsbCh0aGlzKTtcbiAgICB0aGlzLnByb3RvY29sID0gbmFtZSB8fCAnY2F1c2FsJztcbiAgICB0aGlzLnNvdXJjZSA9IHNvdXJjZTtcbiAgICB0aGlzLmNhdXNhbGl0eSA9IGNhdXNhbGl0eTtcbiAgICB0aGlzLmRlbHRhQW50aUVudHJvcHkgPSAxMDAwKjYwKjEvMjsgLy8gKFRPRE8pIGNvbmZpZ3VyYWJsZSAoY3VycmVudGx5IDMwcylcbiAgICB0aGlzLnVuaWNhc3QgPSBuZXcgVW5pY2FzdCh0aGlzLnNvdXJjZSwgdGhpcy5uYW1lKyctdW5pY2FzdCcpO1xuXG4gICAgLy8gYnVmZmVyIG9mIG9wZXJhdGlvbnNcbiAgICB0aGlzLmJ1ZmZlciA9IFtdOyBcbiAgICAvLyBidWZmZXIgb2YgYW50aS1lbnRyb3B5IG1lc3NhZ2VzIChjaHVua2lmaWVkIGJlY2F1c2Ugb2YgbGFyZ2Ugc2l6ZSlcbiAgICB0aGlzLmJ1ZmZlckFudGlFbnRyb3B5ID0gbmV3IE1BbnRpRW50cm9weVJlc3BvbnNlKCdpbml0Jyk7XG4gICAgXG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHRoaXMuc291cmNlLm9uKCdyZWNlaXZlJywgZnVuY3Rpb24oaWQsIG1lc3NhZ2Upe1xuICAgICAgICBpZiAoIW1lc3NhZ2UgfHwgIW1lc3NhZ2UucHJvdG9jb2wpeyByZXR1cm4gOyB9O1xuICAgICAgICBzd2l0Y2ggKG1lc3NhZ2UucHJvdG9jb2wpe1xuICAgICAgICBjYXNlIHNlbGYucHJvdG9jb2w6IHNlbGYucmVjZWl2ZUJyb2FkY2FzdChtZXNzYWdlKTsgYnJlYWs7XG4gICAgICAgIGNhc2Ugc2VsZi5wcm90b2NvbCsnLXVuaWNhc3QnOiBzZWxmLnJlY2VpdmVVbmljYXN0KGlkLCBtZXNzYWdlKTsgYnJlYWs7XG4gICAgICAgIH07XG4gICAgfSk7XG4gICAgXG4vLyAgICB0aGlzLnNvdXJjZS5vbignc3RhdGVjaGFuZ2UnLCBmdW5jdGlvbihzdGF0ZSl7XG4vLyAgICAgICAgaWYgKHN0YXRlPT09J2Nvbm5lY3QnKXtcbi8vICAgICAgICAgICAgc2VsZi51bmljYXN0LnNlbmQobmV3IE1BbnRpRW50cm9weVJlcXVlc3Qoc2VsZi5jYXVzYWxpdHkpKTtcbi8vICAgICAgICB9O1xuLy8gICAgfSk7XG4gICAgXG4gICAgc2V0SW50ZXJ2YWwoZnVuY3Rpb24oKXtcbiAgICAgICAgc2VsZi51bmljYXN0LnNlbmQobmV3IE1BbnRpRW50cm9weVJlcXVlc3Qoc2VsZi5jYXVzYWxpdHkpKTtcbiAgICB9LCBzZWxmLmRlbHRhQW50aUVudHJvcHkpOyAgICBcbn07XG5cbi8qIVxuICogXFxicmllZiBicm9hZGNhc3QgdGhlIG1lc3NhZ2UgdG8gYWxsIHBhcnRpY2lwYW50c1xuICogXFxwYXJhbSBtZXNzYWdlIHRoZSBtZXNzYWdlIHRvIGJyb2FkY2FzdFxuICogXFxwYXJhbSBpZCB0aGUgaWQgb2YgdGhlIG1lc3NhZ2VcbiAqIFxccGFyYW0gaXNSZWFkeSB0aGUgaWQocykgdGhhdCBtdXN0IGV4aXN0IHRvIGRlbGl2ZXIgdGhlIG1lc3NhZ2VcbiAqL1xuQ2F1c2FsQnJvYWRjYXN0LnByb3RvdHlwZS5zZW5kID0gZnVuY3Rpb24obWVzc2FnZSwgaWQsIGlzUmVhZHkpe1xuICAgIC8vICMxIGdldCB0aGUgbmVpZ2hib3Job29kIGFuZCBjcmVhdGUgdGhlIG1lc3NhZ2VcbiAgICB2YXIgbGlua3MgPSB0aGlzLnNvdXJjZS5nZXRQZWVycygpO1xuICAgIHZhciBtQnJvYWRjYXN0ID0gbmV3IE1Ccm9hZGNhc3QodGhpcy5wcm90b2NvbCxpZHx8R1VJRCgpLGlzUmVhZHksIG1lc3NhZ2UpO1xuICAgIC8vICMyIHJlZ2lzdGVyIHRoZSBtZXNzYWdlIGluIHRoZSBzdHJ1Y3R1cmVcbiAgICB0aGlzLmNhdXNhbGl0eS5pbmNyZW1lbnRGcm9tKGlkKTtcblxuICAgIC8vICMzIHNlbmQgdGhlIG1lc3NhZ2UgdG8gdGhlIG5laWdoYm9yaG9vZFxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGlua3Muby5sZW5ndGg7ICsraSl7XG4gICAgICAgIHRoaXMuc291cmNlLnNlbmQobGlua3Mub1tpXSwgbUJyb2FkY2FzdCk7XG4gICAgfTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxpbmtzLmkubGVuZ3RoOyArK2kpe1xuICAgICAgICB0aGlzLnNvdXJjZS5zZW5kKGxpbmtzLmlbaV0sIG1Ccm9hZGNhc3QpO1xuICAgIH07XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgYW5zd2VycyB0byBhbiBhbnRpZW50cm9weSByZXF1ZXN0IG1lc3NhZ2Ugd2l0aCB0aGUgbWlzc2luZyBlbGVtZW50c1xuICogXFxwYXJhbSBvcmlnaW4gdGhlIG9yaWdpbiBvZiB0aGUgcmVxdWVzdFxuICogXFxwYXJhbSBjYXVzYWxpdHlBdFJlY2VpcHQgdGhlIGxvY2FsIGNhdXNhbGl0eSBzdHJ1Y3R1cmUgd2hlbiB0aGUgbWVzc2FnZSB3YXNcbiAqIHJlY2VpdmVkXG4gKiBcXHBhcmFtIG1lc3NhZ2VzIHRoZSBtaXNzaW5nIG1lc3NhZ2VzXG4gKi8gXG5DYXVzYWxCcm9hZGNhc3QucHJvdG90eXBlLnNlbmRBbnRpRW50cm9weVJlc3BvbnNlID1cbiAgICBmdW5jdGlvbihvcmlnaW4sIGNhdXNhbGl0eUF0UmVjZWlwdCwgbWVzc2FnZXMpe1xuICAgICAgICB2YXIgaWQgPSBHVUlEKCk7XG4gICAgICAgIC8vICMxIG1ldGFkYXRhIG9mIHRoZSBhbnRpZW50cm9weSByZXNwb25zZVxuICAgICAgICB0aGlzLnVuaWNhc3Quc2VuZChuZXcgTUFudGlFbnRyb3B5UmVzcG9uc2UodGhpcy5wcm90b2NvbCwgaWQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXVzYWxpdHlBdFJlY2VpcHQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXNzYWdlcy5sZW5ndGgpLCBvcmlnaW4pO1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IG1lc3NhZ2VzLmxlbmd0aDsgKytpKXtcbiAgICAgICAgICAgIHRoaXMudW5pY2FzdC5zZW5kKG5ldyBNQW50aUVudHJvcHlSZXNwb25zZSh0aGlzLnByb3RvY29sLCBpZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBudWxsLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1lc3NhZ2VzLmxlbmd0aCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXNzYWdlc1tpXSksICBvcmlnaW4pO1xuICAgICAgICB9O1xuICAgIH07XG5cbi8qIVxuICogXFxicmllZiByZWNlaXZlIGEgYnJvYWRjYXN0IG1lc3NhZ2VcbiAqIFxccGFyYW0gbWVzc2FnZSB0aGUgcmVjZWl2ZWQgbWVzc2FnZVxuICovXG5DYXVzYWxCcm9hZGNhc3QucHJvdG90eXBlLnJlY2VpdmVCcm9hZGNhc3QgPSBmdW5jdGlvbihtZXNzYWdlKXtcbiAgICB2YXIgaWQgPSBtZXNzYWdlLmlkLCBpc1JlYWR5ID0gbWVzc2FnZS5pc1JlYWR5O1xuICAgIGlmICghdGhpcy5zdG9wUHJvcGFnYXRpb24obWVzc2FnZSkpe1xuICAgICAgICAvLyAjMSByZWdpc3RlciB0aGUgb3BlcmF0aW9uXG4gICAgICAgIHRoaXMuYnVmZmVyLnB1c2gobWVzc2FnZSk7XG4gICAgICAgIC8vICMyIGRlbGl2ZXJcbiAgICAgICAgdGhpcy5yZXZpZXdCdWZmZXIoKTtcbiAgICAgICAgLy8gIzMgcmVicm9hZGNhc3RcbiAgICAgICAgdmFyIGxpbmtzID0gdGhpcy5zb3VyY2UuZ2V0UGVlcnMoKTtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsaW5rcy5vLmxlbmd0aDsgKytpKXtcbiAgICAgICAgICAgIHRoaXMuc291cmNlLnNlbmQobGlua3Mub1tpXSwgbWVzc2FnZSk7XG4gICAgICAgIH07XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGlua3MuaS5sZW5ndGg7ICsraSl7XG4gICAgICAgICAgICB0aGlzLnNvdXJjZS5zZW5kKGxpbmtzLmlbaV0sIG1lc3NhZ2UpO1xuICAgICAgICB9OyAgICAgICAgXG4gICAgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiBnbyB0aHJvdWdoIHRoZSBidWZmZXIgb2YgbWVzc2FnZXMgYW5kIGRlbGl2ZXJzIGFsbFxuICogcmVhZHkgb3BlcmF0aW9uc1xuICovXG5DYXVzYWxCcm9hZGNhc3QucHJvdG90eXBlLnJldmlld0J1ZmZlciA9IGZ1bmN0aW9uKCl7XG4gICAgdmFyIGZvdW5kID0gZmFsc2UsIGkgPSB0aGlzLmJ1ZmZlci5sZW5ndGggLSAxO1xuICAgIHdoaWxlKGk+PTApe1xuICAgICAgICB2YXIgbWVzc2FnZSA9IHRoaXMuYnVmZmVyW2ldO1xuICAgICAgICBpZiAodGhpcy5jYXVzYWxpdHkuaXNMb3dlcihtZXNzYWdlLmlkKSl7XG4gICAgICAgICAgICB0aGlzLmJ1ZmZlci5zcGxpY2UoaSwgMSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAodGhpcy5jYXVzYWxpdHkuaXNSZWFkeShtZXNzYWdlLmlzUmVhZHkpKXtcbiAgICAgICAgICAgICAgICBmb3VuZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgdGhpcy5jYXVzYWxpdHkuaW5jcmVtZW50RnJvbShtZXNzYWdlLmlkKTtcbiAgICAgICAgICAgICAgICB0aGlzLmJ1ZmZlci5zcGxpY2UoaSwgMSk7XG4gICAgICAgICAgICAgICAgdGhpcy5lbWl0KCdyZWNlaXZlJywgbWVzc2FnZS5wYXlsb2FkKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgIH07XG4gICAgICAgIC0taTtcbiAgICB9O1xuICAgIGlmIChmb3VuZCl7IHRoaXMucmV2aWV3QnVmZmVyKCk7ICB9O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHJlY2VpdmUgYSB1bmljYXN0IG1lc3NhZ2UsIGkuZS4sIGVpdGhlciBhbiBhbnRpZW50cm9weSByZXF1ZXN0IG9yIGFuXG4gKiBhbnRpZW50cm9weSByZXNwb25zZVxuICogXFxicmllZiBpZCB0aGUgaWRlbnRpZmllciBvZiB0aGUgb3JpZ2luIG9mIHRoZSB1bmljYXN0XG4gKiBcXGJyaWVmIG1lc3NhZ2UgdGhlIG1lc3NhZ2UgcmVjZWl2ZWQgXG4gKi9cbkNhdXNhbEJyb2FkY2FzdC5wcm90b3R5cGUucmVjZWl2ZVVuaWNhc3QgPSBmdW5jdGlvbihpZCwgbWVzc2FnZSl7XG4gICAgc3dpdGNoIChtZXNzYWdlLnR5cGUpe1xuICAgIGNhc2UgJ01BbnRpRW50cm9weVJlcXVlc3QnOlxuICAgICAgICB0aGlzLmVtaXQoJ2FudGlFbnRyb3B5JyxcbiAgICAgICAgICAgICAgICAgIGlkLCBtZXNzYWdlLmNhdXNhbGl0eSwgdGhpcy5jYXVzYWxpdHkuY2xvbmUoKSk7XG4gICAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ01BbnRpRW50cm9weVJlc3BvbnNlJzpcbiAgICAgICAgLy8gI0EgcmVwbGFjZSB0aGUgYnVmZmVyZWQgbWVzc2FnZVxuICAgICAgICBpZiAodGhpcy5idWZmZXJBbnRpRW50cm9weS5pZCAhPT0gbWVzc2FnZS5pZCl7XG4gICAgICAgICAgICB0aGlzLmJ1ZmZlckFudGlFbnRyb3B5ID0gbWVzc2FnZTtcbiAgICAgICAgfTtcbiAgICAgICAgLy8gI0IgYWRkIHRoZSBuZXcgZWxlbWVudCB0byB0aGUgYnVmZmVyICAgICAgICBcbiAgICAgICAgaWYgKG1lc3NhZ2UuZWxlbWVudCl7XG4gICAgICAgICAgICB0aGlzLmJ1ZmZlckFudGlFbnRyb3B5LmVsZW1lbnRzLnB1c2gobWVzc2FnZS5lbGVtZW50KTtcbiAgICAgICAgfTtcbiAgICAgICAgLy8gI0MgYWRkIGNhdXNhbGl0eSBtZXRhZGF0YVxuICAgICAgICBpZiAobWVzc2FnZS5jYXVzYWxpdHkpe1xuICAgICAgICAgICAgdGhpcy5idWZmZXJBbnRpRW50cm9weS5jYXVzYWxpdHkgPSBtZXNzYWdlLmNhdXNhbGl0eTtcbiAgICAgICAgfTtcbiAgICAgICAgLy8gI0QgdGhlIGJ1ZmZlcmVkIG1lc3NhZ2UgaXMgZnVsbHkgYXJyaXZlZCwgZGVsaXZlclxuICAgICAgICBpZiAodGhpcy5idWZmZXJBbnRpRW50cm9weS5lbGVtZW50cy5sZW5ndGggPT09XG4gICAgICAgICAgICB0aGlzLmJ1ZmZlckFudGlFbnRyb3B5Lm5iRWxlbWVudHMpe1xuICAgICAgICAgICAgLy8gIzEgY29uc2lkZXJlIGVhY2ggbWVzc2FnZSBpbiB0aGUgcmVzcG9uc2UgaW5kZXBlbmRhbnRseVxuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGk8dGhpcy5idWZmZXJBbnRpRW50cm9weS5lbGVtZW50cy5sZW5ndGg7ICsraSl7XG4gICAgICAgICAgICAgICAgdmFyIGVsZW1lbnQgPSB0aGlzLmJ1ZmZlckFudGlFbnRyb3B5LmVsZW1lbnRzW2ldO1xuICAgICAgICAgICAgICAgIC8vICMyIG9ubHkgY2hlY2sgaWYgdGhlIG1lc3NhZ2UgaGFzIG5vdCBiZWVuIHJlY2VpdmVkIHlldFxuICAgICAgICAgICAgICAgIGlmICghdGhpcy5zdG9wUHJvcGFnYXRpb24oZWxlbWVudCkpe1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmNhdXNhbGl0eS5pbmNyZW1lbnRGcm9tKGVsZW1lbnQuaWQpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmVtaXQoJ3JlY2VpdmUnLCBlbGVtZW50LnBheWxvYWQpO1xuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgLy8gIzMgbWVyZ2UgY2F1c2FsaXR5IHN0cnVjdHVyZXNcbiAgICAgICAgICAgIHRoaXMuY2F1c2FsaXR5Lm1lcmdlKHRoaXMuYnVmZmVyQW50aUVudHJvcHkuY2F1c2FsaXR5KTtcbiAgICAgICAgfTtcbiAgICAgICAgYnJlYWs7XG4gICAgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiBnZXRzIGNhbGxlZCB3aGVuIGEgYnJvYWRjYXN0IG1lc3NhZ2UgcmVhY2hlcyB0aGlzIG5vZGUuICB0aGlzXG4gKiBmdW5jdGlvbiBldmFsdWF0ZXMgaWYgdGhlIG5vZGUgc2hvdWxkIHByb3BhZ2F0ZSB0aGUgbWVzc2FnZSBmdXJ0aGVyIG9yIGlmIGl0XG4gKiBzaG91bGQgc3RvcCBzZW5kaW5nIGl0LlxuICogXFxwYXJhbSBtZXNzYWdlIGEgYnJvYWRjYXN0IG1lc3NhZ2VcbiAqIFxccmV0dXJuIHRydWUgaWYgdGhlIG1lc3NhZ2UgaXMgYWxyZWFkeSBrbm93biwgZmFsc2Ugb3RoZXJ3aXNlXG4gKi9cbkNhdXNhbEJyb2FkY2FzdC5wcm90b3R5cGUuc3RvcFByb3BhZ2F0aW9uID0gZnVuY3Rpb24gKG1lc3NhZ2UpIHtcbiAgICByZXR1cm4gdGhpcy5jYXVzYWxpdHkuaXNMb3dlcihtZXNzYWdlLmlkKSB8fFxuICAgICAgICB0aGlzLmJ1ZmZlckluZGV4T2YobWVzc2FnZS5pZCk+PTA7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0IHRoZSBpbmRleCBpbiB0aGUgYnVmZmVyIG9mIHRoZSBtZXNzYWdlIGlkZW50aWZpZWQgYnkgaWRcbiAqIFxccGFyYW0gaWQgdGhlIGlkZW50aWZpZXIgdG8gc2VhcmNoXG4gKiBcXHJldHVybiB0aGUgaW5kZXggb2YgdGhlIG1lc3NhZ2UgaW4gdGhlIGJ1ZmZlciwgLTEgaWYgbm90IGZvdW5kXG4gKi9cbkNhdXNhbEJyb2FkY2FzdC5wcm90b3R5cGUuYnVmZmVySW5kZXhPZiA9IGZ1bmN0aW9uKGlkKXtcbiAgICB2YXIgZm91bmQgPSBmYWxzZSxcbiAgICAgICAgaW5kZXggPSAtMSxcbiAgICAgICAgaSA9IDA7XG4gICAgd2hpbGUgKCFmb3VuZCAmJiBpPHRoaXMuYnVmZmVyLmxlbmd0aCl7XG4gICAgICAgIC8vIChUT0RPKSBmaXggdWdseW5lc3NcbiAgICAgICAgaWYgKEpTT04uc3RyaW5naWZ5KHRoaXMuYnVmZmVyW2ldLmlkKSA9PT0gSlNPTi5zdHJpbmdpZnkoaWQpKXsgXG4gICAgICAgICAgICBmb3VuZCA9IHRydWU7IGluZGV4ID0gaTtcbiAgICAgICAgfTtcbiAgICAgICAgKytpXG4gICAgfTtcbiAgICByZXR1cm4gaW5kZXg7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IENhdXNhbEJyb2FkY2FzdDtcbiIsIlxuLyohXG4gKiBcXGJyaWVmIG1lc3NhZ2UgY29udGFpbmluZyBkYXRhIHRvIGJyb2FkY2FzdFxuICogXFxwYXJhbSBuYW1lIHRoZSBuYW1lIG9mIHRoZSBwcm90b2NvbCwgZGVmYXVsdCAnY2F1c2FsJ1xuICogXFxwYXJhbSBpZCB0aGUgaWRlbnRpZmllciBvZiB0aGUgYnJvYWRjYXN0IG1lc3NhZ2VcbiAqIFxccGFyYW0gaXNSZWFkeSB0aGUgaWRlbnRpZmllcihzKSB0aGF0IG11c3QgZXhpc3QgdG8gZGVsaXZlciB0aGlzIG1lc3NhZ2VcbiAqIFxccGFyYW0gcGF5bG9hZCB0aGUgYnJvYWRjYXN0ZWQgZGF0YVxuICovXG5mdW5jdGlvbiBNQnJvYWRjYXN0KG5hbWUsIGlkLCBpc1JlYWR5LCBwYXlsb2FkKXtcbiAgICB0aGlzLnByb3RvY29sID0gbmFtZTtcbiAgICB0aGlzLmlkID0gaWQ7XG4gICAgdGhpcy5pc1JlYWR5ID0gaXNSZWFkeTtcbiAgICB0aGlzLnBheWxvYWQgPSBwYXlsb2FkO1xufTtcbm1vZHVsZS5leHBvcnRzLk1Ccm9hZGNhc3QgPSBNQnJvYWRjYXN0O1xuXG4vKiFcbiAqIFxcYnJpZWYgbWVzc2FnZSB0aGF0IHJlcXVlc3QgYW4gQW50aUVudHJvcHkgXG4gKiBcXHBhcmFtIGNhdXNhbGl0eSB0aGUgY2F1c2FsaXR5IHN0cnVjdHVyZVxuICovXG5mdW5jdGlvbiBNQW50aUVudHJvcHlSZXF1ZXN0KG5hbWUsIGNhdXNhbGl0eSl7XG4gICAgdGhpcy50eXBlID0gJ01BbnRpRW50cm9weVJlcXVlc3QnO1xuICAgIHRoaXMucHJvdG9jb2wgPSBuYW1lO1xuICAgIHRoaXMuY2F1c2FsaXR5ID0gY2F1c2FsaXR5O1xufTtcbm1vZHVsZS5leHBvcnRzLk1BbnRpRW50cm9weVJlcXVlc3QgPSBNQW50aUVudHJvcHlSZXF1ZXN0O1xuXG4vKiFcbiAqIFxcYnJpZWYgbWVzc2FnZSByZXNwb25kaW5nIHRvIHRoZSBBbnRpRW50cm9weSByZXF1ZXN0XG4gKiBcXHBhcmFtIGlkIHRoZSBpZGVudGlmaWVyIG9mIHRoZSByZXNwb25zZSBtZXNzYWdlXG4gKiBcXHBhcmFtIGNhdXNhbGl0eSB0aGUgY2F1c2FsaXR5IHN0cnVjdHVyZVxuICogXFxwYXJhbSBuYkVsZW1lbnRzIHRoZSBudW1iZXIgb2YgZWxlbWVudCB0byBzZW5kXG4gKiBcXHBhcmFtIGVsZW1lbnQgZWFjaCBlbGVtZW50IHRvIHNlbmQgXG4gKi9cbmZ1bmN0aW9uIE1BbnRpRW50cm9weVJlc3BvbnNlKG5hbWUsIGlkLCBjYXVzYWxpdHksIG5iRWxlbWVudHMsIGVsZW1lbnQpe1xuICAgIHRoaXMudHlwZSA9ICdNQW50aUVudHJvcHlSZXNwb25zZSc7XG4gICAgdGhpcy5pZCA9IGlkO1xuICAgIHRoaXMuY2F1c2FsaXR5ID0gY2F1c2FsaXR5O1xuICAgIHRoaXMucHJvdG9jb2wgPSBuYW1lO1xuICAgIHRoaXMubmJFbGVtZW50cyA9IG5iRWxlbWVudHM7XG4gICAgdGhpcy5lbGVtZW50ID0gZWxlbWVudDtcbiAgICB0aGlzLmVsZW1lbnRzID0gW107XG59O1xubW9kdWxlLmV4cG9ydHMuTUFudGlFbnRyb3B5UmVzcG9uc2UgPSBNQW50aUVudHJvcHlSZXNwb25zZTtcblxuIiwiXG4vKiFcbiAqIFxcYnJpZWYgbWVzc2FnZSBjb250YWluaW5nIGRhdGEgdG8gdW5pY2FzdFxuICogXFxwYXJhbSBuYW1lIHRoZSBwcm90b2NvbCBuYW1lXG4gKiBcXHBhcmFtIHBheWxvYWQgdGhlIHNlbnQgZGF0YVxuICovXG5mdW5jdGlvbiBNVW5pY2FzdChuYW1lLCBwYXlsb2FkKXtcbiAgICB0aGlzLnByb3RvY29sID0gbmFtZSB8fCAndW5pY2FzdCc7XG4gICAgdGhpcy5wYXlsb2FkID0gcGF5bG9hZDtcbn07XG5tb2R1bGUuZXhwb3J0cy5NVW5pY2FzdCA9IE1VbmljYXN0O1xuIiwidmFyIEV2ZW50RW1pdHRlciA9IHJlcXVpcmUoJ2V2ZW50cycpLkV2ZW50RW1pdHRlcjtcbnZhciB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuXG52YXIgTVVuaWNhc3QgPSByZXF1aXJlKCcuL21lc3NhZ2VzJykuTVVuaWNhc3Q7XG5cbnV0aWwuaW5oZXJpdHMoVW5pY2FzdCwgRXZlbnRFbWl0dGVyKTtcblxuLyohXG4gKiBVbmljYXN0IGNvbXBvbmVudCB0aGF0IHNpbXBseSBjaG9zZSBhIHJhbmRvbSBwZWVyIGFuZCBzZW5kIGEgbWVzc2FnZVxuICogXFxwYXJhbSBzb3VyY2UgdGhlIHByb3RvY29sIHJlY2VpdmluZyB0aGUgbWVzc2FnZXNcbiAqIFxccGFyYW0gbmFtZSB0aGUgbmFtZSBvZiB0aGUgcHJvdG9jb2wsIGRlZmF1bHQgaXMgJ3VuaWNhc3QnXG4gKi9cbmZ1bmN0aW9uIFVuaWNhc3Qoc291cmNlLCBtYXgsIG5hbWUpIHtcbiAgICBFdmVudEVtaXR0ZXIuY2FsbCh0aGlzKTtcbiAgICB0aGlzLm5hbWUgPSBuYW1lIHx8ICd1bmljYXN0JzsgICAgXG4gICAgdGhpcy5zb3VyY2UgPSBzb3VyY2U7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHRoaXMuc291cmNlLm9uKHNlbGYubmFtZSsnLXJlY2VpdmUnLCBmdW5jdGlvbihpZCwgbWVzc2FnZSl7XG4gICAgICAgIHNlbGYuZW1pdCgncmVjZWl2ZScsIGlkLCBtZXNzYWdlLnBheWxvYWQpO1xuICAgIH0pOyAgICBcbn07XG5cbi8qIVxuICogXFxicmllZiBzZW5kIHRoZSBtZXNzYWdlIHRvIG9uZSByYW5kb20gcGFydGljaXBhbnRcbiAqIFxccGFyYW0gbWVzc2FnZSB0aGUgbWVzc2FnZSB0byBzZW5kXG4gKiBcXHBhcmFtIGlkIG9wdGlvbm5hbCBpZGVudGlmaWVyIG9mIHRoZSBjaGFubmVsIHRvIHVzZSBmb3Igc2VuZGluZyB0aGUgbXNnXG4gKiBcXHBhcmFtIHJldHVybiB0cnVlIGlmIGl0IHNlZW1zIHRvIGhhdmUgc2VudCB0aGUgbWVzc2FnZSwgZmFsc2Ugb3RoZXJ3aXNlLlxuICovXG5VbmljYXN0LnByb3RvdHlwZS5zZW5kID0gZnVuY3Rpb24obWVzc2FnZSwgaWQpe1xuICAgIC8vICMxIGdldCB0aGUgbmVpZ2hib3Job29kIGFuZCBjcmVhdGUgdGhlIG1lc3NhZ2VcbiAgICB2YXIgbGlua3MgPSAoaWQgJiYge286W2lkXSwgaTpbXX0pIHx8IHRoaXMuc291cmNlLmdldFBlZXJzKDEpO1xuICAgIHZhciBsaW5rO1xuICAgIHZhciBtVW5pY2FzdCA9IG5ldyBNVW5pY2FzdCh0aGlzLm5hbWUsIG1lc3NhZ2UpO1xuXG4gICAgLy8gIzIgc2VuZCB0aGUgbWVzc2FnZVxuICAgIGlmIChsaW5rcy5vLmxlbmd0aCA9PT0gMCAmJiBsaW5rcy5pLmxlbmd0aCA9PT0gMCl7cmV0dXJuIGZhbHNlO307XG4gICAgaWYgKGxpbmtzLm8ubGVuZ3RoID4gMCkge1xuICAgICAgICBsaW5rID0gbGlua3Mub1swXTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBsaW5rID0gbGlua3MuaVswXTtcbiAgICB9O1xuICAgIHJldHVybiB0aGlzLnNvdXJjZS5zZW5kKGxpbmssIG1VbmljYXN0KTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gVW5pY2FzdDtcbiIsInZhciBCSSA9IHJlcXVpcmUoJ0JpZ0ludCcpO1xuXG4vKiFcbiAqIFxcY2xhc3MgQmFzZVxuICogXFxicmllZiBwcm92aWRlcyBiYXNpYyBmdW5jdGlvbiB0byBiaXQgbWFuaXB1bGF0aW9uXG4gKiBcXHBhcmFtIGIgdGhlIG51bWJlciBvZiBiaXRzIGF0IGxldmVsIDAgb2YgdGhlIGRlbnNlIHNwYWNlXG4gKi9cbmZ1bmN0aW9uIEJhc2UoYil7ICAgIFxuICAgIHZhciBERUZBVUxUX0JBU0UgPSAzO1xuICAgIHRoaXMuX2IgPSBiIHx8IERFRkFVTFRfQkFTRTtcbn07XG5cbi8qIVxuICogXFxicmllZiBQcm9jZXNzIHRoZSBudW1iZXIgb2YgYml0cyB1c2FnZSBhdCBhIGNlcnRhaW4gbGV2ZWwgb2YgZGVuc2Ugc3BhY2VcbiAqIFxccGFyYW0gbGV2ZWwgdGhlIGxldmVsIGluIGRlbnNlIHNwYWNlLCBpLmUuLCB0aGUgbnVtYmVyIG9mIGNvbmNhdGVuYXRpb25cbiAqL1xuQmFzZS5wcm90b3R5cGUuZ2V0Qml0QmFzZSA9IGZ1bmN0aW9uKGxldmVsKXtcbiAgICByZXR1cm4gdGhpcy5fYiArIGxldmVsO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIFByb2Nlc3MgdGhlIHRvdGFsIG51bWJlciBvZiBiaXRzIHVzYWdlIHRvIGdldCB0byBhIGNlcnRhaW4gbGV2ZWxcbiAqIFxccGFyYW0gbGV2ZWwgdGhlIGxldmVsIGluIGRlbnNlIHNwYWNlXG4gKi9cbkJhc2UucHJvdG90eXBlLmdldFN1bUJpdCA9IGZ1bmN0aW9uKGxldmVsKXtcbiAgICB2YXIgbiA9IHRoaXMuZ2V0Qml0QmFzZShsZXZlbCksXG4gICAgICAgIG0gPSB0aGlzLl9iLTE7XG4gICAgcmV0dXJuIChuICogKG4gKyAxKSkgLyAyIC0gKG0gKiAobSArIDEpIC8gMik7XG59O1xuXG4vKiFcbiAgXFxicmllZiBwcm9jZXNzIHRoZSBpbnRlcnZhbCBiZXR3ZWVuIHR3byBMU0VRTm9kZVxuICBcXHBhcmFtIHAgdGhlIHByZXZpb3VzIExTRVFOb2RlXG4gIFxccGFyYW0gcSB0aGUgbmV4dCBMU0VRTm9kZVxuICBcXHBhcmFtIGxldmVsIHRoZSBkZXB0aCBvZiB0aGUgdHJlZSB0byBwcm9jZXNzXG4gIFxccmV0dXJuIGFuIGludGVnZXIgd2hpY2ggaXMgdGhlIGludGVydmFsIGJldHdlZW4gdGhlIHR3byBub2RlIGF0IHRoZSBkZXB0aFxuKi9cbkJhc2UucHJvdG90eXBlLmdldEludGVydmFsID0gZnVuY3Rpb24ocCwgcSwgbGV2ZWwpe1xuICAgIHZhciBzdW0gPSAwLCBpID0gMCxcbiAgICAgICAgcElzR3JlYXRlciA9IGZhbHNlLCBjb21tb25Sb290ID0gdHJ1ZSxcbiAgICAgICAgcHJldlZhbHVlID0gMCwgbmV4dFZhbHVlID0gMDtcbiAgICBcbiAgICB3aGlsZSAoaTw9bGV2ZWwpe1xuICAgICAgICBwcmV2VmFsdWUgPSAwOyBpZiAocCAhPT0gbnVsbCl7IHByZXZWYWx1ZSA9IHAudC5wOyB9XG4gICAgICAgIG5leHRWYWx1ZSA9IDA7IGlmIChxICE9PSBudWxsKXsgbmV4dFZhbHVlID0gcS50LnA7IH1cbiAgICAgICAgaWYgKGNvbW1vblJvb3QgJiYgcHJldlZhbHVlICE9PSBuZXh0VmFsdWUpe1xuICAgICAgICAgICAgY29tbW9uUm9vdCA9IGZhbHNlO1xuICAgICAgICAgICAgcElzR3JlYXRlciA9IHByZXZWYWx1ZSA+IG5leHRWYWx1ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocElzR3JlYXRlcil7IG5leHRWYWx1ZSA9IE1hdGgucG93KDIsdGhpcy5nZXRCaXRCYXNlKGkpKS0xOyB9XG4gICAgICAgIGlmIChjb21tb25Sb290IHx8IHBJc0dyZWF0ZXIgfHwgaSE9PWxldmVsKXtcbiAgICAgICAgICAgIHN1bSArPSBuZXh0VmFsdWUgLSBwcmV2VmFsdWU7IFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3VtICs9IG5leHRWYWx1ZSAtIHByZXZWYWx1ZSAtIDE7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGkhPT1sZXZlbCl7XG4gICAgICAgICAgICBzdW0gKj0gTWF0aC5wb3coMix0aGlzLmdldEJpdEJhc2UoaSsxKSk7XG4gICAgICAgIH07XG4gICAgICAgIGlmIChwIT09bnVsbCAmJiBwLmNoaWxkcmVuLmxlbmd0aCE9PTApe3A9cC5jaGlsZHJlblswXTt9IGVsc2V7cD1udWxsO307XG4gICAgICAgIGlmIChxIT09bnVsbCAmJiBxLmNoaWxkcmVuLmxlbmd0aCE9PTApe3E9cS5jaGlsZHJlblswXTt9IGVsc2V7cT1udWxsO307XG4gICAgICAgICsraTtcbiAgICB9XG4gICAgcmV0dXJuIHN1bTtcbn07XG5cbkJhc2UuaW5zdGFuY2UgPSBudWxsO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKGFyZ3Mpe1xuICAgIGlmIChhcmdzKXtcbiAgICAgICAgQmFzZS5pbnN0YW5jZSA9IG5ldyBCYXNlKGFyZ3MpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChCYXNlLmluc3RhbmNlID09PSBudWxsKXtcbiAgICAgICAgICAgIEJhc2UuaW5zdGFuY2UgPSBuZXcgQmFzZSgpO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgcmV0dXJuIEJhc2UuaW5zdGFuY2U7XG59O1xuIiwidmFyIEJJID0gcmVxdWlyZSgnQmlnSW50Jyk7XG52YXIgQmFzZSA9IHJlcXVpcmUoJy4vYmFzZS5qcycpKCk7XG52YXIgVHJpcGxlID0gcmVxdWlyZSgnLi90cmlwbGUuanMnKTtcbnZhciBMU0VRTm9kZSA9IHJlcXVpcmUoJy4vbHNlcW5vZGUuanMnKTtcblxuLyohXG4gKiBcXGNsYXNzIElkZW50aWZpZXJcbiAqIFxcYnJpZWYgVW5pcXVlIGFuZCBpbW11dGFibGUgaWRlbnRpZmllciBjb21wb3NlZCBvZiBkaWdpdCwgc291cmNlcywgY291bnRlcnNcbiAqIFxccGFyYW0gZCB0aGUgZGlnaXQgKHBvc2l0aW9uIGluIGRlbnNlIHNwYWNlKVxuICogXFxwYXJhbSBzIHRoZSBsaXN0IG9mIHNvdXJjZXNcbiAqIFxccGFyYW0gYyB0aGUgbGlzdCBvZiBjb3VudGVyc1xuICovXG5mdW5jdGlvbiBJZGVudGlmaWVyKGQsIHMsIGMpe1xuICAgIHRoaXMuX2QgPSBkO1xuICAgIHRoaXMuX3MgPSBzO1xuICAgIHRoaXMuX2MgPSBjO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHNldCB0aGUgZCxzLGMgdmFsdWVzIGFjY29yZGluZyB0byB0aGUgbm9kZSBpbiBhcmd1bWVudFxuICogXFxwYXJhbSBub2RlIHRoZSBsc2Vxbm9kZSBjb250YWluaW5nIHRoZSBwYXRoIGluIHRoZSB0cmVlIHN0cnVjdHVyZVxuICovXG5JZGVudGlmaWVyLnByb3RvdHlwZS5mcm9tTm9kZSA9IGZ1bmN0aW9uKG5vZGUpe1xuICAgIC8vICMxIHByb2Nlc3MgdGhlIGxlbmd0aCBvZiB0aGUgcGF0aFxuICAgIHZhciBsZW5ndGggPSAxLCB0ZW1wTm9kZSA9IG5vZGUsIGkgPSAwO1xuICAgIFxuICAgIHdoaWxlICh0ZW1wTm9kZS5jaGlsZHJlbi5sZW5ndGggIT09IDApe1xuXHQrK2xlbmd0aDtcbiAgICAgICAgdGVtcE5vZGUgPSB0ZW1wTm9kZS5jaGlsZHJlblswXTtcbiAgICB9O1xuICAgIC8vICMxIGNvcHkgdGhlIHZhbHVlcyBjb250YWluZWQgaW4gdGhlIHBhdGhcbiAgICB0aGlzLl9kID0gQkkuaW50MmJpZ0ludCgwLEJhc2UuZ2V0U3VtQml0KGxlbmd0aCAtIDEpKTtcbiAgICBcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aCA7ICsraSl7XG4gICAgICAgIC8vICMxYSBjb3B5IHRoZSBzaXRlIGlkXG4gICAgICAgIHRoaXMuX3MucHVzaChub2RlLnQucyk7XG4gICAgICAgIC8vICMxYiBjb3B5IHRoZSBjb3VudGVyXG4gICAgICAgIHRoaXMuX2MucHVzaChub2RlLnQuYyk7XG4gICAgICAgIC8vICMxYyBjb3B5IHRoZSBkaWdpdFxuICAgICAgICBCSS5hZGRJbnRfKHRoaXMuX2QsIG5vZGUudC5wKTtcbiAgICAgICAgaWYgKGkhPT0obGVuZ3RoLTEpKXtcbiAgICAgICAgICAgIEJJLmxlZnRTaGlmdF8odGhpcy5fZCwgQmFzZS5nZXRCaXRCYXNlKGkrMSkpO1xuICAgICAgICB9O1xuICAgICAgICBub2RlID0gbm9kZS5jaGlsZHJlblswXTtcbiAgICB9O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNvbnZlcnQgdGhlIGlkZW50aWZpZXIgaW50byBhIG5vZGUgd2l0aG91dCBlbGVtZW50XG4gKiBcXHBhcmFtIGUgdGhlIGVsZW1lbnQgYXNzb2NpYXRlZCB3aXRoIHRoZSBub2RlXG4gKi9cbklkZW50aWZpZXIucHJvdG90eXBlLnRvTm9kZSA9IGZ1bmN0aW9uKGUpe1xuICAgIHZhciByZXN1bHRQYXRoID0gW10sIGRCaXRMZW5ndGggPSBCYXNlLmdldFN1bUJpdCh0aGlzLl9jLmxlbmd0aCAtMSksIGkgPSAwLFxuICAgICAgICBtaW5lO1xuICAgIC8vICMxIGRlY29uc3RydWN0IHRoZSBkaWdpdCBcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMuX2MubGVuZ3RoOyArK2kpe1xuICAgICAgICAvLyAjMSB0cnVuY2F0ZSBtaW5lXG4gICAgICAgIG1pbmUgPSBCSS5kdXAodGhpcy5fZCk7XG4gICAgICAgIC8vICMxYSBzaGlmdCByaWdodCB0byBlcmFzZSB0aGUgdGFpbCBvZiB0aGUgcGF0aFxuICAgICAgICBCSS5yaWdodFNoaWZ0XyhtaW5lLCBkQml0TGVuZ3RoIC0gQmFzZS5nZXRTdW1CaXQoaSkpO1xuICAgICAgICAvLyAjMWIgY29weSB2YWx1ZSBpbiB0aGUgcmVzdWx0XG4gICAgICAgIHJlc3VsdFBhdGgucHVzaChuZXcgVHJpcGxlKEJJLm1vZEludChtaW5lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgTWF0aC5wb3coMixCYXNlLmdldEJpdEJhc2UoaSkpKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fc1tpXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fY1tpXSkpO1xuICAgIH07XG4gICAgcmV0dXJuIG5ldyBMU0VRTm9kZShyZXN1bHRQYXRoLCBlKTtcbn07XG5cbi8qIVxuICogXFxicmllZiBjb21wYXJlIHR3byBpZGVudGlmaWVyc1xuICogXFxwYXJhbSBvIHRoZSBvdGhlciBpZGVudGlmaWVyXG4gKiBcXHJldHVybiAtMSBpZiB0aGlzIGlzIGxvd2VyLCAwIGlmIHRoZXkgYXJlIGVxdWFsLCAxIGlmIHRoaXMgaXMgZ3JlYXRlclxuICovXG5JZGVudGlmaWVyLnByb3RvdHlwZS5jb21wYXJlID0gZnVuY3Rpb24obyl7XG4gICAgdmFyIGRCaXRMZW5ndGggPSBCYXNlLmdldFN1bUJpdCh0aGlzLl9jLmxlbmd0aCAtIDEpLFxuICAgICAgICBvZEJpdExlbmd0aCA9IEJhc2UuZ2V0U3VtQml0KG8uX2MubGVuZ3RoIC0gMSksXG4gICAgICAgIGNvbXBhcmluZyA9IHRydWUsXG4gICAgICAgIGNvbXAgPSAwLCBpID0gMCxcbiAgICAgICAgc3VtLCBtaW5lLCBvdGhlcjtcbiAgICBcbiAgICAvLyAjMSBDb21wYXJlIHRoZSBsaXN0IG9mIDxkLHMsYz5cbiAgICB3aGlsZSAoY29tcGFyaW5nICYmIGkgPCBNYXRoLm1pbih0aGlzLl9jLmxlbmd0aCwgby5fYy5sZW5ndGgpICkge1xuICAgICAgICAvLyBjYW4gc3RvcCBiZWZvcmUgdGhlIGVuZCBvZiBmb3IgbG9vcCB3aXogcmV0dXJuXG4gICAgICAgIHN1bSA9IEJhc2UuZ2V0U3VtQml0KGkpO1xuICAgICAgICAvLyAjMWEgdHJ1bmNhdGUgbWluZVxuICAgICAgICBtaW5lID0gQkkuZHVwKHRoaXMuX2QpO1xuICAgICAgICBCSS5yaWdodFNoaWZ0XyhtaW5lLCBkQml0TGVuZ3RoIC0gc3VtKTtcbiAgICAgICAgLy8gIzFiIHRydW5jYXRlIG90aGVyXG4gICAgICAgIG90aGVyID0gQkkuZHVwKG8uX2QpO1xuICAgICAgICBCSS5yaWdodFNoaWZ0XyhvdGhlciwgb2RCaXRMZW5ndGggLSBzdW0pO1xuICAgICAgICAvLyAjMiBDb21wYXJlIHRyaXBsZXNcbiAgICAgICAgaWYgKCFCSS5lcXVhbHMobWluZSxvdGhlcikpIHsgIC8vICMyYSBkaWdpdFxuICAgICAgICAgICAgaWYgKEJJLmdyZWF0ZXIobWluZSxvdGhlcikpe2NvbXAgPSAxO31lbHNle2NvbXAgPSAtMTt9O1xuICAgICAgICAgICAgY29tcGFyaW5nID0gZmFsc2U7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb21wID0gdGhpcy5fc1tpXSAtIG8uX3NbaV07IC8vICMyYiBzb3VyY2VcbiAgICAgICAgICAgIGlmIChjb21wICE9PSAwKSB7XG4gICAgICAgICAgICAgICAgY29tcGFyaW5nID0gZmFsc2U7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbXAgPSB0aGlzLl9jW2ldIC0gby5fY1tpXTsgLy8gMmMgY2xvY2tcbiAgICAgICAgICAgICAgICBpZiAoY29tcCAhPT0gMCkge1xuICAgICAgICAgICAgICAgICAgICBjb21wYXJpbmcgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfTtcbiAgICAgICAgKytpO1xuICAgIH07XG4gICAgXG4gICAgaWYgKGNvbXA9PT0wKXtcbiAgICAgICAgY29tcCA9IHRoaXMuX2MubGVuZ3RoIC0gby5fYy5sZW5ndGg7IC8vICMzIGNvbXBhcmUgbGlzdCBzaXplXG4gICAgfTtcbiAgICByZXR1cm4gY29tcDtcbn07XG5cblxubW9kdWxlLmV4cG9ydHMgPSBJZGVudGlmaWVyO1xuIiwidmFyIFRyaXBsZSA9IHJlcXVpcmUoJy4vdHJpcGxlLmpzJyk7XG5yZXF1aXJlKCcuL3V0aWwuanMnKTtcblxuLyohXG4gKiBcXGJyaWVmIGEgbm9kZSBvZiB0aGUgTFNFUSB0cmVlXG4gKiBcXHBhcmFtIHRyaXBsZUxpc3QgdGhlIGxpc3Qgb2YgdHJpcGxlIGNvbXBvc2luZyB0aGUgcGF0aCB0byB0aGUgZWxlbWVudFxuICogXFxwYXJhbSBlbGVtZW50IHRoZSBlbGVtZW50IHRvIGluc2VydCBpbiB0aGUgc3RydWN0dXJlXG4gKi9cbmZ1bmN0aW9uIExTRVFOb2RlKHRyaXBsZUxpc3QsIGVsZW1lbnQpe1xuICAgIHRoaXMudCA9IHRyaXBsZUxpc3Quc2hpZnQoKTtcbiAgICBpZiAodHJpcGxlTGlzdC5sZW5ndGggPT09IDApe1xuICAgICAgICB0aGlzLmUgPSBlbGVtZW50O1xuICAgICAgICB0aGlzLnN1YkNvdW50ZXIgPSAwOyAvLyBjb3VudCB0aGUgbnVtYmVyIG9mIGNoaWxkcmVuIGFuZCBzdWJjaGlsZHJlblxuICAgICAgICB0aGlzLmNoaWxkcmVuID0gW107XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5lID0gbnVsbDtcbiAgICAgICAgdGhpcy5zdWJDb3VudGVyID0gMTtcbiAgICAgICAgdGhpcy5jaGlsZHJlbiA9IFtdO1xuICAgICAgICB0aGlzLmNoaWxkcmVuLnB1c2gobmV3IExTRVFOb2RlKHRyaXBsZUxpc3QsIGVsZW1lbnQpKTtcbiAgICB9O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGFkZCBhIHBhdGggZWxlbWVudCB0byB0aGUgY3VycmVudCBub2RlXG4gKiBcXHBhcmFtIG5vZGUgdGhlIG5vZGUgdG8gYWRkIGFzIGEgY2hpbGRyZW4gb2YgdGhpcyBub2RlXG4gKiBcXHJldHVybiAtMSBpZiB0aGUgZWxlbWVudCBhbHJlYWR5IGV4aXN0c1xuICovXG5MU0VRTm9kZS5wcm90b3R5cGUuYWRkID0gZnVuY3Rpb24obm9kZSl7XG4gICAgdmFyIGluZGV4ID0gdGhpcy5jaGlsZHJlbi5iaW5hcnlJbmRleE9mKG5vZGUpO1xuICAgIFxuICAgIC8vICMxIGlmIHRoZSBwYXRoIGRvIG5vIGV4aXN0LCBjcmVhdGUgaXRcbiAgICBpZiAoaW5kZXggPCAwIHx8IHRoaXMuY2hpbGRyZW4ubGVuZ3RoID09PSAwICB8fFxuICAgICAgICAoaW5kZXggPT09IDAgJiYgdGhpcy5jaGlsZHJlbi5sZW5ndGggPiAwICYmIFxuICAgICAgICAgdGhpcy5jaGlsZHJlblswXS5jb21wYXJlKG5vZGUpIT09MCkpe1xuICAgICAgICB0aGlzLmNoaWxkcmVuLnNwbGljZSgtaW5kZXgsIDAsIG5vZGUpO1xuICAgICAgICB0aGlzLnN1YkNvdW50ZXIrPTE7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgLy8gIzIgb3RoZXJ3aXNlLCBjb250aW51ZSB0byBleHBsb3JlIHRoZSBzdWJ0cmVlc1xuICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGggPT09IDApe1xuICAgICAgICAgICAgLy8gIzJhIGNoZWNrIGlmIHRoZSBlbGVtZW50IGFscmVhZHkgZXhpc3RzXG4gICAgICAgICAgICBpZiAodGhpcy5jaGlsZHJlbltpbmRleF0uZSAhPT0gbnVsbCl7XG4gICAgICAgICAgICAgICAgcmV0dXJuIC0xO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLmNoaWxkcmVuW2luZGV4XS5lID0gbm9kZS5lO1xuICAgICAgICAgICAgICAgIHRoaXMuc3ViQ291bnRlcis9MTtcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyAjMyBpZiBkaWRub3QgZXhpc3QsIGluY3JlbWVudCB0aGUgY291bnRlclxuICAgICAgICAgICAgaWYgKHRoaXMuY2hpbGRyZW5baW5kZXhdLmFkZChub2RlLmNoaWxkcmVuWzBdKSE9PS0xKXtcbiAgICAgICAgICAgICAgICB0aGlzLnN1YkNvdW50ZXIrPTE7XG4gICAgICAgICAgICB9O1xuICAgICAgICB9O1xuICAgIH07XG59O1xuXG4vKiEgXG4gKiBcXGJyaWVmIHJlbW92ZSB0aGUgbm9kZSBvZiB0aGUgdHJlZSBhbmQgYWxsIG5vZGUgd2l0aGluIHBhdGggYmVpbmcgdXNlbGVzc1xuICogXFxwYXJhbSBub2RlIHRoZSBub2RlIGNvbnRhaW5pbmcgdGhlIHBhdGggdG8gcmVtb3ZlXG4gKiBcXHJldHVybiAtMSBpZiB0aGUgbm9kZSBkb2VzIG5vdCBleGlzdFxuICovXG5MU0VRTm9kZS5wcm90b3R5cGUuZGVsID0gZnVuY3Rpb24obm9kZSl7XG4gICAgdmFyIGluZGV4ZXMgPSB0aGlzLmdldEluZGV4ZXMobm9kZSksXG4gICAgICAgIGN1cnJlbnRUcmVlID0gdGhpcywgaSA9IDAsIGlzU3BsaXR0ZWQgPSBmYWxzZTtcblxuICAgIGlmIChpbmRleGVzID09PSAtMSkgeyByZXR1cm4gLTE7IH07IC8vIGl0IGRvZXMgbm90IGV4aXN0c1xuICAgIHRoaXMuc3ViQ291bnRlciAtPSAxO1xuICAgIHdoaWxlIChpIDwgaW5kZXhlcy5sZW5ndGggJiYgIShpc1NwbGl0dGVkKSl7XG4gICAgICAgIGlmICghKGN1cnJlbnRUcmVlLmNoaWxkcmVuW2luZGV4ZXNbaV1dLmUgIT09IG51bGwgJiZcbiAgICAgICAgICAgICAgaT09PShpbmRleGVzLmxlbmd0aCAtIDEpKSl7XG4gICAgICAgICAgICBjdXJyZW50VHJlZS5jaGlsZHJlbltpbmRleGVzW2ldXS5zdWJDb3VudGVyIC09IDE7ICAgICBcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKGN1cnJlbnRUcmVlLmNoaWxkcmVuW2luZGV4ZXNbaV1dLnN1YkNvdW50ZXIgPD0gMFxuICAgICAgICAgICAgJiYgKGN1cnJlbnRUcmVlLmNoaWxkcmVuW2luZGV4ZXNbaV1dLmUgPT09IG51bGwgfHxcbiAgICAgICAgICAgICAgICAoY3VycmVudFRyZWUuY2hpbGRyZW5baW5kZXhlc1tpXV0uZSAhPT0gbnVsbCAmJlxuICAgICAgICAgICAgICAgICBpPT09KGluZGV4ZXMubGVuZ3RoIC0gMSkpKSl7XG4gICAgICAgICAgICBjdXJyZW50VHJlZS5jaGlsZHJlbi5zcGxpY2UoaW5kZXhlc1tpXSwxKTtcbiAgICAgICAgICAgIGlzU3BsaXR0ZWQgPSB0cnVlO1xuICAgICAgICB9O1xuICAgICAgICBjdXJyZW50VHJlZSA9IGN1cnJlbnRUcmVlLmNoaWxkcmVuW2luZGV4ZXNbaV1dO1xuICAgICAgICArK2k7XG4gICAgfTtcbiAgICBpZiAoIWlzU3BsaXR0ZWQpeyBjdXJyZW50VHJlZS5lID0gbnVsbDt9O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNvbXBhcmlzb24gZnVuY3Rpb24gdXNlZCB0byBvcmRlciB0aGUgbGlzdCBvZiBjaGlsZHJlbiBhdCBlYWNoIG5vZGVcbiAqIFxccGFyYW0gbyB0aGUgb3RoZXIgbm9kZSB0byBjb21wYXJlIHdpdGhcbiAqL1xuTFNFUU5vZGUucHJvdG90eXBlLmNvbXBhcmUgPSBmdW5jdGlvbihvKXtcbiAgICByZXR1cm4gdGhpcy50LmNvbXBhcmUoby50KTtcbn07XG5cbi8qIVxuICogXFxicmllZiB0aGUgb3JkZXJlZCB0cmVlIGNhbiBiZSBsaW5lYXJpemVkIGludG8gYSBzZXF1ZW5jZS4gVGhpcyBmdW5jdGlvbiBnZXRcbiAqIHRoZSBpbmRleCBvZiB0aGUgcGF0aCByZXByZXNlbnRlZCBieSB0aGUgbGlzdCBvZiB0cmlwbGVzXG4gKiBcXHBhcmFtIG5vZGUgdGhlIG5vZGUgY29udGFpbmluZyB0aGUgcGF0aFxuICogXFxyZXR1cm4gdGhlIGluZGV4IG9mIHRoZSBwYXRoIGluIHRoZSBub2RlXG4gKi9cbkxTRVFOb2RlLnByb3RvdHlwZS5pbmRleE9mID0gZnVuY3Rpb24obm9kZSl7XG4gICAgdmFyIGluZGV4ZXMgPSB0aGlzLmdldEluZGV4ZXMobm9kZSksXG4gICAgICAgIHN1bSA9IDAsIGN1cnJlbnRUcmVlID0gdGhpcyxcbiAgICAgICAgaiA9IDA7XG4gICAgaWYgKGluZGV4ZXMgPT09IC0xKXtyZXR1cm4gLTE7fTsgLy8gbm9kZSBkb2VzIG5vdCBleGlzdFxuICAgIGlmICh0aGlzLmUgIT09IG51bGwpeyBzdW0gKz0xOyB9O1xuICAgIFxuICAgIGZvciAodmFyIGkgPSAwOyBpPGluZGV4ZXMubGVuZ3RoOyArK2kpe1xuICAgICAgICBpZiAoaW5kZXhlc1tpXSA8IChjdXJyZW50VHJlZS5jaGlsZHJlbi5sZW5ndGgvMikpe1xuICAgICAgICAgICAgLy8gI0Egc3RhcnQgZnJvbSB0aGUgYmVnaW5uaW5nXG4gICAgICAgICAgICBmb3IgKHZhciBqID0gMDsgajxpbmRleGVzW2ldOyArK2ope1xuICAgICAgICAgICAgICAgIGlmIChjdXJyZW50VHJlZS5jaGlsZHJlbltqXS5lICE9PSBudWxsKXsgc3VtKz0xOyB9O1xuICAgICAgICAgICAgICAgIHN1bSArPSBjdXJyZW50VHJlZS5jaGlsZHJlbltqXS5zdWJDb3VudGVyO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vICNCIHN0YXJ0IGZyb20gdGhlIGVuZFxuICAgICAgICAgICAgc3VtICs9IGN1cnJlbnRUcmVlLnN1YkNvdW50ZXI7XG4gICAgICAgICAgICBmb3IgKHZhciBqID0gY3VycmVudFRyZWUuY2hpbGRyZW4ubGVuZ3RoLTE7IGo+PWluZGV4ZXNbaV07LS1qKXtcbiAgICAgICAgICAgICAgICBpZiAoY3VycmVudFRyZWUuY2hpbGRyZW5bal0uZSAhPT0gbnVsbCl7IHN1bS09MTsgfTtcbiAgICAgICAgICAgICAgICBzdW0gLT0gY3VycmVudFRyZWUuY2hpbGRyZW5bal0uc3ViQ291bnRlcjsgIFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGogKz0gMTtcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKGN1cnJlbnRUcmVlLmNoaWxkcmVuW2pdLmUgIT09IG51bGwpeyBzdW0rPTE7IH07XG4gICAgICAgIGN1cnJlbnRUcmVlID0gY3VycmVudFRyZWUuY2hpbGRyZW5bal07XG4gICAgfTtcbiAgICByZXR1cm4gc3VtLTE7IC8vIC0xIGJlY2F1c2UgYWxnb3JpdGhtIGNvdW50ZWQgdGhlIGVsZW1lbnQgaXRzZWxmXG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0IHRoZSBsaXN0IG9mIGluZGV4ZXMgb2YgdGhlIGFycmF5cyByZXByZXNlbnRpbmcgdGhlIGNoaWxkcmVuIGluXG4gKiB0aGUgdHJlZVxuICogXFxwYXJhbSBub2RlIHRoZSBub2RlIGNvbnRhaW5pbmcgdGhlIHBhdGhcbiAqIFxccmV0dXJuIGEgbGlzdCBvZiBpbnRlZ2VyXG4gKi9cbkxTRVFOb2RlLnByb3RvdHlwZS5nZXRJbmRleGVzID0gZnVuY3Rpb24obm9kZSl7XG4gICAgZnVuY3Rpb24gX2dldEluZGV4ZXMoaW5kZXhlcywgY3VycmVudFRyZWUsIGN1cnJlbnROb2RlKXtcbiAgICAgICAgdmFyIGluZGV4ID0gY3VycmVudFRyZWUuY2hpbGRyZW4uYmluYXJ5SW5kZXhPZihjdXJyZW50Tm9kZSk7XG4gICAgICAgIGlmIChpbmRleCA8IDAgfHxcbiAgICAgICAgICAgIChpbmRleD09PTAgJiYgY3VycmVudFRyZWUuY2hpbGRyZW4ubGVuZ3RoPT09MCkpeyByZXR1cm4gLTE7IH1cbiAgICAgICAgaW5kZXhlcy5wdXNoKGluZGV4KTtcbiAgICAgICAgaWYgKGN1cnJlbnROb2RlLmNoaWxkcmVuLmxlbmd0aD09PTAgfHxcbiAgICAgICAgICAgIGN1cnJlbnRUcmVlLmNoaWxkcmVuLmxlbmd0aD09PTApe1xuICAgICAgICAgICAgcmV0dXJuIGluZGV4ZXM7XG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiBfZ2V0SW5kZXhlcyhpbmRleGVzLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudFRyZWUuY2hpbGRyZW5baW5kZXhdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudE5vZGUuY2hpbGRyZW5bMF0pO1xuICAgICAgICBcbiAgICB9O1xuICAgIHJldHVybiBfZ2V0SW5kZXhlcyhbXSwgdGhpcywgbm9kZSk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgdGhlIG9yZGVyZWQgdHJlZSBjYW4gYmUgbGluZWFyaXplZC4gVGhpcyBmdW5jdGlvbiBnZXRzIHRoZSBub2RlIGF0XG4gKiB0aGUgaW5kZXggaW4gdGhlIHByb2plY3RlZCBzZXF1ZW5jZS5cbiAqIFxccGFyYW0gaW5kZXggdGhlIGluZGV4IGluIHRoZSBzZXF1ZW5jZVxuICogXFxyZXR1cm5zIHRoZSBub2RlIGF0IHRoZSBpbmRleFxuICovXG5MU0VRTm9kZS5wcm90b3R5cGUuZ2V0ID0gZnVuY3Rpb24oaW5kZXgpe1xuICAgIGZ1bmN0aW9uIF9nZXQobGVmdFN1bSwgYnVpbGRpbmdOb2RlLCBxdWV1ZSwgY3VycmVudE5vZGUpe1xuICAgICAgICB2YXIgc3RhcnRCZWdpbm5pbmcgPSB0cnVlLCB1c2VGdW5jdGlvbiwgaSA9IDAsXG4gICAgICAgICAgICBwLCB0ZW1wO1xuICAgICAgICAvLyAjMCB0aGUgbm9kZSBpcyBmb3VuZCwgcmV0dXJuIHRoZSBpbmNyZW1lbnRhbGx5IGJ1aWx0IG5vZGUgYW5kIHByYWlzZVxuICAgICAgICAvLyAjdGhlIHN1biAhXG4gICAgICAgIGlmIChsZWZ0U3VtID09PSBpbmRleCAmJiBjdXJyZW50Tm9kZS5lICE9PSBudWxsKXtcbiAgICAgICAgICAgIC8vIDFhIGNvcHkgdGhlIHZhbHVlIG9mIHRoZSBlbGVtZW50IGluIHRoZSBwYXRoXG4gICAgICAgICAgICBxdWV1ZS5lID0gY3VycmVudE5vZGUuZTtcbiAgICAgICAgICAgIHJldHVybiBidWlsZGluZ05vZGU7XG4gICAgICAgIH07XG4gICAgICAgIGlmIChjdXJyZW50Tm9kZS5lICE9PSBudWxsKXsgbGVmdFN1bSArPSAxOyB9O1xuXG4gICAgICAgIC8vICMxIHNlYXJjaDogZG8gSSBzdGFydCBmcm9tIHRoZSBiZWdpbm5pbmcgb3IgdGhlIGVuZFxuICAgICAgICBzdGFydEJlZ2lubmluZyA9ICgoaW5kZXgtbGVmdFN1bSk8KGN1cnJlbnROb2RlLnN1YkNvdW50ZXIvMikpO1xuICAgICAgICBpZiAoc3RhcnRCZWdpbm5pbmcpe1xuICAgICAgICAgICAgdXNlRnVuY3Rpb24gPSBmdW5jdGlvbihhLGIpe3JldHVybiBhK2I7fTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxlZnRTdW0gKz0gY3VycmVudE5vZGUuc3ViQ291bnRlcjtcbiAgICAgICAgICAgIHVzZUZ1bmN0aW9uID0gZnVuY3Rpb24oYSxiKXtyZXR1cm4gYS1iO307XG4gICAgICAgIH1cblxuICAgICAgICAvLyAjMmEgY291bnRpbmcgdGhlIGVsZW1lbnQgZnJvbSBsZWZ0IHRvIHJpZ2h0XG4gICAgICAgIGlmICghc3RhcnRCZWdpbm5pbmcpIHsgaSA9IGN1cnJlbnROb2RlLmNoaWxkcmVuLmxlbmd0aC0xOyB9O1xuICAgICAgICB3aGlsZSAoKHN0YXJ0QmVnaW5uaW5nICYmIGxlZnRTdW0gPD0gaW5kZXgpIHx8XG4gICAgICAgICAgICAgICAoIXN0YXJ0QmVnaW5uaW5nICYmIGxlZnRTdW0gPiBpbmRleCkpe1xuICAgICAgICAgICAgaWYgKGN1cnJlbnROb2RlLmNoaWxkcmVuW2ldLmUhPT1udWxsKXtcbiAgICAgICAgICAgICAgICBsZWZ0U3VtID0gdXNlRnVuY3Rpb24obGVmdFN1bSwgMSk7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgbGVmdFN1bSA9IHVzZUZ1bmN0aW9uKGxlZnRTdW0sY3VycmVudE5vZGUuY2hpbGRyZW5baV0uc3ViQ291bnRlcik7XG4gICAgICAgICAgICBpID0gdXNlRnVuY3Rpb24oaSwgMSk7XG4gICAgICAgIH07XG5cbiAgICAgICAgLy8gIzJiIGRlY3JlYXNpbmcgdGhlIGluY3JlbWVudGF0aW9uXG4gICAgICAgIGkgPSB1c2VGdW5jdGlvbihpLC0xKTtcbiAgICAgICAgaWYgKHN0YXJ0QmVnaW5uaW5nKXtcbiAgICAgICAgICAgIGlmIChjdXJyZW50Tm9kZS5jaGlsZHJlbltpXS5lIT09bnVsbCl7XG4gICAgICAgICAgICAgICAgbGVmdFN1bSA9IHVzZUZ1bmN0aW9uKGxlZnRTdW0sIC0xKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBsZWZ0U3VtID0gdXNlRnVuY3Rpb24obGVmdFN1bSwtY3VycmVudE5vZGUuY2hpbGRyZW5baV0uc3ViQ291bnRlcik7XG4gICAgICAgIH07XG4gICAgICAgIFxuICAgICAgICAvLyAjMyBidWlsZCBwYXRoXG4gICAgICAgIHAgPSBbXTsgcC5wdXNoKGN1cnJlbnROb2RlLmNoaWxkcmVuW2ldLnQpO1xuICAgICAgICBpZiAoYnVpbGRpbmdOb2RlID09PSBudWxsKXtcbiAgICAgICAgICAgIGJ1aWxkaW5nTm9kZSA9IG5ldyBMU0VRTm9kZShwLG51bGwpO1xuICAgICAgICAgICAgcXVldWUgPSBidWlsZGluZ05vZGU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0ZW1wID0gbmV3IExTRVFOb2RlKHAsbnVsbCk7XG4gICAgICAgICAgICBxdWV1ZS5hZGQodGVtcCk7XG4gICAgICAgICAgICBxdWV1ZSA9IHRlbXA7XG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiBfZ2V0KGxlZnRTdW0sIGJ1aWxkaW5nTm9kZSwgcXVldWUsXG4gICAgICAgICAgICAgICAgICAgIGN1cnJlbnROb2RlLmNoaWxkcmVuW2ldKTtcbiAgICB9O1xuICAgIHJldHVybiBfZ2V0KDAsIG51bGwsIG51bGwsIHRoaXMpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNhc3QgdGhlIEpTT04gb2JqZWN0IHRvIGEgTFNFUU5vZGVcbiAqIFxccGFyYW0gb2JqZWN0IHRoZSBKU09OIG9iamVjdFxuICogXFxyZXR1cm4gYSBzZWxmIHJlZmVyZW5jZVxuICovXG5MU0VRTm9kZS5wcm90b3R5cGUuZnJvbUpTT04gPSBmdW5jdGlvbihvYmplY3Qpe1xuICAgIHRoaXMudCA9IG5ldyBUcmlwbGUob2JqZWN0LnQucCwgb2JqZWN0LnQucywgb2JqZWN0LnQuYyk7XG4gICAgaWYgKG9iamVjdC5jaGlsZHJlbi5sZW5ndGggPT09IDApe1xuICAgICAgICB0aGlzLmUgPSBvYmplY3QuZTtcbiAgICAgICAgdGhpcy5zdWJDb3VudGVyID0gMDtcbiAgICAgICAgdGhpcy5jaGlsZHJlbiA9IFtdO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuZSA9IG51bGw7XG4gICAgICAgIHRoaXMuc3ViQ291bnRlciA9IDE7XG4gICAgICAgIHRoaXMuY2hpbGRyZW4gPSBbXTtcbiAgICAgICAgdGhpcy5jaGlsZHJlbi5wdXNoKFxuICAgICAgICAgICAgKG5ldyBMU0VRTm9kZShbXSwgbnVsbCkuZnJvbUpTT04ob2JqZWN0LmNoaWxkcmVuWzBdKSkpO1xuICAgIH07XG4gICAgcmV0dXJuIHRoaXM7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IExTRVFOb2RlO1xuIiwidmFyIEJJID0gcmVxdWlyZSgnQmlnSW50Jyk7XG52YXIgQmFzZSA9IHJlcXVpcmUoJy4vYmFzZS5qcycpKDE1KTtcbnZhciBTID0gcmVxdWlyZSgnLi9zdHJhdGVneS5qcycpKDEwKTtcbnZhciBJRCA9IHJlcXVpcmUoJy4vaWRlbnRpZmllci5qcycpO1xudmFyIFRyaXBsZSA9IHJlcXVpcmUoJy4vdHJpcGxlLmpzJyk7XG52YXIgTFNFUU5vZGUgPSByZXF1aXJlKCcuL2xzZXFub2RlLmpzJyk7XG5cbi8qIVxuICogXFxjbGFzcyBMU0VRVHJlZVxuICpcbiAqIFxcYnJpZWYgRGlzdHJpYnV0ZWQgYXJyYXkgdXNpbmcgTFNFUSBhbGxvY2F0aW9uIHN0cmF0ZWd5IHdpdGggYW4gdW5kZXJseWluZ1xuICogZXhwb25lbnRpYWwgdHJlZSBtb2RlbFxuICovXG5mdW5jdGlvbiBMU0VRVHJlZShzKXtcbiAgICB2YXIgbGlzdFRyaXBsZTtcbiAgICBcbiAgICB0aGlzLl9zID0gcztcbiAgICB0aGlzLl9jID0gMDtcbiAgICB0aGlzLl9oYXNoID0gZnVuY3Rpb24oZGVwdGgpIHsgcmV0dXJuIGRlcHRoJTI7IH07XG4gICAgdGhpcy5sZW5ndGggPSAwO1xuXG4gICAgdGhpcy5yb290ID0gbmV3IExTRVFOb2RlKFtdLG51bGwpO1xuICAgIGxpc3RUcmlwbGUgPSBbXTsgbGlzdFRyaXBsZS5wdXNoKG5ldyBUcmlwbGUoMCwwLDApKTsgIC8vIG1pbiBib3VuZFxuICAgIHRoaXMucm9vdC5hZGQobmV3IExTRVFOb2RlKGxpc3RUcmlwbGUsIFwiXCIpKTtcbiAgICBsaXN0VHJpcGxlID0gW107XG4gICAgbGlzdFRyaXBsZS5wdXNoKG5ldyBUcmlwbGUoTWF0aC5wb3coMixCYXNlLmdldEJpdEJhc2UoMCkpLTEsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgTnVtYmVyLk1BWF9WQUxVRSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBOdW1iZXIuTUFYX1ZBTFVFKSk7IC8vIG1heCBib3VuZFxuICAgIHRoaXMucm9vdC5hZGQobmV3IExTRVFOb2RlKGxpc3RUcmlwbGUsIFwiXCIpKTtcbn07XG5cbi8qIVxuICogXFxicmllZiByZXR1cm4gdGhlIExTRVFOb2RlIG9mIHRoZSBlbGVtZW50IGF0ICB0YXJnZXRlZCBpbmRleFxuICogXFxwYXJhbSBpbmRleCB0aGUgaW5kZXggb2YgdGhlIGVsZW1lbnQgaW4gdGhlIGZsYXR0ZW5lZCBhcnJheVxuICogXFxyZXR1cm4gdGhlIExTRVFOb2RlIHRhcmdldGluZyB0aGUgZWxlbWVudCBhdCBpbmRleFxuICovXG5MU0VRVHJlZS5wcm90b3R5cGUuZ2V0ID0gZnVuY3Rpb24oaW5kZXgpe1xuICAgIC8vICMxIHNlYXJjaCBpbiB0aGUgdHJlZSB0byBnZXQgdGhlIHZhbHVlXG4gICAgcmV0dXJuIHRoaXMucm9vdC5nZXQoaW5kZXgpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGluc2VydCBhIHZhbHVlIGF0IHRoZSB0YXJnZXRlZCBpbmRleFxuICogXFxwYXJhbSBlbGVtZW50IHRoZSBlbGVtZW50IHRvIGluc2VydFxuICogXFxwYXJhbSBpbmRleCB0aGUgcG9zaXRpb24gaW4gdGhlIGFycmF5XG4gKiBcXHJldHVybiBhIHBhaXIge19lOiBlbGVtZW50ICwgX2k6IGlkZW50aWZpZXJ9XG4gKi9cbkxTRVFUcmVlLnByb3RvdHlwZS5pbnNlcnQgPSBmdW5jdGlvbihlbGVtZW50LCBpbmRleCl7XG4gICAgdmFyIHBlaSA9IHRoaXMuZ2V0KGluZGV4KSwgLy8gIzFhIHByZXZpb3VzIGJvdW5kXG4gICAgICAgIHFlaSA9IHRoaXMuZ2V0KGluZGV4KzEpLCAvLyAjMWIgbmV4dCBib3VuZFxuICAgICAgICBpZCwgY291cGxlO1xuICAgIHRoaXMuX2MgKz0gMTsgLy8gIzJhIGluY3JlbWVudGluZyB0aGUgbG9jYWwgY291bnRlclxuICAgIGlkID0gdGhpcy5hbGxvYyhwZWksIHFlaSk7IC8vICMyYiBnZW5lcmF0aW5nIHRoZSBpZCBpbmJldHdlZW4gdGhlIGJvdW5kc1xuICAgIC8vICMzIGFkZCBpdCB0byB0aGUgc3RydWN0dXJlIGFuZCByZXR1cm4gdmFsdWVcbiAgICBjb3VwbGUgPSB7X2U6IGVsZW1lbnQsIF9pOiBpZH1cbiAgICB0aGlzLmFwcGx5SW5zZXJ0KGVsZW1lbnQsIGlkLCB0cnVlKTtcbiAgICByZXR1cm4gY291cGxlO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGRlbGV0ZSB0aGUgZWxlbWVudCBhdCB0aGUgaW5kZXhcbiAqIFxccGFyYW0gaW5kZXggdGhlIGluZGV4IG9mIHRoZSBlbGVtZW50IHRvIGRlbGV0ZSBpbiB0aGUgYXJyYXlcbiAqIFxccmV0dXJuIHRoZSBpZGVudGlmaWVyIG9mIHRoZSBlbGVtZW50IGF0IHRoZSBpbmRleFxuICovXG5MU0VRVHJlZS5wcm90b3R5cGUucmVtb3ZlID0gZnVuY3Rpb24oaW5kZXgpe1xuICAgIHZhciBlaSA9IHRoaXMuZ2V0KGluZGV4KzEpLFxuICAgICAgICBpID0gbmV3IElEKG51bGwsIFtdLCBbXSk7XG4gICAgaS5mcm9tTm9kZShlaSk7IC8vIGZyb20gbm9kZSAtPiBpZFxuICAgIHRoaXMuYXBwbHlSZW1vdmUoZWkpOyBcbiAgICByZXR1cm4gaTtcbn07XG5cbi8qIVxuICogXFxicmllZiBnZW5lcmF0ZSB0aGUgZGlnaXQgcGFydCBvZiB0aGUgaWRlbnRpZmllcnMgIGJldHdlZW4gcCBhbmQgcVxuICogXFxwYXJhbSBwIHRoZSBkaWdpdCBwYXJ0IG9mIHRoZSBwcmV2aW91cyBpZGVudGlmaWVyXG4gKiBcXHBhcmFtIHEgdGhlIGRpZ2l0IHBhcnQgb2YgdGhlIG5leHQgaWRlbnRpZmllclxuICogXFxyZXR1cm4gdGhlIGRpZ2l0IHBhcnQgbG9jYXRlZCBiZXR3ZWVuIHAgYW5kIHFcbiAqL1xuTFNFUVRyZWUucHJvdG90eXBlLmFsbG9jID0gZnVuY3Rpb24gKHAscSl7XG4gICAgdmFyIGludGVydmFsID0gMCwgbGV2ZWwgPSAwO1xuICAgIC8vICMxIHByb2Nlc3MgdGhlIGxldmVsIG9mIHRoZSBuZXcgaWRlbnRpZmllclxuICAgIHdoaWxlIChpbnRlcnZhbDw9MCl7IC8vIG5vIHJvb20gZm9yIGluc2VydGlvblxuICAgICAgICBpbnRlcnZhbCA9IEJhc2UuZ2V0SW50ZXJ2YWwocCwgcSwgbGV2ZWwpOyAvLyAoVE9ETykgb3B0aW1pemVcbiAgICAgICAgKytsZXZlbDtcbiAgICB9O1xuICAgIGxldmVsIC09IDE7XG4gICAgaWYgKHRoaXMuX2hhc2gobGV2ZWwpID09PSAwKXtcbiAgICAgICAgcmV0dXJuIFMuYlBsdXMocCwgcSwgbGV2ZWwsIGludGVydmFsLCB0aGlzLl9zLCB0aGlzLl9jKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gUy5iTWludXMocCwgcSwgbGV2ZWwsIGludGVydmFsLCB0aGlzLl9zLCB0aGlzLl9jKTtcbiAgICB9O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGluc2VydCBhbiBlbGVtZW50IGNyZWF0ZWQgZnJvbSBhIHJlbW90ZSBzaXRlIGludG8gdGhlIGFycmF5XG4gKiBcXHBhcmFtIGUgdGhlIGVsZW1lbnQgdG8gaW5zZXJ0XG4gKiBcXHBhcmFtIGkgdGhlIGlkZW50aWZpZXIgb2YgdGhlIGVsZW1lbnRcbiAqIFxccGFyYW0gbm9JbmRleCB3aGV0aGVyIG9yIG5vdCBpdCBzaG91bGQgcmV0dXJuIHRoZSBpbmRleCBvZiB0aGUgaW5zZXJ0XG4gKiBcXHJldHVybiB0aGUgaW5kZXggb2YgdGhlIG5ld2x5IGluc2VydGVkIGVsZW1lbnQgaW4gdGhlIGFycmF5XG4gKi9cbkxTRVFUcmVlLnByb3RvdHlwZS5hcHBseUluc2VydCA9IGZ1bmN0aW9uKGUsIGksIG5vSW5kZXgpe1xuICAgIHZhciBub2RlLCByZXN1bHQ7XG4gICAgLy8gIzAgY2FzdCBmcm9tIHRoZSBwcm9wZXIgdHlwZVxuICAgIC8vICMwQSB0aGUgaWRlbnRpZmllciBpcyBhbiBJRFxuICAgIGlmIChpICYmIGkuX2QgJiYgaS5fcyAmJiBpLl9jKXtcbiAgICAgICAgbm9kZSA9IChuZXcgSUQoaS5fZCwgaS5fcywgaS5fYykudG9Ob2RlKGUpKTtcbiAgICB9O1xuICAgIC8vICMwQiB0aGUgaWRlbnRpZmllciBpcyBhIExTRVFOb2RlXG4gICAgaWYgKGkgJiYgaS50ICYmIGkuY2hpbGRyZW4pe1xuICAgICAgICBub2RlID0gKG5ldyBMU0VRTm9kZShbXSxudWxsKSkuZnJvbUpTT04oaSk7XG4gICAgfTtcbiAgICAvLyAjMiBpbnRlZ3JhdGVzIHRoZSBuZXcgZWxlbWVudCB0byB0aGUgZGF0YSBzdHJ1Y3R1cmVcbiAgICByZXN1bHQgPSB0aGlzLnJvb3QuYWRkKG5vZGUpO1xuICAgIGlmIChyZXN1bHQgIT09IC0xKXtcbiAgICAgICAgLy8gIzMgaWYgdGhlIGVsZW1lbnQgYXMgYmVlbiBhZGRlZFxuICAgICAgICB0aGlzLmxlbmd0aCArPSAxO1xuICAgIH07XG4gICAgcmV0dXJuIHJlc3VsdCB8fCAoIW5vSW5kZXggJiYgdGhpcy5yb290LmluZGV4T2Yobm9kZSkpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGRlbGV0ZSB0aGUgZWxlbWVudCB3aXRoIHRoZSB0YXJnZXRlZCBpZGVudGlmaWVyXG4gKiBcXHBhcmFtIGkgdGhlIGlkZW50aWZpZXIgb2YgdGhlIGVsZW1lbnRcbiAqIFxccmV0dXJuIHRoZSBpbmRleCBvZiB0aGUgZWxlbWVudCBmZXNobHkgZGVsZXRlZCwgLTEgaWYgbm8gcmVtb3ZhbFxuICovXG5MU0VRVHJlZS5wcm90b3R5cGUuYXBwbHlSZW1vdmUgPSBmdW5jdGlvbihpKXtcbiAgICB2YXIgbm9kZSwgcG9zaXRpb247XG4gICAgLy8gIzAgY2FzdCBmcm9tIHRoZSBwcm9wZXIgdHlwZVxuICAgIGlmIChpICYmIGkuX2QgJiYgaS5fcyAmJiBpLl9jKXtcbiAgICAgICAgbm9kZSA9IChuZXcgSUQoaS5fZCwgaS5fcywgaS5fYykpLnRvTm9kZShudWxsKTtcbiAgICB9O1xuICAgIC8vICMwQiB0aGUgaWRlbnRpZmllciBpcyBhIExTRVFOb2RlXG4gICAgaWYgKGkgJiYgaS50ICYmIGkuY2hpbGRyZW4pe1xuICAgICAgICBub2RlID0gKG5ldyBMU0VRTm9kZShbXSxudWxsKSkuZnJvbUpTT04oaSk7XG4gICAgfTtcbiAgICAvLyAjMSBnZXQgdGhlIGluZGV4IG9mIHRoZSBlbGVtZW50IHRvIHJlbW92ZVxuICAgIHBvc2l0aW9uID0gdGhpcy5yb290LmluZGV4T2Yobm9kZSk7XG4gICAgaWYgKHBvc2l0aW9uICE9PSAtMSl7XG4gICAgICAgIC8vICMyIGlmIGl0IGV4aXN0cyByZW1vdmUgaXRcbiAgICAgICAgdGhpcy5yb290LmRlbChub2RlKTtcbiAgICAgICAgdGhpcy5sZW5ndGggLT0gMTtcbiAgICB9O1xuICAgIHJldHVybiBwb3NpdGlvbjtcbn07XG5cblxuLyohXG4gKiBcXGJyaWVmIGNhc3QgdGhlIEpTT04gb2JqZWN0IGludG8gYSBwcm9wZXIgTFNFUVRyZWUuXG4gKiBcXHBhcmFtIG9iamVjdCB0aGUgSlNPTiBvYmplY3QgdG8gY2FzdFxuICogXFxyZXR1cm4gYSBzZWxmIHJlZmVyZW5jZVxuICovXG5MU0VRVHJlZS5wcm90b3R5cGUuZnJvbUpTT04gPSBmdW5jdGlvbihvYmplY3Qpe1xuICAgIC8vICMxIGNvcHkgdGhlIHNvdXJjZSwgY291bnRlciwgYW5kIGxlbmd0aCBvZiB0aGUgb2JqZWN0XG4gICAgdGhpcy5fcyA9IG9iamVjdC5fcztcbiAgICB0aGlzLl9jID0gb2JqZWN0Ll9jO1xuICAgIHRoaXMubGVuZ3RoID0gb2JqZWN0Lmxlbmd0aDtcbiAgICAvLyAjMiBkZXB0aCBmaXJzdCBhZGRpbmdcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgZnVuY3Rpb24gZGVwdGhGaXJzdChjdXJyZW50Tm9kZSwgY3VycmVudFBhdGgpe1xuICAgICAgICB2YXIgdHJpcGxlID0gbmV3IFRyaXBsZShjdXJyZW50Tm9kZS50LnAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnROb2RlLnQucyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudE5vZGUudC5jKTtcbiAgICAgICAgY3VycmVudFBhdGgucHVzaCh0cmlwbGUpOyAvLyBzdGFja1xuICAgICAgICBpZiAoY3VycmVudE5vZGUuZSE9PW51bGwpe1xuICAgICAgICAgICAgdmFyIGNvcHkgPSBjdXJyZW50UGF0aC5zbGljZSgpO1xuICAgICAgICAgICAgc2VsZi5yb290LmFkZChuZXcgTFNFUU5vZGUoY29weSwgY3VycmVudE5vZGUuZSkpO1xuICAgICAgICB9O1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaTxjdXJyZW50Tm9kZS5jaGlsZHJlbi5sZW5ndGg7ICsraSl7XG4gICAgICAgICAgICBkZXB0aEZpcnN0KGN1cnJlbnROb2RlLmNoaWxkcmVuW2ldLCBjdXJyZW50UGF0aCk7XG4gICAgICAgIH07XG4gICAgICAgIGN1cnJlbnRQYXRoLnBvcCgpOyAvLyB1bnN0YWNrXG4gICAgfTtcbiAgICBmb3IgKHZhciBpID0gMDsgaTxvYmplY3Qucm9vdC5jaGlsZHJlbi5sZW5ndGg7ICsraSl7XG4gICAgICAgIGRlcHRoRmlyc3Qob2JqZWN0LnJvb3QuY2hpbGRyZW5baV0sIFtdKTtcbiAgICB9O1xuICAgIHJldHVybiB0aGlzO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBMU0VRVHJlZTtcbiIsInZhciBCSSA9IHJlcXVpcmUoJ0JpZ0ludCcpO1xudmFyIEJhc2UgPSByZXF1aXJlKCcuL2Jhc2UuanMnKSgpO1xudmFyIElEID0gcmVxdWlyZSgnLi9pZGVudGlmaWVyLmpzJyk7XG5cbi8qIVxuICogXFxjbGFzcyBTdHJhdGVneVxuICogXFxicmllZiBFbnVtZXJhdGUgdGhlIGF2YWlsYWJsZSBzdWItYWxsb2NhdGlvbiBzdHJhdGVnaWVzLiBUaGUgc2lnbmF0dXJlIG9mXG4gKiB0aGVzZSBmdW5jdGlvbnMgaXMgZihJZCwgSWQsIE4rLCBOKywgTiwgTik6IElkLlxuICogXFxwYXJhbSBib3VuZGFyeSB0aGUgdmFsdWUgdXNlZCBhcyB0aGUgZGVmYXVsdCBtYXhpbXVtIHNwYWNpbmcgYmV0d2VlbiBpZHNcbiAqL1xuZnVuY3Rpb24gU3RyYXRlZ3koYm91bmRhcnkpe1xuICAgIHZhciBERUZBVUxUX0JPVU5EQVJZID0gMTA7XG4gICAgdGhpcy5fYm91bmRhcnkgPSBib3VuZGFyeSB8fCBERUZBVUxUX0JPVU5EQVJZO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIENob29zZSBhbiBpZCBzdGFydGluZyBmcm9tIHByZXZpb3VzIGJvdW5kIGFuZCBhZGRpbmcgcmFuZG9tIG51bWJlclxuICogXFxwYXJhbSBwIHRoZSBwcmV2aW91cyBpZGVudGlmaWVyXG4gKiBcXHBhcmFtIHEgdGhlIG5leHQgaWRlbnRpZmllclxuICogXFxwYXJhbSBsZXZlbCB0aGUgbnVtYmVyIG9mIGNvbmNhdGVuYXRpb24gY29tcG9zaW5nIHRoZSBuZXcgaWRlbnRpZmllclxuICogXFxwYXJhbSBpbnRlcnZhbCB0aGUgaW50ZXJ2YWwgYmV0d2VlbiBwIGFuZCBxXG4gKiBcXHBhcmFtIHMgdGhlIHNvdXJjZSB0aGF0IGNyZWF0ZXMgdGhlIG5ldyBpZGVudGlmaWVyXG4gKiBcXHBhcmFtIGMgdGhlIGNvdW50ZXIgb2YgdGhhdCBzb3VyY2VcbiAqL1xuU3RyYXRlZ3kucHJvdG90eXBlLmJQbHVzID0gZnVuY3Rpb24gKHAsIHEsIGxldmVsLCBpbnRlcnZhbCwgcywgYyl7XG4gICAgdmFyIGNvcHlQID0gcCwgY29weVEgPSBxLFxuICAgICAgICBzdGVwID0gTWF0aC5taW4odGhpcy5fYm91bmRhcnksIGludGVydmFsKSwgLy8jMCB0aGUgbWluIGludGVydmFsXG4gICAgICAgIGRpZ2l0ID0gQkkuaW50MmJpZ0ludCgwLEJhc2UuZ2V0U3VtQml0KGxldmVsKSksXG4gICAgICAgIHZhbHVlO1xuICAgIFxuICAgIC8vICMxIGNvcHkgdGhlIHByZXZpb3VzIGlkZW50aWZpZXJcbiAgICBmb3IgKHZhciBpID0gMDsgaTw9bGV2ZWw7KytpKXtcblx0ICAgICAgdmFsdWUgPSAwO1xuICAgICAgICBpZiAocCE9PW51bGwpeyB2YWx1ZSA9IHAudC5wOyB9O1xuICAgICAgICBCSS5hZGRJbnRfKGRpZ2l0LHZhbHVlKTtcbiAgICAgICAgaWYgKGkhPT1sZXZlbCl7IEJJLmxlZnRTaGlmdF8oZGlnaXQsQmFzZS5nZXRCaXRCYXNlKGkrMSkpOyB9O1xuICAgICAgICBpZiAocCE9PW51bGwgJiYgcC5jaGlsZHJlbi5sZW5ndGghPT0wKXtcbiAgICAgICAgICAgIHAgPSBwLmNoaWxkcmVuWzBdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcCA9IG51bGw7XG4gICAgICAgIH07XG4gICAgfTtcbiAgICAvLyAjMiBjcmVhdGUgYSBkaWdpdCBmb3IgYW4gaWRlbnRpZmllciBieSBhZGRpbmcgYSByYW5kb20gdmFsdWVcbiAgICAvLyAjMmEgRGlnaXRcbiAgICBCSS5hZGRJbnRfKGRpZ2l0LCBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkqc3RlcCsxKSk7XG4gICAgLy8gIzJiIFNvdXJjZSAmIGNvdW50ZXJcbiAgICByZXR1cm4gZ2V0U0MoZGlnaXQsIGNvcHlQLCBjb3B5USwgbGV2ZWwsIHMsIGMpO1xufTtcblxuXG4vKiFcbiAqIFxcYnJpZWYgQ2hvb3NlIGFuIGlkIHN0YXJ0aW5nIGZyb20gbmV4dCBib3VuZCBhbmQgc3Vic3RyYWN0IGEgcmFuZG9tIG51bWJlclxuICogXFxwYXJhbSBwIHRoZSBwcmV2aW91cyBpZGVudGlmaWVyXG4gKiBcXHBhcmFtIHEgdGhlIG5leHQgaWRlbnRpZmllclxuICogXFxwYXJhbSBsZXZlbCB0aGUgbnVtYmVyIG9mIGNvbmNhdGVuYXRpb24gY29tcG9zaW5nIHRoZSBuZXcgaWRlbnRpZmllclxuICogXFxwYXJhbSBpbnRlcnZhbCB0aGUgaW50ZXJ2YWwgYmV0d2VlbiBwIGFuZCBxXG4gKiBcXHBhcmFtIHMgdGhlIHNvdXJjZSB0aGF0IGNyZWF0ZXMgdGhlIG5ldyBpZGVudGlmaWVyXG4gKiBcXHBhcmFtIGMgdGhlIGNvdW50ZXIgb2YgdGhhdCBzb3VyY2VcbiAqL1xuU3RyYXRlZ3kucHJvdG90eXBlLmJNaW51cyA9IGZ1bmN0aW9uIChwLCBxLCBsZXZlbCwgaW50ZXJ2YWwsIHMsIGMpe1xuICAgIHZhciBjb3B5UCA9IHAsIGNvcHlRID0gcSxcbiAgICAgICAgc3RlcCA9IE1hdGgubWluKHRoaXMuX2JvdW5kYXJ5LCBpbnRlcnZhbCksIC8vICMwIHByb2Nlc3MgbWluIGludGVydmFsXG4gICAgICAgIGRpZ2l0ID0gQkkuaW50MmJpZ0ludCgwLEJhc2UuZ2V0U3VtQml0KGxldmVsKSksXG4gICAgICAgIHBJc0dyZWF0ZXIgPSBmYWxzZSwgY29tbW9uUm9vdCA9IHRydWUsXG4gICAgICAgIHByZXZWYWx1ZSwgbmV4dFZhbHVlO1xuICAgIFxuICAgIC8vICMxIGNvcHkgbmV4dCwgaWYgcHJldmlvdXMgaXMgZ3JlYXRlciwgY29weSBtYXhWYWx1ZSBAIGRlcHRoXG4gICAgZm9yICh2YXIgaSA9IDA7IGk8PWxldmVsOysraSl7XG4gICAgICAgIHByZXZWYWx1ZSA9IDA7IGlmIChwICE9PSBudWxsKXsgcHJldlZhbHVlID0gcC50LnA7IH1cbiAgICAgICAgbmV4dFZhbHVlID0gMDsgaWYgKHEgIT09IG51bGwpeyBuZXh0VmFsdWUgPSBxLnQucDsgfVxuICAgICAgICBpZiAoY29tbW9uUm9vdCAmJiBwcmV2VmFsdWUgIT09IG5leHRWYWx1ZSl7XG4gICAgICAgICAgICBjb21tb25Sb290ID0gZmFsc2U7XG4gICAgICAgICAgICBwSXNHcmVhdGVyID0gcHJldlZhbHVlID4gbmV4dFZhbHVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwSXNHcmVhdGVyKXsgbmV4dFZhbHVlID0gTWF0aC5wb3coMixCYXNlLmdldEJpdEJhc2UoaSkpLTE7IH1cbiAgICAgICAgQkkuYWRkSW50XyhkaWdpdCwgbmV4dFZhbHVlKTtcbiAgICAgICAgaWYgKGkhPT1sZXZlbCl7IEJJLmxlZnRTaGlmdF8oZGlnaXQsQmFzZS5nZXRCaXRCYXNlKGkrMSkpOyB9XG4gICAgICAgIGlmIChxIT09bnVsbCAmJiBxLmNoaWxkcmVuLmxlbmd0aCE9PTApe1xuICAgICAgICAgICAgcSA9IHEuY2hpbGRyZW5bMF07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBxID0gbnVsbDtcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKHAhPT1udWxsICYmIHAuY2hpbGRyZW4ubGVuZ3RoIT09MCl7XG4gICAgICAgICAgICBwID0gcC5jaGlsZHJlblswXTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHAgPSBudWxsO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgLy8gIzMgY3JlYXRlIGEgZGlnaXQgZm9yIGFuIGlkZW50aWZpZXIgYnkgc3ViaW5nIGEgcmFuZG9tIHZhbHVlXG4gICAgLy8gIzNhIERpZ2l0XG4gICAgaWYgKHBJc0dyZWF0ZXIpe1xuICAgICAgICBCSS5hZGRJbnRfKGRpZ2l0LCAtTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKnN0ZXApICk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgQkkuYWRkSW50XyhkaWdpdCwgLU1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSpzdGVwKS0xICk7XG4gICAgfTtcbiAgICBcbiAgICAvLyAjM2IgU291cmNlICYgY291bnRlclxuICAgIHJldHVybiBnZXRTQyhkaWdpdCwgY29weVAsIGNvcHlRLCBsZXZlbCwgcywgYyk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgY29waWVzIHRoZSBhcHByb3ByaWF0ZXMgc291cmNlIGFuZCBjb3VudGVyIGZyb20gdGhlIGFkamFjZW50IFxuICogaWRlbnRpZmllcnMgYXQgdGhlIGluc2VydGlvbiBwb3NpdGlvbi5cbiAqIFxccGFyYW0gZCB0aGUgZGlnaXQgcGFydCBvZiB0aGUgbmV3IGlkZW50aWZpZXJcbiAqIFxccGFyYW0gcCB0aGUgcHJldmlvdXMgaWRlbnRpZmllclxuICogXFxwYXJhbSBxIHRoZSBuZXh0IGlkZW50aWZpZXJcbiAqIFxccGFyYW0gbGV2ZWwgdGhlIHNpemUgb2YgdGhlIG5ldyBpZGVudGlmaWVyXG4gKiBcXHBhcmFtIHMgdGhlIGxvY2FsIHNpdGUgaWRlbnRpZmllciBcbiAqIFxccGFyYW0gYyB0aGUgbG9jYWwgbW9ub3RvbmljIGNvdW50ZXJcbiAqL1xuZnVuY3Rpb24gZ2V0U0MoZCwgcCwgcSwgbGV2ZWwsIHMsIGMpe1xuICAgIHZhciBzb3VyY2VzID0gW10sIGNvdW50ZXJzID0gW10sXG4gICAgICAgIGkgPSAwLFxuICAgICAgICBzdW1CaXQgPSBCYXNlLmdldFN1bUJpdChsZXZlbCksXG4gICAgICAgIHRlbXBEaWdpdCwgdmFsdWU7XG4gICAgXG4gICAgd2hpbGUgKGk8PWxldmVsKXtcbiAgICAgICAgdGVtcERpZ2l0ID0gQkkuZHVwKGQpO1xuICAgICAgICBCSS5yaWdodFNoaWZ0Xyh0ZW1wRGlnaXQsIHN1bUJpdCAtIEJhc2UuZ2V0U3VtQml0KGkpKTtcbiAgICAgICAgdmFsdWUgPSBCSS5tb2RJbnQodGVtcERpZ2l0LE1hdGgucG93KDIsQmFzZS5nZXRCaXRCYXNlKGkpKSk7XG4gICAgICAgIHNvdXJjZXNbaV09cztcbiAgICAgICAgY291bnRlcnNbaV09Y1xuICAgICAgICBpZiAocSE9PW51bGwgJiYgcS50LnA9PT12YWx1ZSl7IHNvdXJjZXNbaV09cS50LnM7IGNvdW50ZXJzW2ldPXEudC5jfTtcbiAgICAgICAgaWYgKHAhPT1udWxsICYmIHAudC5wPT09dmFsdWUpeyBzb3VyY2VzW2ldPXAudC5zOyBjb3VudGVyc1tpXT1wLnQuY307XG4gICAgICAgIGlmIChxIT09bnVsbCAmJiBxLmNoaWxkcmVuLmxlbmd0aCE9PTApe1xuICAgICAgICAgICAgcSA9IHEuY2hpbGRyZW5bMF07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBxID0gbnVsbDtcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKHAhPT1udWxsICYmIHAuY2hpbGRyZW4ubGVuZ3RoIT09MCl7XG4gICAgICAgICAgICBwID0gcC5jaGlsZHJlblswXTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHAgPSBudWxsO1xuICAgICAgICB9O1xuICAgICAgICArK2k7XG4gICAgfTtcbiAgICBcbiAgICByZXR1cm4gbmV3IElEKGQsIHNvdXJjZXMsIGNvdW50ZXJzKTtcbn07XG5cblN0cmF0ZWd5Lmluc3RhbmNlID0gbnVsbDtcblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihhcmdzKXtcbiAgICBpZiAoYXJncyl7XG4gICAgICAgIFN0cmF0ZWd5Lmluc3RhbmNlID0gbmV3IFN0cmF0ZWd5KGFyZ3MpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChTdHJhdGVneS5pbnN0YW5jZSA9PT0gbnVsbCl7XG4gICAgICAgICAgICBTdHJhdGVneS5pbnN0YW5jZSA9IG5ldyBTdHJhdGVneSgpO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgcmV0dXJuIFN0cmF0ZWd5Lmluc3RhbmNlO1xufTtcbiIsIlxuLyohXG4gKiBcXGJyaWVmIHRyaXBsZSB0aGF0IGNvbnRhaW5zIGEgPHBhdGggc2l0ZSBjb3VudGVyPlxuICogXFxwYXJhbSBwYXRoIHRoZSBwYXJ0IG9mIHRoZSBwYXRoIGluIHRoZSB0cmVlXG4gKiBcXHBhcmFtIHNpdGUgdGhlIHVuaXF1ZSBzaXRlIGlkZW50aWZpZXIgdGhhdCBjcmVhdGVkIHRoZSB0cmlwbGVcbiAqIFxccGFyYW0gY291bnRlciB0aGUgY291bnRlciBvZiB0aGUgc2l0ZSB3aGVuIGl0IGNyZWF0ZWQgdGhlIHRyaXBsZVxuICovXG5mdW5jdGlvbiBUcmlwbGUocGF0aCwgc2l0ZSwgY291bnRlcil7XG4gICAgdGhpcy5wID0gcGF0aDtcbiAgICB0aGlzLnMgPSBzaXRlO1xuICAgIHRoaXMuYyA9IGNvdW50ZXI7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgY29tcGFyZSB0d28gdHJpcGxlcyBwcmlvcml0aXppbmcgdGhlIHBhdGgsIHRoZW4gc2l0ZSwgdGhlbiBjb3VudGVyXG4gKiBcXHBhcmFtIG8gdGhlIG90aGVyIHRyaXBsZSB0byBjb21wYXJlXG4gKiBcXHJldHVybiAtMSBpZiB0aGlzIGlzIGxvd2VyIHRoYW4gbywgMSBpZiB0aGlzIGlzIGdyZWF0ZXIgdGhhbiBvLCAwIG90aGVyd2lzZVxuICovXG5UcmlwbGUucHJvdG90eXBlLmNvbXBhcmUgPSBmdW5jdGlvbihvKXtcbiAgICBpZiAodGhpcy5zID09PSBOdW1iZXIuTUFYX1ZBTFVFICYmIHRoaXMuYyA9PT0gTnVtYmVyLk1BWF9WQUxVRSl7XG4gICAgICAgIHJldHVybiAxO1xuICAgIH07XG4gICAgaWYgKG8ucyA9PT0gTnVtYmVyLk1BWF9WQUxVRSAmJiBvLnMgPT09IE51bWJlci5NQVhfVkFMVUUpe1xuICAgICAgICByZXR1cm4gLTE7XG4gICAgfTtcbiAgICBcbiAgICBpZiAodGhpcy5wIDwgby5wKSB7IHJldHVybiAtMTt9O1xuICAgIGlmICh0aGlzLnAgPiBvLnApIHsgcmV0dXJuIDEgO307XG4gICAgaWYgKHRoaXMucyA8IG8ucykgeyByZXR1cm4gLTE7fTtcbiAgICBpZiAodGhpcy5zID4gby5zKSB7IHJldHVybiAxIDt9O1xuICAgIGlmICh0aGlzLmMgPCBvLmMpIHsgcmV0dXJuIC0xO307XG4gICAgaWYgKHRoaXMuYyA+IG8uYykgeyByZXR1cm4gMSA7fTtcbiAgICByZXR1cm4gMDtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gVHJpcGxlO1xuIiwiXG5mdW5jdGlvbiBiaW5hcnlJbmRleE9mKCl7XG5cbi8qKlxuICogXFxmcm9tOiBbaHR0cHM6Ly9naXN0LmdpdGh1Yi5jb20vV29sZnk4Ny81NzM0NTMwXVxuICogUGVyZm9ybXMgYSBiaW5hcnkgc2VhcmNoIG9uIHRoZSBob3N0IGFycmF5LiBUaGlzIG1ldGhvZCBjYW4gZWl0aGVyIGJlXG4gKiBpbmplY3RlZCBpbnRvIEFycmF5LnByb3RvdHlwZSBvciBjYWxsZWQgd2l0aCBhIHNwZWNpZmllZCBzY29wZSBsaWtlIHRoaXM6XG4gKiBiaW5hcnlJbmRleE9mLmNhbGwoc29tZUFycmF5LCBzZWFyY2hFbGVtZW50KTtcbiAqXG4gKlxuICogQHBhcmFtIHsqfSBzZWFyY2hFbGVtZW50IFRoZSBpdGVtIHRvIHNlYXJjaCBmb3Igd2l0aGluIHRoZSBhcnJheS5cbiAqIEByZXR1cm4ge051bWJlcn0gVGhlIGluZGV4IG9mIHRoZSBlbGVtZW50IHdoaWNoIGRlZmF1bHRzIHRvIC0xIHdoZW4gbm90XG4gKiBmb3VuZC5cbiAqL1xuQXJyYXkucHJvdG90eXBlLmJpbmFyeUluZGV4T2YgPSBmdW5jdGlvbihzZWFyY2hFbGVtZW50KSB7XG4gICAgdmFyIG1pbkluZGV4ID0gMDtcbiAgICB2YXIgbWF4SW5kZXggPSB0aGlzLmxlbmd0aCAtIDE7XG4gICAgdmFyIGN1cnJlbnRJbmRleDtcbiAgICB2YXIgY3VycmVudEVsZW1lbnQ7XG5cbiAgICB3aGlsZSAobWluSW5kZXggPD0gbWF4SW5kZXgpIHtcbiAgICAgICAgY3VycmVudEluZGV4ID0gTWF0aC5mbG9vcigobWluSW5kZXggKyBtYXhJbmRleCkgLyAyKTtcbiAgICAgICAgY3VycmVudEVsZW1lbnQgPSB0aGlzW2N1cnJlbnRJbmRleF07XG4gICAgICAgIGlmIChjdXJyZW50RWxlbWVudC5jb21wYXJlKHNlYXJjaEVsZW1lbnQpIDwgMCkge1xuICAgICAgICAgICAgbWluSW5kZXggPSBjdXJyZW50SW5kZXggKyAxO1xuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYgKGN1cnJlbnRFbGVtZW50LmNvbXBhcmUoc2VhcmNoRWxlbWVudCkgPiAwKSB7XG4gICAgICAgICAgICBtYXhJbmRleCA9IGN1cnJlbnRJbmRleCAtIDE7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICByZXR1cm4gY3VycmVudEluZGV4O1xuICAgICAgICB9XG4gICAgfTtcbiAgICByZXR1cm4gfm1heEluZGV4O1xufTtcblxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGJpbmFyeUluZGV4T2YoKTsiLCIvLyBWamV1eDogQ3VzdG9taXplZCBiaWdJbnQyc3RyIGFuZCBzdHIyYmlnSW50IGluIG9yZGVyIHRvIGFjY2VwdCBjdXN0b20gYmFzZS5cblxuLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuLy8gQmlnIEludGVnZXIgTGlicmFyeSB2LiA1LjRcbi8vIENyZWF0ZWQgMjAwMCwgbGFzdCBtb2RpZmllZCAyMDA5XG4vLyBMZWVtb24gQmFpcmRcbi8vIHd3dy5sZWVtb24uY29tXG4vL1xuLy8gVmVyc2lvbiBoaXN0b3J5OlxuLy8gdiA1LjQgIDMgT2N0IDIwMDlcbi8vICAgLSBhZGRlZCBcInZhciBpXCIgdG8gZ3JlYXRlclNoaWZ0KCkgc28gaSBpcyBub3QgZ2xvYmFsLiAoVGhhbmtzIHRvIFDvv710ZXIgU3phYu+/vSBmb3IgZmluZGluZyB0aGF0IGJ1Zylcbi8vXG4vLyB2IDUuMyAgMjEgU2VwIDIwMDlcbi8vICAgLSBhZGRlZCByYW5kUHJvYlByaW1lKGspIGZvciBwcm9iYWJsZSBwcmltZXNcbi8vICAgLSB1bnJvbGxlZCBsb29wIGluIG1vbnRfIChzbGlnaHRseSBmYXN0ZXIpXG4vLyAgIC0gbWlsbGVyUmFiaW4gbm93IHRha2VzIGEgYmlnSW50IHBhcmFtZXRlciByYXRoZXIgdGhhbiBhbiBpbnRcbi8vXG4vLyB2IDUuMiAgMTUgU2VwIDIwMDlcbi8vICAgLSBmaXhlZCBjYXBpdGFsaXphdGlvbiBpbiBjYWxsIHRvIGludDJiaWdJbnQgaW4gcmFuZEJpZ0ludFxuLy8gICAgICh0aGFua3MgdG8gRW1pbGkgRXZyaXBpZG91LCBSZWluaG9sZCBCZWhyaW5nZXIsIGFuZCBTYW11ZWwgTWFjYWxlZXNlIGZvciBmaW5kaW5nIHRoYXQgYnVnKVxuLy9cbi8vIHYgNS4xICA4IE9jdCAyMDA3XG4vLyAgIC0gcmVuYW1lZCBpbnZlcnNlTW9kSW50XyB0byBpbnZlcnNlTW9kSW50IHNpbmNlIGl0IGRvZXNuJ3QgY2hhbmdlIGl0cyBwYXJhbWV0ZXJzXG4vLyAgIC0gYWRkZWQgZnVuY3Rpb25zIEdDRCBhbmQgcmFuZEJpZ0ludCwgd2hpY2ggY2FsbCBHQ0RfIGFuZCByYW5kQmlnSW50X1xuLy8gICAtIGZpeGVkIGEgYnVnIGZvdW5kIGJ5IFJvYiBWaXNzZXIgKHNlZSBjb21tZW50IHdpdGggaGlzIG5hbWUgYmVsb3cpXG4vLyAgIC0gaW1wcm92ZWQgY29tbWVudHNcbi8vXG4vLyBUaGlzIGZpbGUgaXMgcHVibGljIGRvbWFpbi4gICBZb3UgY2FuIHVzZSBpdCBmb3IgYW55IHB1cnBvc2Ugd2l0aG91dCByZXN0cmljdGlvbi5cbi8vIEkgZG8gbm90IGd1YXJhbnRlZSB0aGF0IGl0IGlzIGNvcnJlY3QsIHNvIHVzZSBpdCBhdCB5b3VyIG93biByaXNrLiAgSWYgeW91IHVzZVxuLy8gaXQgZm9yIHNvbWV0aGluZyBpbnRlcmVzdGluZywgSSdkIGFwcHJlY2lhdGUgaGVhcmluZyBhYm91dCBpdC4gIElmIHlvdSBmaW5kXG4vLyBhbnkgYnVncyBvciBtYWtlIGFueSBpbXByb3ZlbWVudHMsIEknZCBhcHByZWNpYXRlIGhlYXJpbmcgYWJvdXQgdGhvc2UgdG9vLlxuLy8gSXQgd291bGQgYWxzbyBiZSBuaWNlIGlmIG15IG5hbWUgYW5kIFVSTCB3ZXJlIGxlZnQgaW4gdGhlIGNvbW1lbnRzLiAgQnV0IG5vbmVcbi8vIG9mIHRoYXQgaXMgcmVxdWlyZWQuXG4vL1xuLy8gVGhpcyBjb2RlIGRlZmluZXMgYSBiaWdJbnQgbGlicmFyeSBmb3IgYXJiaXRyYXJ5LXByZWNpc2lvbiBpbnRlZ2Vycy5cbi8vIEEgYmlnSW50IGlzIGFuIGFycmF5IG9mIGludGVnZXJzIHN0b3JpbmcgdGhlIHZhbHVlIGluIGNodW5rcyBvZiBicGUgYml0cyxcbi8vIGxpdHRsZSBlbmRpYW4gKGJ1ZmZbMF0gaXMgdGhlIGxlYXN0IHNpZ25pZmljYW50IHdvcmQpLlxuLy8gTmVnYXRpdmUgYmlnSW50cyBhcmUgc3RvcmVkIHR3bydzIGNvbXBsZW1lbnQuICBBbG1vc3QgYWxsIHRoZSBmdW5jdGlvbnMgdHJlYXRcbi8vIGJpZ0ludHMgYXMgbm9ubmVnYXRpdmUuICBUaGUgZmV3IHRoYXQgdmlldyB0aGVtIGFzIHR3bydzIGNvbXBsZW1lbnQgc2F5IHNvXG4vLyBpbiB0aGVpciBjb21tZW50cy4gIFNvbWUgZnVuY3Rpb25zIGFzc3VtZSB0aGVpciBwYXJhbWV0ZXJzIGhhdmUgYXQgbGVhc3Qgb25lXG4vLyBsZWFkaW5nIHplcm8gZWxlbWVudC4gRnVuY3Rpb25zIHdpdGggYW4gdW5kZXJzY29yZSBhdCB0aGUgZW5kIG9mIHRoZSBuYW1lIHB1dFxuLy8gdGhlaXIgYW5zd2VyIGludG8gb25lIG9mIHRoZSBhcnJheXMgcGFzc2VkIGluLCBhbmQgaGF2ZSB1bnByZWRpY3RhYmxlIGJlaGF2aW9yXG4vLyBpbiBjYXNlIG9mIG92ZXJmbG93LCBzbyB0aGUgY2FsbGVyIG11c3QgbWFrZSBzdXJlIHRoZSBhcnJheXMgYXJlIGJpZyBlbm91Z2ggdG9cbi8vIGhvbGQgdGhlIGFuc3dlci4gIEJ1dCB0aGUgYXZlcmFnZSB1c2VyIHNob3VsZCBuZXZlciBoYXZlIHRvIGNhbGwgYW55IG9mIHRoZVxuLy8gdW5kZXJzY29yZWQgZnVuY3Rpb25zLiAgRWFjaCBpbXBvcnRhbnQgdW5kZXJzY29yZWQgZnVuY3Rpb24gaGFzIGEgd3JhcHBlciBmdW5jdGlvblxuLy8gb2YgdGhlIHNhbWUgbmFtZSB3aXRob3V0IHRoZSB1bmRlcnNjb3JlIHRoYXQgdGFrZXMgY2FyZSBvZiB0aGUgZGV0YWlscyBmb3IgeW91LlxuLy8gRm9yIGVhY2ggdW5kZXJzY29yZWQgZnVuY3Rpb24gd2hlcmUgYSBwYXJhbWV0ZXIgaXMgbW9kaWZpZWQsIHRoYXQgc2FtZSB2YXJpYWJsZVxuLy8gbXVzdCBub3QgYmUgdXNlZCBhcyBhbm90aGVyIGFyZ3VtZW50IHRvby4gIFNvLCB5b3UgY2Fubm90IHNxdWFyZSB4IGJ5IGRvaW5nXG4vLyBtdWx0TW9kXyh4LHgsbikuICBZb3UgbXVzdCB1c2Ugc3F1YXJlTW9kXyh4LG4pIGluc3RlYWQsIG9yIGRvIHk9ZHVwKHgpOyBtdWx0TW9kXyh4LHksbikuXG4vLyBPciBzaW1wbHkgdXNlIHRoZSBtdWx0TW9kKHgseCxuKSBmdW5jdGlvbiB3aXRob3V0IHRoZSB1bmRlcnNjb3JlLCB3aGVyZVxuLy8gc3VjaCBpc3N1ZXMgbmV2ZXIgYXJpc2UsIGJlY2F1c2Ugbm9uLXVuZGVyc2NvcmVkIGZ1bmN0aW9ucyBuZXZlciBjaGFuZ2Vcbi8vIHRoZWlyIHBhcmFtZXRlcnM7IHRoZXkgYWx3YXlzIGFsbG9jYXRlIG5ldyBtZW1vcnkgZm9yIHRoZSBhbnN3ZXIgdGhhdCBpcyByZXR1cm5lZC5cbi8vXG4vLyBUaGVzZSBmdW5jdGlvbnMgYXJlIGRlc2lnbmVkIHRvIGF2b2lkIGZyZXF1ZW50IGR5bmFtaWMgbWVtb3J5IGFsbG9jYXRpb24gaW4gdGhlIGlubmVyIGxvb3AuXG4vLyBGb3IgbW9zdCBmdW5jdGlvbnMsIGlmIGl0IG5lZWRzIGEgQmlnSW50IGFzIGEgbG9jYWwgdmFyaWFibGUgaXQgd2lsbCBhY3R1YWxseSB1c2Vcbi8vIGEgZ2xvYmFsLCBhbmQgd2lsbCBvbmx5IGFsbG9jYXRlIHRvIGl0IG9ubHkgd2hlbiBpdCdzIG5vdCB0aGUgcmlnaHQgc2l6ZS4gIFRoaXMgZW5zdXJlc1xuLy8gdGhhdCB3aGVuIGEgZnVuY3Rpb24gaXMgY2FsbGVkIHJlcGVhdGVkbHkgd2l0aCBzYW1lLXNpemVkIHBhcmFtZXRlcnMsIGl0IG9ubHkgYWxsb2NhdGVzXG4vLyBtZW1vcnkgb24gdGhlIGZpcnN0IGNhbGwuXG4vL1xuLy8gTm90ZSB0aGF0IGZvciBjcnlwdG9ncmFwaGljIHB1cnBvc2VzLCB0aGUgY2FsbHMgdG8gTWF0aC5yYW5kb20oKSBtdXN0XG4vLyBiZSByZXBsYWNlZCB3aXRoIGNhbGxzIHRvIGEgYmV0dGVyIHBzZXVkb3JhbmRvbSBudW1iZXIgZ2VuZXJhdG9yLlxuLy9cbi8vIEluIHRoZSBmb2xsb3dpbmcsIFwiYmlnSW50XCIgbWVhbnMgYSBiaWdJbnQgd2l0aCBhdCBsZWFzdCBvbmUgbGVhZGluZyB6ZXJvIGVsZW1lbnQsXG4vLyBhbmQgXCJpbnRlZ2VyXCIgbWVhbnMgYSBub25uZWdhdGl2ZSBpbnRlZ2VyIGxlc3MgdGhhbiByYWRpeC4gIEluIHNvbWUgY2FzZXMsIGludGVnZXJcbi8vIGNhbiBiZSBuZWdhdGl2ZS4gIE5lZ2F0aXZlIGJpZ0ludHMgYXJlIDJzIGNvbXBsZW1lbnQuXG4vL1xuLy8gVGhlIGZvbGxvd2luZyBmdW5jdGlvbnMgZG8gbm90IG1vZGlmeSB0aGVpciBpbnB1dHMuXG4vLyBUaG9zZSByZXR1cm5pbmcgYSBiaWdJbnQsIHN0cmluZywgb3IgQXJyYXkgd2lsbCBkeW5hbWljYWxseSBhbGxvY2F0ZSBtZW1vcnkgZm9yIHRoYXQgdmFsdWUuXG4vLyBUaG9zZSByZXR1cm5pbmcgYSBib29sZWFuIHdpbGwgcmV0dXJuIHRoZSBpbnRlZ2VyIDAgKGZhbHNlKSBvciAxICh0cnVlKS5cbi8vIFRob3NlIHJldHVybmluZyBib29sZWFuIG9yIGludCB3aWxsIG5vdCBhbGxvY2F0ZSBtZW1vcnkgZXhjZXB0IHBvc3NpYmx5IG9uIHRoZSBmaXJzdFxuLy8gdGltZSB0aGV5J3JlIGNhbGxlZCB3aXRoIGEgZ2l2ZW4gcGFyYW1ldGVyIHNpemUuXG4vL1xuLy8gYmlnSW50ICBhZGQoeCx5KSAgICAgICAgICAgICAgIC8vcmV0dXJuICh4K3kpIGZvciBiaWdJbnRzIHggYW5kIHkuXG4vLyBiaWdJbnQgIGFkZEludCh4LG4pICAgICAgICAgICAgLy9yZXR1cm4gKHgrbikgd2hlcmUgeCBpcyBhIGJpZ0ludCBhbmQgbiBpcyBhbiBpbnRlZ2VyLlxuLy8gc3RyaW5nICBiaWdJbnQyc3RyKHgsYmFzZSkgICAgIC8vcmV0dXJuIGEgc3RyaW5nIGZvcm0gb2YgYmlnSW50IHggaW4gYSBnaXZlbiBiYXNlLCB3aXRoIDIgPD0gYmFzZSA8PSA5NVxuLy8gaW50ICAgICBiaXRTaXplKHgpICAgICAgICAgICAgIC8vcmV0dXJuIGhvdyBtYW55IGJpdHMgbG9uZyB0aGUgYmlnSW50IHggaXMsIG5vdCBjb3VudGluZyBsZWFkaW5nIHplcm9zXG4vLyBiaWdJbnQgIGR1cCh4KSAgICAgICAgICAgICAgICAgLy9yZXR1cm4gYSBjb3B5IG9mIGJpZ0ludCB4XG4vLyBib29sZWFuIGVxdWFscyh4LHkpICAgICAgICAgICAgLy9pcyB0aGUgYmlnSW50IHggZXF1YWwgdG8gdGhlIGJpZ2ludCB5P1xuLy8gYm9vbGVhbiBlcXVhbHNJbnQoeCx5KSAgICAgICAgIC8vaXMgYmlnaW50IHggZXF1YWwgdG8gaW50ZWdlciB5P1xuLy8gYmlnSW50ICBleHBhbmQoeCxuKSAgICAgICAgICAgIC8vcmV0dXJuIGEgY29weSBvZiB4IHdpdGggYXQgbGVhc3QgbiBlbGVtZW50cywgYWRkaW5nIGxlYWRpbmcgemVyb3MgaWYgbmVlZGVkXG4vLyBBcnJheSAgIGZpbmRQcmltZXMobikgICAgICAgICAgLy9yZXR1cm4gYXJyYXkgb2YgYWxsIHByaW1lcyBsZXNzIHRoYW4gaW50ZWdlciBuXG4vLyBiaWdJbnQgIEdDRCh4LHkpICAgICAgICAgICAgICAgLy9yZXR1cm4gZ3JlYXRlc3QgY29tbW9uIGRpdmlzb3Igb2YgYmlnSW50cyB4IGFuZCB5IChlYWNoIHdpdGggc2FtZSBudW1iZXIgb2YgZWxlbWVudHMpLlxuLy8gYm9vbGVhbiBncmVhdGVyKHgseSkgICAgICAgICAgIC8vaXMgeD55PyAgKHggYW5kIHkgYXJlIG5vbm5lZ2F0aXZlIGJpZ0ludHMpXG4vLyBib29sZWFuIGdyZWF0ZXJTaGlmdCh4LHksc2hpZnQpLy9pcyAoeCA8PChzaGlmdCpicGUpKSA+IHk/XG4vLyBiaWdJbnQgIGludDJiaWdJbnQodCxuLG0pICAgICAgLy9yZXR1cm4gYSBiaWdJbnQgZXF1YWwgdG8gaW50ZWdlciB0LCB3aXRoIGF0IGxlYXN0IG4gYml0cyBhbmQgbSBhcnJheSBlbGVtZW50c1xuLy8gYmlnSW50ICBpbnZlcnNlTW9kKHgsbikgICAgICAgIC8vcmV0dXJuICh4KiooLTEpIG1vZCBuKSBmb3IgYmlnSW50cyB4IGFuZCBuLiAgSWYgbm8gaW52ZXJzZSBleGlzdHMsIGl0IHJldHVybnMgbnVsbFxuLy8gaW50ICAgICBpbnZlcnNlTW9kSW50KHgsbikgICAgIC8vcmV0dXJuIHgqKigtMSkgbW9kIG4sIGZvciBpbnRlZ2VycyB4IGFuZCBuLiAgUmV0dXJuIDAgaWYgdGhlcmUgaXMgbm8gaW52ZXJzZVxuLy8gYm9vbGVhbiBpc1plcm8oeCkgICAgICAgICAgICAgIC8vaXMgdGhlIGJpZ0ludCB4IGVxdWFsIHRvIHplcm8/XG4vLyBib29sZWFuIG1pbGxlclJhYmluKHgsYikgICAgICAgLy9kb2VzIG9uZSByb3VuZCBvZiBNaWxsZXItUmFiaW4gYmFzZSBpbnRlZ2VyIGIgc2F5IHRoYXQgYmlnSW50IHggaXMgcG9zc2libHkgcHJpbWU/IChiIGlzIGJpZ0ludCwgMTxiPHgpXG4vLyBib29sZWFuIG1pbGxlclJhYmluSW50KHgsYikgICAgLy9kb2VzIG9uZSByb3VuZCBvZiBNaWxsZXItUmFiaW4gYmFzZSBpbnRlZ2VyIGIgc2F5IHRoYXQgYmlnSW50IHggaXMgcG9zc2libHkgcHJpbWU/IChiIGlzIGludCwgICAgMTxiPHgpXG4vLyBiaWdJbnQgIG1vZCh4LG4pICAgICAgICAgICAgICAgLy9yZXR1cm4gYSBuZXcgYmlnSW50IGVxdWFsIHRvICh4IG1vZCBuKSBmb3IgYmlnSW50cyB4IGFuZCBuLlxuLy8gaW50ICAgICBtb2RJbnQoeCxuKSAgICAgICAgICAgIC8vcmV0dXJuIHggbW9kIG4gZm9yIGJpZ0ludCB4IGFuZCBpbnRlZ2VyIG4uXG4vLyBiaWdJbnQgIG11bHQoeCx5KSAgICAgICAgICAgICAgLy9yZXR1cm4geCp5IGZvciBiaWdJbnRzIHggYW5kIHkuIFRoaXMgaXMgZmFzdGVyIHdoZW4geTx4LlxuLy8gYmlnSW50ICBtdWx0TW9kKHgseSxuKSAgICAgICAgIC8vcmV0dXJuICh4KnkgbW9kIG4pIGZvciBiaWdJbnRzIHgseSxuLiAgRm9yIGdyZWF0ZXIgc3BlZWQsIGxldCB5PHguXG4vLyBib29sZWFuIG5lZ2F0aXZlKHgpICAgICAgICAgICAgLy9pcyBiaWdJbnQgeCBuZWdhdGl2ZT9cbi8vIGJpZ0ludCAgcG93TW9kKHgseSxuKSAgICAgICAgICAvL3JldHVybiAoeCoqeSBtb2Qgbikgd2hlcmUgeCx5LG4gYXJlIGJpZ0ludHMgYW5kICoqIGlzIGV4cG9uZW50aWF0aW9uLiAgMCoqMD0xLiBGYXN0ZXIgZm9yIG9kZCBuLlxuLy8gYmlnSW50ICByYW5kQmlnSW50KG4scykgICAgICAgIC8vcmV0dXJuIGFuIG4tYml0IHJhbmRvbSBCaWdJbnQgKG4+PTEpLiAgSWYgcz0xLCB0aGVuIHRoZSBtb3N0IHNpZ25pZmljYW50IG9mIHRob3NlIG4gYml0cyBpcyBzZXQgdG8gMS5cbi8vIGJpZ0ludCAgcmFuZFRydWVQcmltZShrKSAgICAgICAvL3JldHVybiBhIG5ldywgcmFuZG9tLCBrLWJpdCwgdHJ1ZSBwcmltZSBiaWdJbnQgdXNpbmcgTWF1cmVyJ3MgYWxnb3JpdGhtLlxuLy8gYmlnSW50ICByYW5kUHJvYlByaW1lKGspICAgICAgIC8vcmV0dXJuIGEgbmV3LCByYW5kb20sIGstYml0LCBwcm9iYWJsZSBwcmltZSBiaWdJbnQgKHByb2JhYmlsaXR5IGl0J3MgY29tcG9zaXRlIGxlc3MgdGhhbiAyXi04MCkuXG4vLyBiaWdJbnQgIHN0cjJiaWdJbnQocyxiLG4sbSkgICAgLy9yZXR1cm4gYSBiaWdJbnQgZm9yIG51bWJlciByZXByZXNlbnRlZCBpbiBzdHJpbmcgcyBpbiBiYXNlIGIgd2l0aCBhdCBsZWFzdCBuIGJpdHMgYW5kIG0gYXJyYXkgZWxlbWVudHNcbi8vIGJpZ0ludCAgc3ViKHgseSkgICAgICAgICAgICAgICAvL3JldHVybiAoeC15KSBmb3IgYmlnSW50cyB4IGFuZCB5LiAgTmVnYXRpdmUgYW5zd2VycyB3aWxsIGJlIDJzIGNvbXBsZW1lbnRcbi8vIGJpZ0ludCAgdHJpbSh4LGspICAgICAgICAgICAgICAvL3JldHVybiBhIGNvcHkgb2YgeCB3aXRoIGV4YWN0bHkgayBsZWFkaW5nIHplcm8gZWxlbWVudHNcbi8vXG4vL1xuLy8gVGhlIGZvbGxvd2luZyBmdW5jdGlvbnMgZWFjaCBoYXZlIGEgbm9uLXVuZGVyc2NvcmVkIHZlcnNpb24sIHdoaWNoIG1vc3QgdXNlcnMgc2hvdWxkIGNhbGwgaW5zdGVhZC5cbi8vIFRoZXNlIGZ1bmN0aW9ucyBlYWNoIHdyaXRlIHRvIGEgc2luZ2xlIHBhcmFtZXRlciwgYW5kIHRoZSBjYWxsZXIgaXMgcmVzcG9uc2libGUgZm9yIGVuc3VyaW5nIHRoZSBhcnJheVxuLy8gcGFzc2VkIGluIGlzIGxhcmdlIGVub3VnaCB0byBob2xkIHRoZSByZXN1bHQuXG4vL1xuLy8gdm9pZCAgICBhZGRJbnRfKHgsbikgICAgICAgICAgLy9kbyB4PXgrbiB3aGVyZSB4IGlzIGEgYmlnSW50IGFuZCBuIGlzIGFuIGludGVnZXJcbi8vIHZvaWQgICAgYWRkXyh4LHkpICAgICAgICAgICAgIC8vZG8geD14K3kgZm9yIGJpZ0ludHMgeCBhbmQgeVxuLy8gdm9pZCAgICBjb3B5Xyh4LHkpICAgICAgICAgICAgLy9kbyB4PXkgb24gYmlnSW50cyB4IGFuZCB5XG4vLyB2b2lkICAgIGNvcHlJbnRfKHgsbikgICAgICAgICAvL2RvIHg9biBvbiBiaWdJbnQgeCBhbmQgaW50ZWdlciBuXG4vLyB2b2lkICAgIEdDRF8oeCx5KSAgICAgICAgICAgICAvL3NldCB4IHRvIHRoZSBncmVhdGVzdCBjb21tb24gZGl2aXNvciBvZiBiaWdJbnRzIHggYW5kIHksICh5IGlzIGRlc3Ryb3llZCkuICAoVGhpcyBuZXZlciBvdmVyZmxvd3MgaXRzIGFycmF5KS5cbi8vIGJvb2xlYW4gaW52ZXJzZU1vZF8oeCxuKSAgICAgIC8vZG8geD14KiooLTEpIG1vZCBuLCBmb3IgYmlnSW50cyB4IGFuZCBuLiBSZXR1cm5zIDEgKDApIGlmIGludmVyc2UgZG9lcyAoZG9lc24ndCkgZXhpc3Rcbi8vIHZvaWQgICAgbW9kXyh4LG4pICAgICAgICAgICAgIC8vZG8geD14IG1vZCBuIGZvciBiaWdJbnRzIHggYW5kIG4uIChUaGlzIG5ldmVyIG92ZXJmbG93cyBpdHMgYXJyYXkpLlxuLy8gdm9pZCAgICBtdWx0Xyh4LHkpICAgICAgICAgICAgLy9kbyB4PXgqeSBmb3IgYmlnSW50cyB4IGFuZCB5LlxuLy8gdm9pZCAgICBtdWx0TW9kXyh4LHksbikgICAgICAgLy9kbyB4PXgqeSAgbW9kIG4gZm9yIGJpZ0ludHMgeCx5LG4uXG4vLyB2b2lkICAgIHBvd01vZF8oeCx5LG4pICAgICAgICAvL2RvIHg9eCoqeSBtb2Qgbiwgd2hlcmUgeCx5LG4gYXJlIGJpZ0ludHMgKG4gaXMgb2RkKSBhbmQgKiogaXMgZXhwb25lbnRpYXRpb24uICAwKiowPTEuXG4vLyB2b2lkICAgIHJhbmRCaWdJbnRfKGIsbixzKSAgICAvL2RvIGIgPSBhbiBuLWJpdCByYW5kb20gQmlnSW50LiBpZiBzPTEsIHRoZW4gbnRoIGJpdCAobW9zdCBzaWduaWZpY2FudCBiaXQpIGlzIHNldCB0byAxLiBuPj0xLlxuLy8gdm9pZCAgICByYW5kVHJ1ZVByaW1lXyhhbnMsaykgLy9kbyBhbnMgPSBhIHJhbmRvbSBrLWJpdCB0cnVlIHJhbmRvbSBwcmltZSAobm90IGp1c3QgcHJvYmFibGUgcHJpbWUpIHdpdGggMSBpbiB0aGUgbXNiLlxuLy8gdm9pZCAgICBzdWJfKHgseSkgICAgICAgICAgICAgLy9kbyB4PXgteSBmb3IgYmlnSW50cyB4IGFuZCB5LiBOZWdhdGl2ZSBhbnN3ZXJzIHdpbGwgYmUgMnMgY29tcGxlbWVudC5cbi8vXG4vLyBUaGUgZm9sbG93aW5nIGZ1bmN0aW9ucyBkbyBOT1QgaGF2ZSBhIG5vbi11bmRlcnNjb3JlZCB2ZXJzaW9uLlxuLy8gVGhleSBlYWNoIHdyaXRlIGEgYmlnSW50IHJlc3VsdCB0byBvbmUgb3IgbW9yZSBwYXJhbWV0ZXJzLiAgVGhlIGNhbGxlciBpcyByZXNwb25zaWJsZSBmb3Jcbi8vIGVuc3VyaW5nIHRoZSBhcnJheXMgcGFzc2VkIGluIGFyZSBsYXJnZSBlbm91Z2ggdG8gaG9sZCB0aGUgcmVzdWx0cy5cbi8vXG4vLyB2b2lkIGFkZFNoaWZ0Xyh4LHkseXMpICAgICAgIC8vZG8geD14Kyh5PDwoeXMqYnBlKSlcbi8vIHZvaWQgY2FycnlfKHgpICAgICAgICAgICAgICAgLy9kbyBjYXJyaWVzIGFuZCBib3Jyb3dzIHNvIGVhY2ggZWxlbWVudCBvZiB0aGUgYmlnSW50IHggZml0cyBpbiBicGUgYml0cy5cbi8vIHZvaWQgZGl2aWRlXyh4LHkscSxyKSAgICAgICAgLy9kaXZpZGUgeCBieSB5IGdpdmluZyBxdW90aWVudCBxIGFuZCByZW1haW5kZXIgclxuLy8gaW50ICBkaXZJbnRfKHgsbikgICAgICAgICAgICAvL2RvIHg9Zmxvb3IoeC9uKSBmb3IgYmlnSW50IHggYW5kIGludGVnZXIgbiwgYW5kIHJldHVybiB0aGUgcmVtYWluZGVyLiAoVGhpcyBuZXZlciBvdmVyZmxvd3MgaXRzIGFycmF5KS5cbi8vIGludCAgZUdDRF8oeCx5LGQsYSxiKSAgICAgICAgLy9zZXRzIGEsYixkIHRvIHBvc2l0aXZlIGJpZ0ludHMgc3VjaCB0aGF0IGQgPSBHQ0RfKHgseSkgPSBhKngtYip5XG4vLyB2b2lkIGhhbHZlXyh4KSAgICAgICAgICAgICAgIC8vZG8geD1mbG9vcih8eHwvMikqc2duKHgpIGZvciBiaWdJbnQgeCBpbiAyJ3MgY29tcGxlbWVudC4gIChUaGlzIG5ldmVyIG92ZXJmbG93cyBpdHMgYXJyYXkpLlxuLy8gdm9pZCBsZWZ0U2hpZnRfKHgsbikgICAgICAgICAvL2xlZnQgc2hpZnQgYmlnSW50IHggYnkgbiBiaXRzLiAgbjxicGUuXG4vLyB2b2lkIGxpbkNvbWJfKHgseSxhLGIpICAgICAgIC8vZG8geD1hKngrYip5IGZvciBiaWdJbnRzIHggYW5kIHkgYW5kIGludGVnZXJzIGEgYW5kIGJcbi8vIHZvaWQgbGluQ29tYlNoaWZ0Xyh4LHksYix5cykgLy9kbyB4PXgrYiooeTw8KHlzKmJwZSkpIGZvciBiaWdJbnRzIHggYW5kIHksIGFuZCBpbnRlZ2VycyBiIGFuZCB5c1xuLy8gdm9pZCBtb250Xyh4LHksbixucCkgICAgICAgICAvL01vbnRnb21lcnkgbXVsdGlwbGljYXRpb24gKHNlZSBjb21tZW50cyB3aGVyZSB0aGUgZnVuY3Rpb24gaXMgZGVmaW5lZClcbi8vIHZvaWQgbXVsdEludF8oeCxuKSAgICAgICAgICAgLy9kbyB4PXgqbiB3aGVyZSB4IGlzIGEgYmlnSW50IGFuZCBuIGlzIGFuIGludGVnZXIuXG4vLyB2b2lkIHJpZ2h0U2hpZnRfKHgsbikgICAgICAgIC8vcmlnaHQgc2hpZnQgYmlnSW50IHggYnkgbiBiaXRzLiAgMCA8PSBuIDwgYnBlLiAoVGhpcyBuZXZlciBvdmVyZmxvd3MgaXRzIGFycmF5KS5cbi8vIHZvaWQgc3F1YXJlTW9kXyh4LG4pICAgICAgICAgLy9kbyB4PXgqeCAgbW9kIG4gZm9yIGJpZ0ludHMgeCxuXG4vLyB2b2lkIHN1YlNoaWZ0Xyh4LHkseXMpICAgICAgIC8vZG8geD14LSh5PDwoeXMqYnBlKSkuIE5lZ2F0aXZlIGFuc3dlcnMgd2lsbCBiZSAycyBjb21wbGVtZW50LlxuLy9cbi8vIFRoZSBmb2xsb3dpbmcgZnVuY3Rpb25zIGFyZSBiYXNlZCBvbiBhbGdvcml0aG1zIGZyb20gdGhlIF9IYW5kYm9vayBvZiBBcHBsaWVkIENyeXB0b2dyYXBoeV9cbi8vICAgIHBvd01vZF8oKSAgICAgICAgICAgPSBhbGdvcml0aG0gMTQuOTQsIE1vbnRnb21lcnkgZXhwb25lbnRpYXRpb25cbi8vICAgIGVHQ0RfLGludmVyc2VNb2RfKCkgPSBhbGdvcml0aG0gMTQuNjEsIEJpbmFyeSBleHRlbmRlZCBHQ0RfXG4vLyAgICBHQ0RfKCkgICAgICAgICAgICAgID0gYWxnb3JvdGhtIDE0LjU3LCBMZWhtZXIncyBhbGdvcml0aG1cbi8vICAgIG1vbnRfKCkgICAgICAgICAgICAgPSBhbGdvcml0aG0gMTQuMzYsIE1vbnRnb21lcnkgbXVsdGlwbGljYXRpb25cbi8vICAgIGRpdmlkZV8oKSAgICAgICAgICAgPSBhbGdvcml0aG0gMTQuMjAgIE11bHRpcGxlLXByZWNpc2lvbiBkaXZpc2lvblxuLy8gICAgc3F1YXJlTW9kXygpICAgICAgICA9IGFsZ29yaXRobSAxNC4xNiAgTXVsdGlwbGUtcHJlY2lzaW9uIHNxdWFyaW5nXG4vLyAgICByYW5kVHJ1ZVByaW1lXygpICAgID0gYWxnb3JpdGhtICA0LjYyLCBNYXVyZXIncyBhbGdvcml0aG1cbi8vICAgIG1pbGxlclJhYmluKCkgICAgICAgPSBhbGdvcml0aG0gIDQuMjQsIE1pbGxlci1SYWJpbiBhbGdvcml0aG1cbi8vXG4vLyBQcm9maWxpbmcgc2hvd3M6XG4vLyAgICAgcmFuZFRydWVQcmltZV8oKSBzcGVuZHM6XG4vLyAgICAgICAgIDEwJSBvZiBpdHMgdGltZSBpbiBjYWxscyB0byBwb3dNb2RfKClcbi8vICAgICAgICAgODUlIG9mIGl0cyB0aW1lIGluIGNhbGxzIHRvIG1pbGxlclJhYmluKClcbi8vICAgICBtaWxsZXJSYWJpbigpIHNwZW5kczpcbi8vICAgICAgICAgOTklIG9mIGl0cyB0aW1lIGluIGNhbGxzIHRvIHBvd01vZF8oKSAgIChhbHdheXMgd2l0aCBhIGJhc2Ugb2YgMilcbi8vICAgICBwb3dNb2RfKCkgc3BlbmRzOlxuLy8gICAgICAgICA5NCUgb2YgaXRzIHRpbWUgaW4gY2FsbHMgdG8gbW9udF8oKSAgKGFsbW9zdCBhbHdheXMgd2l0aCB4PT15KVxuLy9cbi8vIFRoaXMgc3VnZ2VzdHMgdGhlcmUgYXJlIHNldmVyYWwgd2F5cyB0byBzcGVlZCB1cCB0aGlzIGxpYnJhcnkgc2xpZ2h0bHk6XG4vLyAgICAgLSBjb252ZXJ0IHBvd01vZF8gdG8gdXNlIGEgTW9udGdvbWVyeSBmb3JtIG9mIGstYXJ5IHdpbmRvdyAob3IgbWF5YmUgYSBNb250Z29tZXJ5IGZvcm0gb2Ygc2xpZGluZyB3aW5kb3cpXG4vLyAgICAgICAgIC0tIHRoaXMgc2hvdWxkIGVzcGVjaWFsbHkgZm9jdXMgb24gYmVpbmcgZmFzdCB3aGVuIHJhaXNpbmcgMiB0byBhIHBvd2VyIG1vZCBuXG4vLyAgICAgLSBjb252ZXJ0IHJhbmRUcnVlUHJpbWVfKCkgdG8gdXNlIGEgbWluaW11bSByIG9mIDEvMyBpbnN0ZWFkIG9mIDEvMiB3aXRoIHRoZSBhcHByb3ByaWF0ZSBjaGFuZ2UgdG8gdGhlIHRlc3Rcbi8vICAgICAtIHR1bmUgdGhlIHBhcmFtZXRlcnMgaW4gcmFuZFRydWVQcmltZV8oKSwgaW5jbHVkaW5nIGMsIG0sIGFuZCByZWNMaW1pdFxuLy8gICAgIC0gc3BlZWQgdXAgdGhlIHNpbmdsZSBsb29wIGluIG1vbnRfKCkgdGhhdCB0YWtlcyA5NSUgb2YgdGhlIHJ1bnRpbWUsIHBlcmhhcHMgYnkgcmVkdWNpbmcgY2hlY2tpbmdcbi8vICAgICAgIHdpdGhpbiB0aGUgbG9vcCB3aGVuIGFsbCB0aGUgcGFyYW1ldGVycyBhcmUgdGhlIHNhbWUgbGVuZ3RoLlxuLy9cbi8vIFRoZXJlIGFyZSBzZXZlcmFsIGlkZWFzIHRoYXQgbG9vayBsaWtlIHRoZXkgd291bGRuJ3QgaGVscCBtdWNoIGF0IGFsbDpcbi8vICAgICAtIHJlcGxhY2luZyB0cmlhbCBkaXZpc2lvbiBpbiByYW5kVHJ1ZVByaW1lXygpIHdpdGggYSBzaWV2ZSAodGhhdCBzcGVlZHMgdXAgc29tZXRoaW5nIHRha2luZyBhbG1vc3Qgbm8gdGltZSBhbnl3YXkpXG4vLyAgICAgLSBpbmNyZWFzZSBicGUgZnJvbSAxNSB0byAzMCAodGhhdCB3b3VsZCBoZWxwIGlmIHdlIGhhZCBhIDMyKjMyLT42NCBtdWx0aXBsaWVyLCBidXQgbm90IHdpdGggSmF2YVNjcmlwdCdzIDMyKjMyLT4zMilcbi8vICAgICAtIHNwZWVkaW5nIHVwIG1vbnRfKHgseSxuLG5wKSB3aGVuIHg9PXkgYnkgZG9pbmcgYSBub24tbW9kdWxhciwgbm9uLU1vbnRnb21lcnkgc3F1YXJlXG4vLyAgICAgICBmb2xsb3dlZCBieSBhIE1vbnRnb21lcnkgcmVkdWN0aW9uLiAgVGhlIGludGVybWVkaWF0ZSBhbnN3ZXIgd2lsbCBiZSB0d2ljZSBhcyBsb25nIGFzIHgsIHNvIHRoYXRcbi8vICAgICAgIG1ldGhvZCB3b3VsZCBiZSBzbG93ZXIuICBUaGlzIGlzIHVuZm9ydHVuYXRlIGJlY2F1c2UgdGhlIGNvZGUgY3VycmVudGx5IHNwZW5kcyBhbG1vc3QgYWxsIG9mIGl0cyB0aW1lXG4vLyAgICAgICBkb2luZyBtb250Xyh4LHgsLi4uKSwgYm90aCBmb3IgcmFuZFRydWVQcmltZV8oKSBhbmQgcG93TW9kXygpLiAgQSBmYXN0ZXIgbWV0aG9kIGZvciBNb250Z29tZXJ5IHNxdWFyaW5nXG4vLyAgICAgICB3b3VsZCBoYXZlIGEgbGFyZ2UgaW1wYWN0IG9uIHRoZSBzcGVlZCBvZiByYW5kVHJ1ZVByaW1lXygpIGFuZCBwb3dNb2RfKCkuICBIQUMgaGFzIGEgY291cGxlIG9mIHBvb3JseS13b3JkZWRcbi8vICAgICAgIHNlbnRlbmNlcyB0aGF0IHNlZW0gdG8gaW1wbHkgaXQncyBmYXN0ZXIgdG8gZG8gYSBub24tbW9kdWxhciBzcXVhcmUgZm9sbG93ZWQgYnkgYSBzaW5nbGVcbi8vICAgICAgIE1vbnRnb21lcnkgcmVkdWN0aW9uLCBidXQgdGhhdCdzIG9idmlvdXNseSB3cm9uZy5cbi8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cblxuKGZ1bmN0aW9uICgpIHtcbi8vZ2xvYmFsc1xuYnBlPTA7ICAgICAgICAgLy9iaXRzIHN0b3JlZCBwZXIgYXJyYXkgZWxlbWVudFxubWFzaz0wOyAgICAgICAgLy9BTkQgdGhpcyB3aXRoIGFuIGFycmF5IGVsZW1lbnQgdG8gY2hvcCBpdCBkb3duIHRvIGJwZSBiaXRzXG5yYWRpeD1tYXNrKzE7ICAvL2VxdWFscyAyXmJwZS4gIEEgc2luZ2xlIDEgYml0IHRvIHRoZSBsZWZ0IG9mIHRoZSBsYXN0IGJpdCBvZiBtYXNrLlxuXG4vL3RoZSBkaWdpdHMgZm9yIGNvbnZlcnRpbmcgdG8gZGlmZmVyZW50IGJhc2VzXG5kaWdpdHNTdHI9JzAxMjM0NTY3ODlBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWmFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6Xz0hQCMkJV4mKigpW117fXw7OiwuPD4vP2B+IFxcXFxcXCdcXFwiKy0nO1xuXG4vL2luaXRpYWxpemUgdGhlIGdsb2JhbCB2YXJpYWJsZXNcbmZvciAoYnBlPTA7ICgxPDwoYnBlKzEpKSA+ICgxPDxicGUpOyBicGUrKyk7ICAvL2JwZT1udW1iZXIgb2YgYml0cyBpbiB0aGUgbWFudGlzc2Egb24gdGhpcyBwbGF0Zm9ybVxuYnBlPj49MTsgICAgICAgICAgICAgICAgICAgLy9icGU9bnVtYmVyIG9mIGJpdHMgaW4gb25lIGVsZW1lbnQgb2YgdGhlIGFycmF5IHJlcHJlc2VudGluZyB0aGUgYmlnSW50XG5tYXNrPSgxPDxicGUpLTE7ICAgICAgICAgICAvL0FORCB0aGUgbWFzayB3aXRoIGFuIGludGVnZXIgdG8gZ2V0IGl0cyBicGUgbGVhc3Qgc2lnbmlmaWNhbnQgYml0c1xucmFkaXg9bWFzaysxOyAgICAgICAgICAgICAgLy8yXmJwZS4gIGEgc2luZ2xlIDEgYml0IHRvIHRoZSBsZWZ0IG9mIHRoZSBmaXJzdCBiaXQgb2YgbWFza1xub25lPWludDJiaWdJbnQoMSwxLDEpOyAgICAgLy9jb25zdGFudCB1c2VkIGluIHBvd01vZF8oKVxuXG4vL3RoZSBmb2xsb3dpbmcgZ2xvYmFsIHZhcmlhYmxlcyBhcmUgc2NyYXRjaHBhZCBtZW1vcnkgdG9cbi8vcmVkdWNlIGR5bmFtaWMgbWVtb3J5IGFsbG9jYXRpb24gaW4gdGhlIGlubmVyIGxvb3BcbnQ9bmV3IEFycmF5KDApO1xuc3M9dDsgICAgICAgLy91c2VkIGluIG11bHRfKClcbnMwPXQ7ICAgICAgIC8vdXNlZCBpbiBtdWx0TW9kXygpLCBzcXVhcmVNb2RfKClcbnMxPXQ7ICAgICAgIC8vdXNlZCBpbiBwb3dNb2RfKCksIG11bHRNb2RfKCksIHNxdWFyZU1vZF8oKVxuczI9dDsgICAgICAgLy91c2VkIGluIHBvd01vZF8oKSwgbXVsdE1vZF8oKVxuczM9dDsgICAgICAgLy91c2VkIGluIHBvd01vZF8oKVxuczQ9dDsgczU9dDsgLy91c2VkIGluIG1vZF8oKVxuczY9dDsgICAgICAgLy91c2VkIGluIGJpZ0ludDJzdHIoKVxuczc9dDsgICAgICAgLy91c2VkIGluIHBvd01vZF8oKVxuVD10OyAgICAgICAgLy91c2VkIGluIEdDRF8oKVxuc2E9dDsgICAgICAgLy91c2VkIGluIG1vbnRfKClcbm1yX3gxPXQ7IG1yX3I9dDsgbXJfYT10OyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy91c2VkIGluIG1pbGxlclJhYmluKClcbmVnX3Y9dDsgZWdfdT10OyBlZ19BPXQ7IGVnX0I9dDsgZWdfQz10OyBlZ19EPXQ7ICAgICAgICAgICAgICAgLy91c2VkIGluIGVHQ0RfKCksIGludmVyc2VNb2RfKClcbm1kX3ExPXQ7IG1kX3EyPXQ7IG1kX3EzPXQ7IG1kX3I9dDsgbWRfcjE9dDsgbWRfcjI9dDsgbWRfdHQ9dDsgLy91c2VkIGluIG1vZF8oKVxuXG5wcmltZXM9dDsgcG93cz10OyBzX2k9dDsgc19pMj10OyBzX1I9dDsgc19ybT10OyBzX3E9dDsgc19uMT10O1xuICBzX2E9dDsgc19yMj10OyBzX249dDsgc19iPXQ7IHNfZD10OyBzX3gxPXQ7IHNfeDI9dCwgc19hYT10OyAvL3VzZWQgaW4gcmFuZFRydWVQcmltZV8oKVxuXG5ycHByYj10OyAvL3VzZWQgaW4gcmFuZFByb2JQcmltZVJvdW5kcygpICh3aGljaCBhbHNvIHVzZXMgXCJwcmltZXNcIilcblxuLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuXG5cbi8vcmV0dXJuIGFycmF5IG9mIGFsbCBwcmltZXMgbGVzcyB0aGFuIGludGVnZXIgblxuZnVuY3Rpb24gZmluZFByaW1lcyhuKSB7XG4gIHZhciBpLHMscCxhbnM7XG4gIHM9bmV3IEFycmF5KG4pO1xuICBmb3IgKGk9MDtpPG47aSsrKVxuICAgIHNbaV09MDtcbiAgc1swXT0yO1xuICBwPTA7ICAgIC8vZmlyc3QgcCBlbGVtZW50cyBvZiBzIGFyZSBwcmltZXMsIHRoZSByZXN0IGFyZSBhIHNpZXZlXG4gIGZvcig7c1twXTxuOykgeyAgICAgICAgICAgICAgICAgIC8vc1twXSBpcyB0aGUgcHRoIHByaW1lXG4gICAgZm9yKGk9c1twXSpzW3BdOyBpPG47IGkrPXNbcF0pIC8vbWFyayBtdWx0aXBsZXMgb2Ygc1twXVxuICAgICAgc1tpXT0xO1xuICAgIHArKztcbiAgICBzW3BdPXNbcC0xXSsxO1xuICAgIGZvcig7IHNbcF08biAmJiBzW3NbcF1dOyBzW3BdKyspOyAvL2ZpbmQgbmV4dCBwcmltZSAod2hlcmUgc1twXT09MClcbiAgfVxuICBhbnM9bmV3IEFycmF5KHApO1xuICBmb3IoaT0wO2k8cDtpKyspXG4gICAgYW5zW2ldPXNbaV07XG4gIHJldHVybiBhbnM7XG59XG5cblxuLy9kb2VzIGEgc2luZ2xlIHJvdW5kIG9mIE1pbGxlci1SYWJpbiBiYXNlIGIgY29uc2lkZXIgeCB0byBiZSBhIHBvc3NpYmxlIHByaW1lP1xuLy94IGlzIGEgYmlnSW50LCBhbmQgYiBpcyBhbiBpbnRlZ2VyLCB3aXRoIGI8eFxuZnVuY3Rpb24gbWlsbGVyUmFiaW5JbnQoeCxiKSB7XG4gIGlmIChtcl94MS5sZW5ndGghPXgubGVuZ3RoKSB7XG4gICAgbXJfeDE9ZHVwKHgpO1xuICAgIG1yX3I9ZHVwKHgpO1xuICAgIG1yX2E9ZHVwKHgpO1xuICB9XG5cbiAgY29weUludF8obXJfYSxiKTtcbiAgcmV0dXJuIG1pbGxlclJhYmluKHgsbXJfYSk7XG59XG5cbi8vZG9lcyBhIHNpbmdsZSByb3VuZCBvZiBNaWxsZXItUmFiaW4gYmFzZSBiIGNvbnNpZGVyIHggdG8gYmUgYSBwb3NzaWJsZSBwcmltZT9cbi8veCBhbmQgYiBhcmUgYmlnSW50cyB3aXRoIGI8eFxuZnVuY3Rpb24gbWlsbGVyUmFiaW4oeCxiKSB7XG4gIHZhciBpLGosayxzO1xuXG4gIGlmIChtcl94MS5sZW5ndGghPXgubGVuZ3RoKSB7XG4gICAgbXJfeDE9ZHVwKHgpO1xuICAgIG1yX3I9ZHVwKHgpO1xuICAgIG1yX2E9ZHVwKHgpO1xuICB9XG5cbiAgY29weV8obXJfYSxiKTtcbiAgY29weV8obXJfcix4KTtcbiAgY29weV8obXJfeDEseCk7XG5cbiAgYWRkSW50Xyhtcl9yLC0xKTtcbiAgYWRkSW50Xyhtcl94MSwtMSk7XG5cbiAgLy9zPXRoZSBoaWdoZXN0IHBvd2VyIG9mIHR3byB0aGF0IGRpdmlkZXMgbXJfclxuICBrPTA7XG4gIGZvciAoaT0wO2k8bXJfci5sZW5ndGg7aSsrKVxuICAgIGZvciAoaj0xO2o8bWFzaztqPDw9MSlcbiAgICAgIGlmICh4W2ldICYgaikge1xuICAgICAgICBzPShrPG1yX3IubGVuZ3RoK2JwZSA/IGsgOiAwKTtcbiAgICAgICAgIGk9bXJfci5sZW5ndGg7XG4gICAgICAgICBqPW1hc2s7XG4gICAgICB9IGVsc2VcbiAgICAgICAgaysrO1xuXG4gIGlmIChzKVxuICAgIHJpZ2h0U2hpZnRfKG1yX3Iscyk7XG5cbiAgcG93TW9kXyhtcl9hLG1yX3IseCk7XG5cbiAgaWYgKCFlcXVhbHNJbnQobXJfYSwxKSAmJiAhZXF1YWxzKG1yX2EsbXJfeDEpKSB7XG4gICAgaj0xO1xuICAgIHdoaWxlIChqPD1zLTEgJiYgIWVxdWFscyhtcl9hLG1yX3gxKSkge1xuICAgICAgc3F1YXJlTW9kXyhtcl9hLHgpO1xuICAgICAgaWYgKGVxdWFsc0ludChtcl9hLDEpKSB7XG4gICAgICAgIHJldHVybiAwO1xuICAgICAgfVxuICAgICAgaisrO1xuICAgIH1cbiAgICBpZiAoIWVxdWFscyhtcl9hLG1yX3gxKSkge1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICB9XG4gIHJldHVybiAxO1xufVxuXG4vL3JldHVybnMgaG93IG1hbnkgYml0cyBsb25nIHRoZSBiaWdJbnQgaXMsIG5vdCBjb3VudGluZyBsZWFkaW5nIHplcm9zLlxuZnVuY3Rpb24gYml0U2l6ZSh4KSB7XG4gIHZhciBqLHosdztcbiAgZm9yIChqPXgubGVuZ3RoLTE7ICh4W2pdPT0wKSAmJiAoaj4wKTsgai0tKTtcbiAgZm9yICh6PTAsdz14W2pdOyB3OyAodz4+PTEpLHorKyk7XG4gIHorPWJwZSpqO1xuICByZXR1cm4gejtcbn1cblxuLy9yZXR1cm4gYSBjb3B5IG9mIHggd2l0aCBhdCBsZWFzdCBuIGVsZW1lbnRzLCBhZGRpbmcgbGVhZGluZyB6ZXJvcyBpZiBuZWVkZWRcbmZ1bmN0aW9uIGV4cGFuZCh4LG4pIHtcbiAgdmFyIGFucz1pbnQyYmlnSW50KDAsKHgubGVuZ3RoPm4gPyB4Lmxlbmd0aCA6IG4pKmJwZSwwKTtcbiAgY29weV8oYW5zLHgpO1xuICByZXR1cm4gYW5zO1xufVxuXG4vL3JldHVybiBhIGstYml0IHRydWUgcmFuZG9tIHByaW1lIHVzaW5nIE1hdXJlcidzIGFsZ29yaXRobS5cbmZ1bmN0aW9uIHJhbmRUcnVlUHJpbWUoaykge1xuICB2YXIgYW5zPWludDJiaWdJbnQoMCxrLDApO1xuICByYW5kVHJ1ZVByaW1lXyhhbnMsayk7XG4gIHJldHVybiB0cmltKGFucywxKTtcbn1cblxuLy9yZXR1cm4gYSBrLWJpdCByYW5kb20gcHJvYmFibGUgcHJpbWUgd2l0aCBwcm9iYWJpbGl0eSBvZiBlcnJvciA8IDJeLTgwXG5mdW5jdGlvbiByYW5kUHJvYlByaW1lKGspIHtcbiAgaWYgKGs+PTYwMCkgcmV0dXJuIHJhbmRQcm9iUHJpbWVSb3VuZHMoaywyKTsgLy9udW1iZXJzIGZyb20gSEFDIHRhYmxlIDQuM1xuICBpZiAoaz49NTUwKSByZXR1cm4gcmFuZFByb2JQcmltZVJvdW5kcyhrLDQpO1xuICBpZiAoaz49NTAwKSByZXR1cm4gcmFuZFByb2JQcmltZVJvdW5kcyhrLDUpO1xuICBpZiAoaz49NDAwKSByZXR1cm4gcmFuZFByb2JQcmltZVJvdW5kcyhrLDYpO1xuICBpZiAoaz49MzUwKSByZXR1cm4gcmFuZFByb2JQcmltZVJvdW5kcyhrLDcpO1xuICBpZiAoaz49MzAwKSByZXR1cm4gcmFuZFByb2JQcmltZVJvdW5kcyhrLDkpO1xuICBpZiAoaz49MjUwKSByZXR1cm4gcmFuZFByb2JQcmltZVJvdW5kcyhrLDEyKTsgLy9udW1iZXJzIGZyb20gSEFDIHRhYmxlIDQuNFxuICBpZiAoaz49MjAwKSByZXR1cm4gcmFuZFByb2JQcmltZVJvdW5kcyhrLDE1KTtcbiAgaWYgKGs+PTE1MCkgcmV0dXJuIHJhbmRQcm9iUHJpbWVSb3VuZHMoaywxOCk7XG4gIGlmIChrPj0xMDApIHJldHVybiByYW5kUHJvYlByaW1lUm91bmRzKGssMjcpO1xuICAgICAgICAgICAgICByZXR1cm4gcmFuZFByb2JQcmltZVJvdW5kcyhrLDQwKTsgLy9udW1iZXIgZnJvbSBIQUMgcmVtYXJrIDQuMjYgKG9ubHkgYW4gZXN0aW1hdGUpXG59XG5cbi8vcmV0dXJuIGEgay1iaXQgcHJvYmFibGUgcmFuZG9tIHByaW1lIHVzaW5nIG4gcm91bmRzIG9mIE1pbGxlciBSYWJpbiAoYWZ0ZXIgdHJpYWwgZGl2aXNpb24gd2l0aCBzbWFsbCBwcmltZXMpXG5mdW5jdGlvbiByYW5kUHJvYlByaW1lUm91bmRzKGssbikge1xuICB2YXIgYW5zLCBpLCBkaXZpc2libGUsIEI7XG4gIEI9MzAwMDA7ICAvL0IgaXMgbGFyZ2VzdCBwcmltZSB0byB1c2UgaW4gdHJpYWwgZGl2aXNpb25cbiAgYW5zPWludDJiaWdJbnQoMCxrLDApO1xuXG4gIC8vb3B0aW1pemF0aW9uOiB0cnkgbGFyZ2VyIGFuZCBzbWFsbGVyIEIgdG8gZmluZCB0aGUgYmVzdCBsaW1pdC5cblxuICBpZiAocHJpbWVzLmxlbmd0aD09MClcbiAgICBwcmltZXM9ZmluZFByaW1lcygzMDAwMCk7ICAvL2NoZWNrIGZvciBkaXZpc2liaWxpdHkgYnkgcHJpbWVzIDw9MzAwMDBcblxuICBpZiAocnBwcmIubGVuZ3RoIT1hbnMubGVuZ3RoKVxuICAgIHJwcHJiPWR1cChhbnMpO1xuXG4gIGZvciAoOzspIHsgLy9rZWVwIHRyeWluZyByYW5kb20gdmFsdWVzIGZvciBhbnMgdW50aWwgb25lIGFwcGVhcnMgdG8gYmUgcHJpbWVcbiAgICAvL29wdGltaXphdGlvbjogcGljayBhIHJhbmRvbSBudW1iZXIgdGltZXMgTD0yKjMqNSouLi4qcCwgcGx1cyBhXG4gICAgLy8gICByYW5kb20gZWxlbWVudCBvZiB0aGUgbGlzdCBvZiBhbGwgbnVtYmVycyBpbiBbMCxMKSBub3QgZGl2aXNpYmxlIGJ5IGFueSBwcmltZSB1cCB0byBwLlxuICAgIC8vICAgVGhpcyBjYW4gcmVkdWNlIHRoZSBhbW91bnQgb2YgcmFuZG9tIG51bWJlciBnZW5lcmF0aW9uLlxuXG4gICAgcmFuZEJpZ0ludF8oYW5zLGssMCk7IC8vYW5zID0gYSByYW5kb20gb2RkIG51bWJlciB0byBjaGVja1xuICAgIGFuc1swXSB8PSAxO1xuICAgIGRpdmlzaWJsZT0wO1xuXG4gICAgLy9jaGVjayBhbnMgZm9yIGRpdmlzaWJpbGl0eSBieSBzbWFsbCBwcmltZXMgdXAgdG8gQlxuICAgIGZvciAoaT0wOyAoaTxwcmltZXMubGVuZ3RoKSAmJiAocHJpbWVzW2ldPD1CKTsgaSsrKVxuICAgICAgaWYgKG1vZEludChhbnMscHJpbWVzW2ldKT09MCAmJiAhZXF1YWxzSW50KGFucyxwcmltZXNbaV0pKSB7XG4gICAgICAgIGRpdmlzaWJsZT0xO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgIC8vb3B0aW1pemF0aW9uOiBjaGFuZ2UgbWlsbGVyUmFiaW4gc28gdGhlIGJhc2UgY2FuIGJlIGJpZ2dlciB0aGFuIHRoZSBudW1iZXIgYmVpbmcgY2hlY2tlZCwgdGhlbiBlbGltaW5hdGUgdGhlIHdoaWxlIGhlcmUuXG5cbiAgICAvL2RvIG4gcm91bmRzIG9mIE1pbGxlciBSYWJpbiwgd2l0aCByYW5kb20gYmFzZXMgbGVzcyB0aGFuIGFuc1xuICAgIGZvciAoaT0wOyBpPG4gJiYgIWRpdmlzaWJsZTsgaSsrKSB7XG4gICAgICByYW5kQmlnSW50XyhycHByYixrLDApO1xuICAgICAgd2hpbGUoIWdyZWF0ZXIoYW5zLHJwcHJiKSkgLy9waWNrIGEgcmFuZG9tIHJwcHJiIHRoYXQncyA8IGFuc1xuICAgICAgICByYW5kQmlnSW50XyhycHByYixrLDApO1xuICAgICAgaWYgKCFtaWxsZXJSYWJpbihhbnMscnBwcmIpKVxuICAgICAgICBkaXZpc2libGU9MTtcbiAgICB9XG5cbiAgICBpZighZGl2aXNpYmxlKVxuICAgICAgcmV0dXJuIGFucztcbiAgfVxufVxuXG4vL3JldHVybiBhIG5ldyBiaWdJbnQgZXF1YWwgdG8gKHggbW9kIG4pIGZvciBiaWdJbnRzIHggYW5kIG4uXG5mdW5jdGlvbiBtb2QoeCxuKSB7XG4gIHZhciBhbnM9ZHVwKHgpO1xuICBtb2RfKGFucyxuKTtcbiAgcmV0dXJuIHRyaW0oYW5zLDEpO1xufVxuXG4vL3JldHVybiAoeCtuKSB3aGVyZSB4IGlzIGEgYmlnSW50IGFuZCBuIGlzIGFuIGludGVnZXIuXG5mdW5jdGlvbiBhZGRJbnQoeCxuKSB7XG4gIHZhciBhbnM9ZXhwYW5kKHgseC5sZW5ndGgrMSk7XG4gIGFkZEludF8oYW5zLG4pO1xuICByZXR1cm4gdHJpbShhbnMsMSk7XG59XG5cbi8vcmV0dXJuIHgqeSBmb3IgYmlnSW50cyB4IGFuZCB5LiBUaGlzIGlzIGZhc3RlciB3aGVuIHk8eC5cbmZ1bmN0aW9uIG11bHQoeCx5KSB7XG4gIHZhciBhbnM9ZXhwYW5kKHgseC5sZW5ndGgreS5sZW5ndGgpO1xuICBtdWx0XyhhbnMseSk7XG4gIHJldHVybiB0cmltKGFucywxKTtcbn1cblxuLy9yZXR1cm4gKHgqKnkgbW9kIG4pIHdoZXJlIHgseSxuIGFyZSBiaWdJbnRzIGFuZCAqKiBpcyBleHBvbmVudGlhdGlvbi4gIDAqKjA9MS4gRmFzdGVyIGZvciBvZGQgbi5cbmZ1bmN0aW9uIHBvd01vZCh4LHksbikge1xuICB2YXIgYW5zPWV4cGFuZCh4LG4ubGVuZ3RoKTtcbiAgcG93TW9kXyhhbnMsdHJpbSh5LDIpLHRyaW0obiwyKSwwKTsgIC8vdGhpcyBzaG91bGQgd29yayB3aXRob3V0IHRoZSB0cmltLCBidXQgZG9lc24ndFxuICByZXR1cm4gdHJpbShhbnMsMSk7XG59XG5cbi8vcmV0dXJuICh4LXkpIGZvciBiaWdJbnRzIHggYW5kIHkuICBOZWdhdGl2ZSBhbnN3ZXJzIHdpbGwgYmUgMnMgY29tcGxlbWVudFxuZnVuY3Rpb24gc3ViKHgseSkge1xuICB2YXIgYW5zPWV4cGFuZCh4LCh4Lmxlbmd0aD55Lmxlbmd0aCA/IHgubGVuZ3RoKzEgOiB5Lmxlbmd0aCsxKSk7XG4gIHN1Yl8oYW5zLHkpO1xuICByZXR1cm4gdHJpbShhbnMsMSk7XG59XG5cbi8vcmV0dXJuICh4K3kpIGZvciBiaWdJbnRzIHggYW5kIHkuXG5mdW5jdGlvbiBhZGQoeCx5KSB7XG4gIHZhciBhbnM9ZXhwYW5kKHgsKHgubGVuZ3RoPnkubGVuZ3RoID8geC5sZW5ndGgrMSA6IHkubGVuZ3RoKzEpKTtcbiAgYWRkXyhhbnMseSk7XG4gIHJldHVybiB0cmltKGFucywxKTtcbn1cblxuLy9yZXR1cm4gKHgqKigtMSkgbW9kIG4pIGZvciBiaWdJbnRzIHggYW5kIG4uICBJZiBubyBpbnZlcnNlIGV4aXN0cywgaXQgcmV0dXJucyBudWxsXG5mdW5jdGlvbiBpbnZlcnNlTW9kKHgsbikge1xuICB2YXIgYW5zPWV4cGFuZCh4LG4ubGVuZ3RoKTtcbiAgdmFyIHM7XG4gIHM9aW52ZXJzZU1vZF8oYW5zLG4pO1xuICByZXR1cm4gcyA/IHRyaW0oYW5zLDEpIDogbnVsbDtcbn1cblxuLy9yZXR1cm4gKHgqeSBtb2QgbikgZm9yIGJpZ0ludHMgeCx5LG4uICBGb3IgZ3JlYXRlciBzcGVlZCwgbGV0IHk8eC5cbmZ1bmN0aW9uIG11bHRNb2QoeCx5LG4pIHtcbiAgdmFyIGFucz1leHBhbmQoeCxuLmxlbmd0aCk7XG4gIG11bHRNb2RfKGFucyx5LG4pO1xuICByZXR1cm4gdHJpbShhbnMsMSk7XG59XG5cbi8vZ2VuZXJhdGUgYSBrLWJpdCB0cnVlIHJhbmRvbSBwcmltZSB1c2luZyBNYXVyZXIncyBhbGdvcml0aG0sXG4vL2FuZCBwdXQgaXQgaW50byBhbnMuICBUaGUgYmlnSW50IGFucyBtdXN0IGJlIGxhcmdlIGVub3VnaCB0byBob2xkIGl0LlxuZnVuY3Rpb24gcmFuZFRydWVQcmltZV8oYW5zLGspIHtcbiAgdmFyIGMsbSxwbSxkZCxqLHIsQixkaXZpc2libGUseix6eixyZWNTaXplO1xuXG4gIGlmIChwcmltZXMubGVuZ3RoPT0wKVxuICAgIHByaW1lcz1maW5kUHJpbWVzKDMwMDAwKTsgIC8vY2hlY2sgZm9yIGRpdmlzaWJpbGl0eSBieSBwcmltZXMgPD0zMDAwMFxuXG4gIGlmIChwb3dzLmxlbmd0aD09MCkge1xuICAgIHBvd3M9bmV3IEFycmF5KDUxMik7XG4gICAgZm9yIChqPTA7ajw1MTI7aisrKSB7XG4gICAgICBwb3dzW2pdPU1hdGgucG93KDIsai81MTEuLTEuKTtcbiAgICB9XG4gIH1cblxuICAvL2MgYW5kIG0gc2hvdWxkIGJlIHR1bmVkIGZvciBhIHBhcnRpY3VsYXIgbWFjaGluZSBhbmQgdmFsdWUgb2YgaywgdG8gbWF4aW1pemUgc3BlZWRcbiAgYz0wLjE7ICAvL2M9MC4xIGluIEhBQ1xuICBtPTIwOyAgIC8vZ2VuZXJhdGUgdGhpcyBrLWJpdCBudW1iZXIgYnkgZmlyc3QgcmVjdXJzaXZlbHkgZ2VuZXJhdGluZyBhIG51bWJlciB0aGF0IGhhcyBiZXR3ZWVuIGsvMiBhbmQgay1tIGJpdHNcbiAgcmVjTGltaXQ9MjA7IC8vc3RvcCByZWN1cnNpb24gd2hlbiBrIDw9cmVjTGltaXQuICBNdXN0IGhhdmUgcmVjTGltaXQgPj0gMlxuXG4gIGlmIChzX2kyLmxlbmd0aCE9YW5zLmxlbmd0aCkge1xuICAgIHNfaTI9ZHVwKGFucyk7XG4gICAgc19SID1kdXAoYW5zKTtcbiAgICBzX24xPWR1cChhbnMpO1xuICAgIHNfcjI9ZHVwKGFucyk7XG4gICAgc19kID1kdXAoYW5zKTtcbiAgICBzX3gxPWR1cChhbnMpO1xuICAgIHNfeDI9ZHVwKGFucyk7XG4gICAgc19iID1kdXAoYW5zKTtcbiAgICBzX24gPWR1cChhbnMpO1xuICAgIHNfaSA9ZHVwKGFucyk7XG4gICAgc19ybT1kdXAoYW5zKTtcbiAgICBzX3EgPWR1cChhbnMpO1xuICAgIHNfYSA9ZHVwKGFucyk7XG4gICAgc19hYT1kdXAoYW5zKTtcbiAgfVxuXG4gIGlmIChrIDw9IHJlY0xpbWl0KSB7ICAvL2dlbmVyYXRlIHNtYWxsIHJhbmRvbSBwcmltZXMgYnkgdHJpYWwgZGl2aXNpb24gdXAgdG8gaXRzIHNxdWFyZSByb290XG4gICAgcG09KDE8PCgoaysyKT4+MSkpLTE7IC8vcG0gaXMgYmluYXJ5IG51bWJlciB3aXRoIGFsbCBvbmVzLCBqdXN0IG92ZXIgc3FydCgyXmspXG4gICAgY29weUludF8oYW5zLDApO1xuICAgIGZvciAoZGQ9MTtkZDspIHtcbiAgICAgIGRkPTA7XG4gICAgICBhbnNbMF09IDEgfCAoMTw8KGstMSkpIHwgTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKigxPDxrKSk7ICAvL3JhbmRvbSwgay1iaXQsIG9kZCBpbnRlZ2VyLCB3aXRoIG1zYiAxXG4gICAgICBmb3IgKGo9MTsoajxwcmltZXMubGVuZ3RoKSAmJiAoKHByaW1lc1tqXSZwbSk9PXByaW1lc1tqXSk7aisrKSB7IC8vdHJpYWwgZGl2aXNpb24gYnkgYWxsIHByaW1lcyAzLi4uc3FydCgyXmspXG4gICAgICAgIGlmICgwPT0oYW5zWzBdJXByaW1lc1tqXSkpIHtcbiAgICAgICAgICBkZD0xO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGNhcnJ5XyhhbnMpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIEI9YyprKms7ICAgIC8vdHJ5IHNtYWxsIHByaW1lcyB1cCB0byBCIChvciBhbGwgdGhlIHByaW1lc1tdIGFycmF5IGlmIHRoZSBsYXJnZXN0IGlzIGxlc3MgdGhhbiBCKS5cbiAgaWYgKGs+MiptKSAgLy9nZW5lcmF0ZSB0aGlzIGstYml0IG51bWJlciBieSBmaXJzdCByZWN1cnNpdmVseSBnZW5lcmF0aW5nIGEgbnVtYmVyIHRoYXQgaGFzIGJldHdlZW4gay8yIGFuZCBrLW0gYml0c1xuICAgIGZvciAocj0xOyBrLWsqcjw9bTsgKVxuICAgICAgcj1wb3dzW01hdGguZmxvb3IoTWF0aC5yYW5kb20oKSo1MTIpXTsgICAvL3I9TWF0aC5wb3coMixNYXRoLnJhbmRvbSgpLTEpO1xuICBlbHNlXG4gICAgcj0uNTtcblxuICAvL3NpbXVsYXRpb24gc3VnZ2VzdHMgdGhlIG1vcmUgY29tcGxleCBhbGdvcml0aG0gdXNpbmcgcj0uMzMzIGlzIG9ubHkgc2xpZ2h0bHkgZmFzdGVyLlxuXG4gIHJlY1NpemU9TWF0aC5mbG9vcihyKmspKzE7XG5cbiAgcmFuZFRydWVQcmltZV8oc19xLHJlY1NpemUpO1xuICBjb3B5SW50XyhzX2kyLDApO1xuICBzX2kyW01hdGguZmxvb3IoKGstMikvYnBlKV0gfD0gKDE8PCgoay0yKSVicGUpKTsgICAvL3NfaTI9Ml4oay0yKVxuICBkaXZpZGVfKHNfaTIsc19xLHNfaSxzX3JtKTsgICAgICAgICAgICAgICAgICAgICAgICAvL3NfaT1mbG9vcigoMl4oay0xKSkvKDJxKSlcblxuICB6PWJpdFNpemUoc19pKTtcblxuICBmb3IgKDs7KSB7XG4gICAgZm9yICg7OykgeyAgLy9nZW5lcmF0ZSB6LWJpdCBudW1iZXJzIHVudGlsIG9uZSBmYWxscyBpbiB0aGUgcmFuZ2UgWzAsc19pLTFdXG4gICAgICByYW5kQmlnSW50XyhzX1IseiwwKTtcbiAgICAgIGlmIChncmVhdGVyKHNfaSxzX1IpKVxuICAgICAgICBicmVhaztcbiAgICB9ICAgICAgICAgICAgICAgIC8vbm93IHNfUiBpcyBpbiB0aGUgcmFuZ2UgWzAsc19pLTFdXG4gICAgYWRkSW50XyhzX1IsMSk7ICAvL25vdyBzX1IgaXMgaW4gdGhlIHJhbmdlIFsxLHNfaV1cbiAgICBhZGRfKHNfUixzX2kpOyAgIC8vbm93IHNfUiBpcyBpbiB0aGUgcmFuZ2UgW3NfaSsxLDIqc19pXVxuXG4gICAgY29weV8oc19uLHNfcSk7XG4gICAgbXVsdF8oc19uLHNfUik7XG4gICAgbXVsdEludF8oc19uLDIpO1xuICAgIGFkZEludF8oc19uLDEpOyAgICAvL3Nfbj0yKnNfUipzX3ErMVxuXG4gICAgY29weV8oc19yMixzX1IpO1xuICAgIG11bHRJbnRfKHNfcjIsMik7ICAvL3NfcjI9MipzX1JcblxuICAgIC8vY2hlY2sgc19uIGZvciBkaXZpc2liaWxpdHkgYnkgc21hbGwgcHJpbWVzIHVwIHRvIEJcbiAgICBmb3IgKGRpdmlzaWJsZT0wLGo9MDsgKGo8cHJpbWVzLmxlbmd0aCkgJiYgKHByaW1lc1tqXTxCKTsgaisrKVxuICAgICAgaWYgKG1vZEludChzX24scHJpbWVzW2pdKT09MCAmJiAhZXF1YWxzSW50KHNfbixwcmltZXNbal0pKSB7XG4gICAgICAgIGRpdmlzaWJsZT0xO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgIGlmICghZGl2aXNpYmxlKSAgICAvL2lmIGl0IHBhc3NlcyBzbWFsbCBwcmltZXMgY2hlY2ssIHRoZW4gdHJ5IGEgc2luZ2xlIE1pbGxlci1SYWJpbiBiYXNlIDJcbiAgICAgIGlmICghbWlsbGVyUmFiaW5JbnQoc19uLDIpKSAvL3RoaXMgbGluZSByZXByZXNlbnRzIDc1JSBvZiB0aGUgdG90YWwgcnVudGltZSBmb3IgcmFuZFRydWVQcmltZV9cbiAgICAgICAgZGl2aXNpYmxlPTE7XG5cbiAgICBpZiAoIWRpdmlzaWJsZSkgeyAgLy9pZiBpdCBwYXNzZXMgdGhhdCB0ZXN0LCBjb250aW51ZSBjaGVja2luZyBzX25cbiAgICAgIGFkZEludF8oc19uLC0zKTtcbiAgICAgIGZvciAoaj1zX24ubGVuZ3RoLTE7KHNfbltqXT09MCkgJiYgKGo+MCk7IGotLSk7ICAvL3N0cmlwIGxlYWRpbmcgemVyb3NcbiAgICAgIGZvciAoeno9MCx3PXNfbltqXTsgdzsgKHc+Pj0xKSx6eisrKTtcbiAgICAgIHp6Kz1icGUqajsgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8veno9bnVtYmVyIG9mIGJpdHMgaW4gc19uLCBpZ25vcmluZyBsZWFkaW5nIHplcm9zXG4gICAgICBmb3IgKDs7KSB7ICAvL2dlbmVyYXRlIHotYml0IG51bWJlcnMgdW50aWwgb25lIGZhbGxzIGluIHRoZSByYW5nZSBbMCxzX24tMV1cbiAgICAgICAgcmFuZEJpZ0ludF8oc19hLHp6LDApO1xuICAgICAgICBpZiAoZ3JlYXRlcihzX24sc19hKSlcbiAgICAgICAgICBicmVhaztcbiAgICAgIH0gICAgICAgICAgICAgICAgLy9ub3cgc19hIGlzIGluIHRoZSByYW5nZSBbMCxzX24tMV1cbiAgICAgIGFkZEludF8oc19uLDMpOyAgLy9ub3cgc19hIGlzIGluIHRoZSByYW5nZSBbMCxzX24tNF1cbiAgICAgIGFkZEludF8oc19hLDIpOyAgLy9ub3cgc19hIGlzIGluIHRoZSByYW5nZSBbMixzX24tMl1cbiAgICAgIGNvcHlfKHNfYixzX2EpO1xuICAgICAgY29weV8oc19uMSxzX24pO1xuICAgICAgYWRkSW50XyhzX24xLC0xKTtcbiAgICAgIHBvd01vZF8oc19iLHNfbjEsc19uKTsgICAvL3NfYj1zX2FeKHNfbi0xKSBtb2R1bG8gc19uXG4gICAgICBhZGRJbnRfKHNfYiwtMSk7XG4gICAgICBpZiAoaXNaZXJvKHNfYikpIHtcbiAgICAgICAgY29weV8oc19iLHNfYSk7XG4gICAgICAgIHBvd01vZF8oc19iLHNfcjIsc19uKTtcbiAgICAgICAgYWRkSW50XyhzX2IsLTEpO1xuICAgICAgICBjb3B5XyhzX2FhLHNfbik7XG4gICAgICAgIGNvcHlfKHNfZCxzX2IpO1xuICAgICAgICBHQ0RfKHNfZCxzX24pOyAgLy9pZiBzX2IgYW5kIHNfbiBhcmUgcmVsYXRpdmVseSBwcmltZSwgdGhlbiBzX24gaXMgYSBwcmltZVxuICAgICAgICBpZiAoZXF1YWxzSW50KHNfZCwxKSkge1xuICAgICAgICAgIGNvcHlfKGFucyxzX2FhKTtcbiAgICAgICAgICByZXR1cm47ICAgICAvL2lmIHdlJ3ZlIG1hZGUgaXQgdGhpcyBmYXIsIHRoZW4gc19uIGlzIGFic29sdXRlbHkgZ3VhcmFudGVlZCB0byBiZSBwcmltZVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbi8vUmV0dXJuIGFuIG4tYml0IHJhbmRvbSBCaWdJbnQgKG4+PTEpLiAgSWYgcz0xLCB0aGVuIHRoZSBtb3N0IHNpZ25pZmljYW50IG9mIHRob3NlIG4gYml0cyBpcyBzZXQgdG8gMS5cbmZ1bmN0aW9uIHJhbmRCaWdJbnQobixzKSB7XG4gIHZhciBhLGI7XG4gIGE9TWF0aC5mbG9vcigobi0xKS9icGUpKzI7IC8vIyBhcnJheSBlbGVtZW50cyB0byBob2xkIHRoZSBCaWdJbnQgd2l0aCBhIGxlYWRpbmcgMCBlbGVtZW50XG4gIGI9aW50MmJpZ0ludCgwLDAsYSk7XG4gIHJhbmRCaWdJbnRfKGIsbixzKTtcbiAgcmV0dXJuIGI7XG59XG5cbi8vU2V0IGIgdG8gYW4gbi1iaXQgcmFuZG9tIEJpZ0ludC4gIElmIHM9MSwgdGhlbiB0aGUgbW9zdCBzaWduaWZpY2FudCBvZiB0aG9zZSBuIGJpdHMgaXMgc2V0IHRvIDEuXG4vL0FycmF5IGIgbXVzdCBiZSBiaWcgZW5vdWdoIHRvIGhvbGQgdGhlIHJlc3VsdC4gTXVzdCBoYXZlIG4+PTFcbmZ1bmN0aW9uIHJhbmRCaWdJbnRfKGIsbixzKSB7XG4gIHZhciBpLGE7XG4gIGZvciAoaT0wO2k8Yi5sZW5ndGg7aSsrKVxuICAgIGJbaV09MDtcbiAgYT1NYXRoLmZsb29yKChuLTEpL2JwZSkrMTsgLy8jIGFycmF5IGVsZW1lbnRzIHRvIGhvbGQgdGhlIEJpZ0ludFxuICBmb3IgKGk9MDtpPGE7aSsrKSB7XG4gICAgYltpXT1NYXRoLmZsb29yKE1hdGgucmFuZG9tKCkqKDE8PChicGUtMSkpKTtcbiAgfVxuICBiW2EtMV0gJj0gKDI8PCgobi0xKSVicGUpKS0xO1xuICBpZiAocz09MSlcbiAgICBiW2EtMV0gfD0gKDE8PCgobi0xKSVicGUpKTtcbn1cblxuLy9SZXR1cm4gdGhlIGdyZWF0ZXN0IGNvbW1vbiBkaXZpc29yIG9mIGJpZ0ludHMgeCBhbmQgeSAoZWFjaCB3aXRoIHNhbWUgbnVtYmVyIG9mIGVsZW1lbnRzKS5cbmZ1bmN0aW9uIEdDRCh4LHkpIHtcbiAgdmFyIHhjLHljO1xuICB4Yz1kdXAoeCk7XG4gIHljPWR1cCh5KTtcbiAgR0NEXyh4Yyx5Yyk7XG4gIHJldHVybiB4Yztcbn1cblxuLy9zZXQgeCB0byB0aGUgZ3JlYXRlc3QgY29tbW9uIGRpdmlzb3Igb2YgYmlnSW50cyB4IGFuZCB5IChlYWNoIHdpdGggc2FtZSBudW1iZXIgb2YgZWxlbWVudHMpLlxuLy95IGlzIGRlc3Ryb3llZC5cbmZ1bmN0aW9uIEdDRF8oeCx5KSB7XG4gIHZhciBpLHhwLHlwLEEsQixDLEQscSxzaW5nO1xuICBpZiAoVC5sZW5ndGghPXgubGVuZ3RoKVxuICAgIFQ9ZHVwKHgpO1xuXG4gIHNpbmc9MTtcbiAgd2hpbGUgKHNpbmcpIHsgLy93aGlsZSB5IGhhcyBub256ZXJvIGVsZW1lbnRzIG90aGVyIHRoYW4geVswXVxuICAgIHNpbmc9MDtcbiAgICBmb3IgKGk9MTtpPHkubGVuZ3RoO2krKykgLy9jaGVjayBpZiB5IGhhcyBub256ZXJvIGVsZW1lbnRzIG90aGVyIHRoYW4gMFxuICAgICAgaWYgKHlbaV0pIHtcbiAgICAgICAgc2luZz0xO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICBpZiAoIXNpbmcpIGJyZWFrOyAvL3F1aXQgd2hlbiB5IGFsbCB6ZXJvIGVsZW1lbnRzIGV4Y2VwdCBwb3NzaWJseSB5WzBdXG5cbiAgICBmb3IgKGk9eC5sZW5ndGg7IXhbaV0gJiYgaT49MDtpLS0pOyAgLy9maW5kIG1vc3Qgc2lnbmlmaWNhbnQgZWxlbWVudCBvZiB4XG4gICAgeHA9eFtpXTtcbiAgICB5cD15W2ldO1xuICAgIEE9MTsgQj0wOyBDPTA7IEQ9MTtcbiAgICB3aGlsZSAoKHlwK0MpICYmICh5cCtEKSkge1xuICAgICAgcSA9TWF0aC5mbG9vcigoeHArQSkvKHlwK0MpKTtcbiAgICAgIHFwPU1hdGguZmxvb3IoKHhwK0IpLyh5cCtEKSk7XG4gICAgICBpZiAocSE9cXApXG4gICAgICAgIGJyZWFrO1xuICAgICAgdD0gQS1xKkM7ICAgQT1DOyAgIEM9dDsgICAgLy8gIGRvIChBLEIseHAsIEMsRCx5cCkgPSAoQyxELHlwLCBBLEIseHApIC0gcSooMCwwLDAsIEMsRCx5cClcbiAgICAgIHQ9IEItcSpEOyAgIEI9RDsgICBEPXQ7XG4gICAgICB0PXhwLXEqeXA7IHhwPXlwOyB5cD10O1xuICAgIH1cbiAgICBpZiAoQikge1xuICAgICAgY29weV8oVCx4KTtcbiAgICAgIGxpbkNvbWJfKHgseSxBLEIpOyAvL3g9QSp4K0IqeVxuICAgICAgbGluQ29tYl8oeSxULEQsQyk7IC8veT1EKnkrQypUXG4gICAgfSBlbHNlIHtcbiAgICAgIG1vZF8oeCx5KTtcbiAgICAgIGNvcHlfKFQseCk7XG4gICAgICBjb3B5Xyh4LHkpO1xuICAgICAgY29weV8oeSxUKTtcbiAgICB9XG4gIH1cbiAgaWYgKHlbMF09PTApXG4gICAgcmV0dXJuO1xuICB0PW1vZEludCh4LHlbMF0pO1xuICBjb3B5SW50Xyh4LHlbMF0pO1xuICB5WzBdPXQ7XG4gIHdoaWxlICh5WzBdKSB7XG4gICAgeFswXSU9eVswXTtcbiAgICB0PXhbMF07IHhbMF09eVswXTsgeVswXT10O1xuICB9XG59XG5cbi8vZG8geD14KiooLTEpIG1vZCBuLCBmb3IgYmlnSW50cyB4IGFuZCBuLlxuLy9JZiBubyBpbnZlcnNlIGV4aXN0cywgaXQgc2V0cyB4IHRvIHplcm8gYW5kIHJldHVybnMgMCwgZWxzZSBpdCByZXR1cm5zIDEuXG4vL1RoZSB4IGFycmF5IG11c3QgYmUgYXQgbGVhc3QgYXMgbGFyZ2UgYXMgdGhlIG4gYXJyYXkuXG5mdW5jdGlvbiBpbnZlcnNlTW9kXyh4LG4pIHtcbiAgdmFyIGs9MSsyKk1hdGgubWF4KHgubGVuZ3RoLG4ubGVuZ3RoKTtcblxuICBpZighKHhbMF0mMSkgICYmICEoblswXSYxKSkgeyAgLy9pZiBib3RoIGlucHV0cyBhcmUgZXZlbiwgdGhlbiBpbnZlcnNlIGRvZXNuJ3QgZXhpc3RcbiAgICBjb3B5SW50Xyh4LDApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKGVnX3UubGVuZ3RoIT1rKSB7XG4gICAgZWdfdT1uZXcgQXJyYXkoayk7XG4gICAgZWdfdj1uZXcgQXJyYXkoayk7XG4gICAgZWdfQT1uZXcgQXJyYXkoayk7XG4gICAgZWdfQj1uZXcgQXJyYXkoayk7XG4gICAgZWdfQz1uZXcgQXJyYXkoayk7XG4gICAgZWdfRD1uZXcgQXJyYXkoayk7XG4gIH1cblxuICBjb3B5XyhlZ191LHgpO1xuICBjb3B5XyhlZ192LG4pO1xuICBjb3B5SW50XyhlZ19BLDEpO1xuICBjb3B5SW50XyhlZ19CLDApO1xuICBjb3B5SW50XyhlZ19DLDApO1xuICBjb3B5SW50XyhlZ19ELDEpO1xuICBmb3IgKDs7KSB7XG4gICAgd2hpbGUoIShlZ191WzBdJjEpKSB7ICAvL3doaWxlIGVnX3UgaXMgZXZlblxuICAgICAgaGFsdmVfKGVnX3UpO1xuICAgICAgaWYgKCEoZWdfQVswXSYxKSAmJiAhKGVnX0JbMF0mMSkpIHsgLy9pZiBlZ19BPT1lZ19CPT0wIG1vZCAyXG4gICAgICAgIGhhbHZlXyhlZ19BKTtcbiAgICAgICAgaGFsdmVfKGVnX0IpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYWRkXyhlZ19BLG4pOyAgaGFsdmVfKGVnX0EpO1xuICAgICAgICBzdWJfKGVnX0IseCk7ICBoYWx2ZV8oZWdfQik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgd2hpbGUgKCEoZWdfdlswXSYxKSkgeyAgLy93aGlsZSBlZ192IGlzIGV2ZW5cbiAgICAgIGhhbHZlXyhlZ192KTtcbiAgICAgIGlmICghKGVnX0NbMF0mMSkgJiYgIShlZ19EWzBdJjEpKSB7IC8vaWYgZWdfQz09ZWdfRD09MCBtb2QgMlxuICAgICAgICBoYWx2ZV8oZWdfQyk7XG4gICAgICAgIGhhbHZlXyhlZ19EKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGFkZF8oZWdfQyxuKTsgIGhhbHZlXyhlZ19DKTtcbiAgICAgICAgc3ViXyhlZ19ELHgpOyAgaGFsdmVfKGVnX0QpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICghZ3JlYXRlcihlZ192LGVnX3UpKSB7IC8vZWdfdiA8PSBlZ191XG4gICAgICBzdWJfKGVnX3UsZWdfdik7XG4gICAgICBzdWJfKGVnX0EsZWdfQyk7XG4gICAgICBzdWJfKGVnX0IsZWdfRCk7XG4gICAgfSBlbHNlIHsgICAgICAgICAgICAgICAgICAgLy9lZ192ID4gZWdfdVxuICAgICAgc3ViXyhlZ192LGVnX3UpO1xuICAgICAgc3ViXyhlZ19DLGVnX0EpO1xuICAgICAgc3ViXyhlZ19ELGVnX0IpO1xuICAgIH1cblxuICAgIGlmIChlcXVhbHNJbnQoZWdfdSwwKSkge1xuICAgICAgaWYgKG5lZ2F0aXZlKGVnX0MpKSAvL21ha2Ugc3VyZSBhbnN3ZXIgaXMgbm9ubmVnYXRpdmVcbiAgICAgICAgYWRkXyhlZ19DLG4pO1xuICAgICAgY29weV8oeCxlZ19DKTtcblxuICAgICAgaWYgKCFlcXVhbHNJbnQoZWdfdiwxKSkgeyAvL2lmIEdDRF8oeCxuKSE9MSwgdGhlbiB0aGVyZSBpcyBubyBpbnZlcnNlXG4gICAgICAgIGNvcHlJbnRfKHgsMCk7XG4gICAgICAgIHJldHVybiAwO1xuICAgICAgfVxuICAgICAgcmV0dXJuIDE7XG4gICAgfVxuICB9XG59XG5cbi8vcmV0dXJuIHgqKigtMSkgbW9kIG4sIGZvciBpbnRlZ2VycyB4IGFuZCBuLiAgUmV0dXJuIDAgaWYgdGhlcmUgaXMgbm8gaW52ZXJzZVxuZnVuY3Rpb24gaW52ZXJzZU1vZEludCh4LG4pIHtcbiAgdmFyIGE9MSxiPTAsdDtcbiAgZm9yICg7Oykge1xuICAgIGlmICh4PT0xKSByZXR1cm4gYTtcbiAgICBpZiAoeD09MCkgcmV0dXJuIDA7XG4gICAgYi09YSpNYXRoLmZsb29yKG4veCk7XG4gICAgbiU9eDtcblxuICAgIGlmIChuPT0xKSByZXR1cm4gYjsgLy90byBhdm9pZCBuZWdhdGl2ZXMsIGNoYW5nZSB0aGlzIGIgdG8gbi1iLCBhbmQgZWFjaCAtPSB0byArPVxuICAgIGlmIChuPT0wKSByZXR1cm4gMDtcbiAgICBhLT1iKk1hdGguZmxvb3IoeC9uKTtcbiAgICB4JT1uO1xuICB9XG59XG5cbi8vdGhpcyBkZXByZWNhdGVkIGZ1bmN0aW9uIGlzIGZvciBiYWNrd2FyZCBjb21wYXRpYmlsaXR5IG9ubHkuXG5mdW5jdGlvbiBpbnZlcnNlTW9kSW50Xyh4LG4pIHtcbiAgIHJldHVybiBpbnZlcnNlTW9kSW50KHgsbik7XG59XG5cblxuLy9HaXZlbiBwb3NpdGl2ZSBiaWdJbnRzIHggYW5kIHksIGNoYW5nZSB0aGUgYmlnaW50cyB2LCBhLCBhbmQgYiB0byBwb3NpdGl2ZSBiaWdJbnRzIHN1Y2ggdGhhdDpcbi8vICAgICB2ID0gR0NEXyh4LHkpID0gYSp4LWIqeVxuLy9UaGUgYmlnSW50cyB2LCBhLCBiLCBtdXN0IGhhdmUgZXhhY3RseSBhcyBtYW55IGVsZW1lbnRzIGFzIHRoZSBsYXJnZXIgb2YgeCBhbmQgeS5cbmZ1bmN0aW9uIGVHQ0RfKHgseSx2LGEsYikge1xuICB2YXIgZz0wO1xuICB2YXIgaz1NYXRoLm1heCh4Lmxlbmd0aCx5Lmxlbmd0aCk7XG4gIGlmIChlZ191Lmxlbmd0aCE9aykge1xuICAgIGVnX3U9bmV3IEFycmF5KGspO1xuICAgIGVnX0E9bmV3IEFycmF5KGspO1xuICAgIGVnX0I9bmV3IEFycmF5KGspO1xuICAgIGVnX0M9bmV3IEFycmF5KGspO1xuICAgIGVnX0Q9bmV3IEFycmF5KGspO1xuICB9XG4gIHdoaWxlKCEoeFswXSYxKSAgJiYgISh5WzBdJjEpKSB7ICAvL3doaWxlIHggYW5kIHkgYm90aCBldmVuXG4gICAgaGFsdmVfKHgpO1xuICAgIGhhbHZlXyh5KTtcbiAgICBnKys7XG4gIH1cbiAgY29weV8oZWdfdSx4KTtcbiAgY29weV8odix5KTtcbiAgY29weUludF8oZWdfQSwxKTtcbiAgY29weUludF8oZWdfQiwwKTtcbiAgY29weUludF8oZWdfQywwKTtcbiAgY29weUludF8oZWdfRCwxKTtcbiAgZm9yICg7Oykge1xuICAgIHdoaWxlKCEoZWdfdVswXSYxKSkgeyAgLy93aGlsZSB1IGlzIGV2ZW5cbiAgICAgIGhhbHZlXyhlZ191KTtcbiAgICAgIGlmICghKGVnX0FbMF0mMSkgJiYgIShlZ19CWzBdJjEpKSB7IC8vaWYgQT09Qj09MCBtb2QgMlxuICAgICAgICBoYWx2ZV8oZWdfQSk7XG4gICAgICAgIGhhbHZlXyhlZ19CKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGFkZF8oZWdfQSx5KTsgIGhhbHZlXyhlZ19BKTtcbiAgICAgICAgc3ViXyhlZ19CLHgpOyAgaGFsdmVfKGVnX0IpO1xuICAgICAgfVxuICAgIH1cblxuICAgIHdoaWxlICghKHZbMF0mMSkpIHsgIC8vd2hpbGUgdiBpcyBldmVuXG4gICAgICBoYWx2ZV8odik7XG4gICAgICBpZiAoIShlZ19DWzBdJjEpICYmICEoZWdfRFswXSYxKSkgeyAvL2lmIEM9PUQ9PTAgbW9kIDJcbiAgICAgICAgaGFsdmVfKGVnX0MpO1xuICAgICAgICBoYWx2ZV8oZWdfRCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhZGRfKGVnX0MseSk7ICBoYWx2ZV8oZWdfQyk7XG4gICAgICAgIHN1Yl8oZWdfRCx4KTsgIGhhbHZlXyhlZ19EKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoIWdyZWF0ZXIodixlZ191KSkgeyAvL3Y8PXVcbiAgICAgIHN1Yl8oZWdfdSx2KTtcbiAgICAgIHN1Yl8oZWdfQSxlZ19DKTtcbiAgICAgIHN1Yl8oZWdfQixlZ19EKTtcbiAgICB9IGVsc2UgeyAgICAgICAgICAgICAgICAvL3Y+dVxuICAgICAgc3ViXyh2LGVnX3UpO1xuICAgICAgc3ViXyhlZ19DLGVnX0EpO1xuICAgICAgc3ViXyhlZ19ELGVnX0IpO1xuICAgIH1cbiAgICBpZiAoZXF1YWxzSW50KGVnX3UsMCkpIHtcbiAgICAgIGlmIChuZWdhdGl2ZShlZ19DKSkgeyAgIC8vbWFrZSBzdXJlIGEgKEMpaXMgbm9ubmVnYXRpdmVcbiAgICAgICAgYWRkXyhlZ19DLHkpO1xuICAgICAgICBzdWJfKGVnX0QseCk7XG4gICAgICB9XG4gICAgICBtdWx0SW50XyhlZ19ELC0xKTsgIC8vL21ha2Ugc3VyZSBiIChEKSBpcyBub25uZWdhdGl2ZVxuICAgICAgY29weV8oYSxlZ19DKTtcbiAgICAgIGNvcHlfKGIsZWdfRCk7XG4gICAgICBsZWZ0U2hpZnRfKHYsZyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICB9XG59XG5cblxuLy9pcyBiaWdJbnQgeCBuZWdhdGl2ZT9cbmZ1bmN0aW9uIG5lZ2F0aXZlKHgpIHtcbiAgcmV0dXJuICgoeFt4Lmxlbmd0aC0xXT4+KGJwZS0xKSkmMSk7XG59XG5cblxuLy9pcyAoeCA8PCAoc2hpZnQqYnBlKSkgPiB5P1xuLy94IGFuZCB5IGFyZSBub25uZWdhdGl2ZSBiaWdJbnRzXG4vL3NoaWZ0IGlzIGEgbm9ubmVnYXRpdmUgaW50ZWdlclxuZnVuY3Rpb24gZ3JlYXRlclNoaWZ0KHgseSxzaGlmdCkge1xuICB2YXIgaSwga3g9eC5sZW5ndGgsIGt5PXkubGVuZ3RoO1xuICBrPSgoa3grc2hpZnQpPGt5KSA/IChreCtzaGlmdCkgOiBreTtcbiAgZm9yIChpPWt5LTEtc2hpZnQ7IGk8a3ggJiYgaT49MDsgaSsrKVxuICAgIGlmICh4W2ldPjApXG4gICAgICByZXR1cm4gMTsgLy9pZiB0aGVyZSBhcmUgbm9uemVyb3MgaW4geCB0byB0aGUgbGVmdCBvZiB0aGUgZmlyc3QgY29sdW1uIG9mIHksIHRoZW4geCBpcyBiaWdnZXJcbiAgZm9yIChpPWt4LTErc2hpZnQ7IGk8a3k7IGkrKylcbiAgICBpZiAoeVtpXT4wKVxuICAgICAgcmV0dXJuIDA7IC8vaWYgdGhlcmUgYXJlIG5vbnplcm9zIGluIHkgdG8gdGhlIGxlZnQgb2YgdGhlIGZpcnN0IGNvbHVtbiBvZiB4LCB0aGVuIHggaXMgbm90IGJpZ2dlclxuICBmb3IgKGk9ay0xOyBpPj1zaGlmdDsgaS0tKVxuICAgIGlmICAgICAgKHhbaS1zaGlmdF0+eVtpXSkgcmV0dXJuIDE7XG4gICAgZWxzZSBpZiAoeFtpLXNoaWZ0XTx5W2ldKSByZXR1cm4gMDtcbiAgcmV0dXJuIDA7XG59XG5cbi8vaXMgeCA+IHk/ICh4IGFuZCB5IGJvdGggbm9ubmVnYXRpdmUpXG5mdW5jdGlvbiBncmVhdGVyKHgseSkge1xuICB2YXIgaTtcbiAgdmFyIGs9KHgubGVuZ3RoPHkubGVuZ3RoKSA/IHgubGVuZ3RoIDogeS5sZW5ndGg7XG5cbiAgZm9yIChpPXgubGVuZ3RoO2k8eS5sZW5ndGg7aSsrKVxuICAgIGlmICh5W2ldKVxuICAgICAgcmV0dXJuIDA7ICAvL3kgaGFzIG1vcmUgZGlnaXRzXG5cbiAgZm9yIChpPXkubGVuZ3RoO2k8eC5sZW5ndGg7aSsrKVxuICAgIGlmICh4W2ldKVxuICAgICAgcmV0dXJuIDE7ICAvL3ggaGFzIG1vcmUgZGlnaXRzXG5cbiAgZm9yIChpPWstMTtpPj0wO2ktLSlcbiAgICBpZiAoeFtpXT55W2ldKVxuICAgICAgcmV0dXJuIDE7XG4gICAgZWxzZSBpZiAoeFtpXTx5W2ldKVxuICAgICAgcmV0dXJuIDA7XG4gIHJldHVybiAwO1xufVxuXG4vL2RpdmlkZSB4IGJ5IHkgZ2l2aW5nIHF1b3RpZW50IHEgYW5kIHJlbWFpbmRlciByLiAgKHE9Zmxvb3IoeC95KSwgIHI9eCBtb2QgeSkuICBBbGwgNCBhcmUgYmlnaW50cy5cbi8veCBtdXN0IGhhdmUgYXQgbGVhc3Qgb25lIGxlYWRpbmcgemVybyBlbGVtZW50LlxuLy95IG11c3QgYmUgbm9uemVyby5cbi8vcSBhbmQgciBtdXN0IGJlIGFycmF5cyB0aGF0IGFyZSBleGFjdGx5IHRoZSBzYW1lIGxlbmd0aCBhcyB4LiAoT3IgcSBjYW4gaGF2ZSBtb3JlKS5cbi8vTXVzdCBoYXZlIHgubGVuZ3RoID49IHkubGVuZ3RoID49IDIuXG5mdW5jdGlvbiBkaXZpZGVfKHgseSxxLHIpIHtcbiAgdmFyIGt4LCBreTtcbiAgdmFyIGksaix5MSx5MixjLGEsYjtcbiAgY29weV8ocix4KTtcbiAgZm9yIChreT15Lmxlbmd0aDt5W2t5LTFdPT0wO2t5LS0pOyAvL2t5IGlzIG51bWJlciBvZiBlbGVtZW50cyBpbiB5LCBub3QgaW5jbHVkaW5nIGxlYWRpbmcgemVyb3NcblxuICAvL25vcm1hbGl6ZTogZW5zdXJlIHRoZSBtb3N0IHNpZ25pZmljYW50IGVsZW1lbnQgb2YgeSBoYXMgaXRzIGhpZ2hlc3QgYml0IHNldFxuICBiPXlba3ktMV07XG4gIGZvciAoYT0wOyBiOyBhKyspXG4gICAgYj4+PTE7XG4gIGE9YnBlLWE7ICAvL2EgaXMgaG93IG1hbnkgYml0cyB0byBzaGlmdCBzbyB0aGF0IHRoZSBoaWdoIG9yZGVyIGJpdCBvZiB5IGlzIGxlZnRtb3N0IGluIGl0cyBhcnJheSBlbGVtZW50XG4gIGxlZnRTaGlmdF8oeSxhKTsgIC8vbXVsdGlwbHkgYm90aCBieSAxPDxhIG5vdywgdGhlbiBkaXZpZGUgYm90aCBieSB0aGF0IGF0IHRoZSBlbmRcbiAgbGVmdFNoaWZ0XyhyLGEpO1xuXG4gIC8vUm9iIFZpc3NlciBkaXNjb3ZlcmVkIGEgYnVnOiB0aGUgZm9sbG93aW5nIGxpbmUgd2FzIG9yaWdpbmFsbHkganVzdCBiZWZvcmUgdGhlIG5vcm1hbGl6YXRpb24uXG4gIGZvciAoa3g9ci5sZW5ndGg7cltreC0xXT09MCAmJiBreD5reTtreC0tKTsgLy9reCBpcyBudW1iZXIgb2YgZWxlbWVudHMgaW4gbm9ybWFsaXplZCB4LCBub3QgaW5jbHVkaW5nIGxlYWRpbmcgemVyb3NcblxuICBjb3B5SW50XyhxLDApOyAgICAgICAgICAgICAgICAgICAgICAvLyBxPTBcbiAgd2hpbGUgKCFncmVhdGVyU2hpZnQoeSxyLGt4LWt5KSkgeyAgLy8gd2hpbGUgKGxlZnRTaGlmdF8oeSxreC1reSkgPD0gcikge1xuICAgIHN1YlNoaWZ0XyhyLHksa3gta3kpOyAgICAgICAgICAgICAvLyAgIHI9ci1sZWZ0U2hpZnRfKHksa3gta3kpXG4gICAgcVtreC1reV0rKzsgICAgICAgICAgICAgICAgICAgICAgIC8vICAgcVtreC1reV0rKztcbiAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gfVxuXG4gIGZvciAoaT1reC0xOyBpPj1reTsgaS0tKSB7XG4gICAgaWYgKHJbaV09PXlba3ktMV0pXG4gICAgICBxW2kta3ldPW1hc2s7XG4gICAgZWxzZVxuICAgICAgcVtpLWt5XT1NYXRoLmZsb29yKChyW2ldKnJhZGl4K3JbaS0xXSkveVtreS0xXSk7XG5cbiAgICAvL1RoZSBmb2xsb3dpbmcgZm9yKDs7KSBsb29wIGlzIGVxdWl2YWxlbnQgdG8gdGhlIGNvbW1lbnRlZCB3aGlsZSBsb29wLFxuICAgIC8vZXhjZXB0IHRoYXQgdGhlIHVuY29tbWVudGVkIHZlcnNpb24gYXZvaWRzIG92ZXJmbG93LlxuICAgIC8vVGhlIGNvbW1lbnRlZCBsb29wIGNvbWVzIGZyb20gSEFDLCB3aGljaCBhc3N1bWVzIHJbLTFdPT15Wy0xXT09MFxuICAgIC8vICB3aGlsZSAocVtpLWt5XSooeVtreS0xXSpyYWRpeCt5W2t5LTJdKSA+IHJbaV0qcmFkaXgqcmFkaXgrcltpLTFdKnJhZGl4K3JbaS0yXSlcbiAgICAvLyAgICBxW2kta3ldLS07XG4gICAgZm9yICg7Oykge1xuICAgICAgeTI9KGt5PjEgPyB5W2t5LTJdIDogMCkqcVtpLWt5XTtcbiAgICAgIGM9eTI+PmJwZTtcbiAgICAgIHkyPXkyICYgbWFzaztcbiAgICAgIHkxPWMrcVtpLWt5XSp5W2t5LTFdO1xuICAgICAgYz15MT4+YnBlO1xuICAgICAgeTE9eTEgJiBtYXNrO1xuXG4gICAgICBpZiAoYz09cltpXSA/IHkxPT1yW2ktMV0gPyB5Mj4oaT4xID8gcltpLTJdIDogMCkgOiB5MT5yW2ktMV0gOiBjPnJbaV0pXG4gICAgICAgIHFbaS1reV0tLTtcbiAgICAgIGVsc2VcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuXG4gICAgbGluQ29tYlNoaWZ0XyhyLHksLXFbaS1reV0saS1reSk7ICAgIC8vcj1yLXFbaS1reV0qbGVmdFNoaWZ0Xyh5LGkta3kpXG4gICAgaWYgKG5lZ2F0aXZlKHIpKSB7XG4gICAgICBhZGRTaGlmdF8ocix5LGkta3kpOyAgICAgICAgIC8vcj1yK2xlZnRTaGlmdF8oeSxpLWt5KVxuICAgICAgcVtpLWt5XS0tO1xuICAgIH1cbiAgfVxuXG4gIHJpZ2h0U2hpZnRfKHksYSk7ICAvL3VuZG8gdGhlIG5vcm1hbGl6YXRpb24gc3RlcFxuICByaWdodFNoaWZ0XyhyLGEpOyAgLy91bmRvIHRoZSBub3JtYWxpemF0aW9uIHN0ZXBcbn1cblxuLy9kbyBjYXJyaWVzIGFuZCBib3Jyb3dzIHNvIGVhY2ggZWxlbWVudCBvZiB0aGUgYmlnSW50IHggZml0cyBpbiBicGUgYml0cy5cbmZ1bmN0aW9uIGNhcnJ5Xyh4KSB7XG4gIHZhciBpLGssYyxiO1xuICBrPXgubGVuZ3RoO1xuICBjPTA7XG4gIGZvciAoaT0wO2k8aztpKyspIHtcbiAgICBjKz14W2ldO1xuICAgIGI9MDtcbiAgICBpZiAoYzwwKSB7XG4gICAgICBiPS0oYz4+YnBlKTtcbiAgICAgIGMrPWIqcmFkaXg7XG4gICAgfVxuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz0oYz4+YnBlKS1iO1xuICB9XG59XG5cbi8vcmV0dXJuIHggbW9kIG4gZm9yIGJpZ0ludCB4IGFuZCBpbnRlZ2VyIG4uXG5mdW5jdGlvbiBtb2RJbnQoeCxuKSB7XG4gIHZhciBpLGM9MDtcbiAgZm9yIChpPXgubGVuZ3RoLTE7IGk+PTA7IGktLSlcbiAgICBjPShjKnJhZGl4K3hbaV0pJW47XG4gIHJldHVybiBjO1xufVxuXG4vL2NvbnZlcnQgdGhlIGludGVnZXIgdCBpbnRvIGEgYmlnSW50IHdpdGggYXQgbGVhc3QgdGhlIGdpdmVuIG51bWJlciBvZiBiaXRzLlxuLy90aGUgcmV0dXJuZWQgYXJyYXkgc3RvcmVzIHRoZSBiaWdJbnQgaW4gYnBlLWJpdCBjaHVua3MsIGxpdHRsZSBlbmRpYW4gKGJ1ZmZbMF0gaXMgbGVhc3Qgc2lnbmlmaWNhbnQgd29yZClcbi8vUGFkIHRoZSBhcnJheSB3aXRoIGxlYWRpbmcgemVyb3Mgc28gdGhhdCBpdCBoYXMgYXQgbGVhc3QgbWluU2l6ZSBlbGVtZW50cy5cbi8vVGhlcmUgd2lsbCBhbHdheXMgYmUgYXQgbGVhc3Qgb25lIGxlYWRpbmcgMCBlbGVtZW50LlxuZnVuY3Rpb24gaW50MmJpZ0ludCh0LGJpdHMsbWluU2l6ZSkge1xuICB2YXIgaSxrO1xuICBrPU1hdGguY2VpbChiaXRzL2JwZSkrMTtcbiAgaz1taW5TaXplPmsgPyBtaW5TaXplIDogaztcbiAgYnVmZj1uZXcgQXJyYXkoayk7XG4gIGNvcHlJbnRfKGJ1ZmYsdCk7XG4gIHJldHVybiBidWZmO1xufVxuXG4vL3JldHVybiB0aGUgYmlnSW50IGdpdmVuIGEgc3RyaW5nIHJlcHJlc2VudGF0aW9uIGluIGEgZ2l2ZW4gYmFzZS5cbi8vUGFkIHRoZSBhcnJheSB3aXRoIGxlYWRpbmcgemVyb3Mgc28gdGhhdCBpdCBoYXMgYXQgbGVhc3QgbWluU2l6ZSBlbGVtZW50cy5cbi8vSWYgYmFzZT0tMSwgdGhlbiBpdCByZWFkcyBpbiBhIHNwYWNlLXNlcGFyYXRlZCBsaXN0IG9mIGFycmF5IGVsZW1lbnRzIGluIGRlY2ltYWwuXG4vL1RoZSBhcnJheSB3aWxsIGFsd2F5cyBoYXZlIGF0IGxlYXN0IG9uZSBsZWFkaW5nIHplcm8sIHVubGVzcyBiYXNlPS0xLlxuZnVuY3Rpb24gc3RyMmJpZ0ludChzLGIsbWluU2l6ZSkge1xuICB2YXIgZCwgaSwgaiwgYmFzZSwgc3RyLCB4LCB5LCBraztcbiAgaWYgKHR5cGVvZiBiID09PSAnc3RyaW5nJykge1xuXHQgIGJhc2UgPSBiLmxlbmd0aDtcblx0ICBzdHIgPSBiO1xuICB9IGVsc2Uge1xuXHQgIGJhc2UgPSBiO1xuXHQgIHN0ciA9IGRpZ2l0c1N0cjtcbiAgfVxuICB2YXIgaz1zLmxlbmd0aDtcbiAgaWYgKGJhc2U9PS0xKSB7IC8vY29tbWEtc2VwYXJhdGVkIGxpc3Qgb2YgYXJyYXkgZWxlbWVudHMgaW4gZGVjaW1hbFxuICAgIHg9bmV3IEFycmF5KDApO1xuICAgIGZvciAoOzspIHtcbiAgICAgIHk9bmV3IEFycmF5KHgubGVuZ3RoKzEpO1xuICAgICAgZm9yIChpPTA7aTx4Lmxlbmd0aDtpKyspXG4gICAgICAgIHlbaSsxXT14W2ldO1xuICAgICAgeVswXT1wYXJzZUludChzLDEwKTtcbiAgICAgIHg9eTtcbiAgICAgIGQ9cy5pbmRleE9mKCcsJywwKTtcbiAgICAgIGlmIChkPDEpXG4gICAgICAgIGJyZWFrO1xuICAgICAgcz1zLnN1YnN0cmluZyhkKzEpO1xuICAgICAgaWYgKHMubGVuZ3RoPT0wKVxuICAgICAgICBicmVhaztcbiAgICB9XG4gICAgaWYgKHgubGVuZ3RoPG1pblNpemUpIHtcbiAgICAgIHk9bmV3IEFycmF5KG1pblNpemUpO1xuICAgICAgY29weV8oeSx4KTtcbiAgICAgIHJldHVybiB5O1xuICAgIH1cbiAgICByZXR1cm4geDtcbiAgfVxuXG4gIHg9aW50MmJpZ0ludCgwLGJhc2UqaywwKTtcbiAgZm9yIChpPTA7aTxrO2krKykge1xuICAgIGQ9c3RyLmluZGV4T2Yocy5zdWJzdHJpbmcoaSxpKzEpLDApO1xuLy8gICAgaWYgKGJhc2U8PTM2ICYmIGQ+PTM2KSAgLy9jb252ZXJ0IGxvd2VyY2FzZSB0byB1cHBlcmNhc2UgaWYgYmFzZTw9MzZcbi8vICAgICAgZC09MjY7XG4gICAgaWYgKGQ+PWJhc2UgfHwgZDwwKSB7ICAgLy9pZ25vcmUgaWxsZWdhbCBjaGFyYWN0ZXJzXG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgbXVsdEludF8oeCxiYXNlKTtcbiAgICBhZGRJbnRfKHgsZCk7XG4gIH1cblxuICBmb3IgKGs9eC5sZW5ndGg7az4wICYmICF4W2stMV07ay0tKTsgLy9zdHJpcCBvZmYgbGVhZGluZyB6ZXJvc1xuICBrPW1pblNpemU+aysxID8gbWluU2l6ZSA6IGsrMTtcbiAgeT1uZXcgQXJyYXkoayk7XG4gIGtrPWs8eC5sZW5ndGggPyBrIDogeC5sZW5ndGg7XG4gIGZvciAoaT0wO2k8a2s7aSsrKVxuICAgIHlbaV09eFtpXTtcbiAgZm9yICg7aTxrO2krKylcbiAgICB5W2ldPTA7XG4gIHJldHVybiB5O1xufVxuXG4vL2lzIGJpZ2ludCB4IGVxdWFsIHRvIGludGVnZXIgeT9cbi8veSBtdXN0IGhhdmUgbGVzcyB0aGFuIGJwZSBiaXRzXG5mdW5jdGlvbiBlcXVhbHNJbnQoeCx5KSB7XG4gIHZhciBpO1xuICBpZiAoeFswXSE9eSlcbiAgICByZXR1cm4gMDtcbiAgZm9yIChpPTE7aTx4Lmxlbmd0aDtpKyspXG4gICAgaWYgKHhbaV0pXG4gICAgICByZXR1cm4gMDtcbiAgcmV0dXJuIDE7XG59XG5cbi8vYXJlIGJpZ2ludHMgeCBhbmQgeSBlcXVhbD9cbi8vdGhpcyB3b3JrcyBldmVuIGlmIHggYW5kIHkgYXJlIGRpZmZlcmVudCBsZW5ndGhzIGFuZCBoYXZlIGFyYml0cmFyaWx5IG1hbnkgbGVhZGluZyB6ZXJvc1xuZnVuY3Rpb24gZXF1YWxzKHgseSkge1xuICB2YXIgaTtcbiAgdmFyIGs9eC5sZW5ndGg8eS5sZW5ndGggPyB4Lmxlbmd0aCA6IHkubGVuZ3RoO1xuICBmb3IgKGk9MDtpPGs7aSsrKVxuICAgIGlmICh4W2ldIT15W2ldKVxuICAgICAgcmV0dXJuIDA7XG4gIGlmICh4Lmxlbmd0aD55Lmxlbmd0aCkge1xuICAgIGZvciAoO2k8eC5sZW5ndGg7aSsrKVxuICAgICAgaWYgKHhbaV0pXG4gICAgICAgIHJldHVybiAwO1xuICB9IGVsc2Uge1xuICAgIGZvciAoO2k8eS5sZW5ndGg7aSsrKVxuICAgICAgaWYgKHlbaV0pXG4gICAgICAgIHJldHVybiAwO1xuICB9XG4gIHJldHVybiAxO1xufVxuXG4vL2lzIHRoZSBiaWdJbnQgeCBlcXVhbCB0byB6ZXJvP1xuZnVuY3Rpb24gaXNaZXJvKHgpIHtcbiAgdmFyIGk7XG4gIGZvciAoaT0wO2k8eC5sZW5ndGg7aSsrKVxuICAgIGlmICh4W2ldKVxuICAgICAgcmV0dXJuIDA7XG4gIHJldHVybiAxO1xufVxuXG4vL2NvbnZlcnQgYSBiaWdJbnQgaW50byBhIHN0cmluZyBpbiBhIGdpdmVuIGJhc2UsIGZyb20gYmFzZSAyIHVwIHRvIGJhc2UgOTUuXG4vL0Jhc2UgLTEgcHJpbnRzIHRoZSBjb250ZW50cyBvZiB0aGUgYXJyYXkgcmVwcmVzZW50aW5nIHRoZSBudW1iZXIuXG5mdW5jdGlvbiBiaWdJbnQyc3RyKHgsYikge1xuICB2YXIgaSx0LGJhc2Usc3RyLHM9XCJcIjtcbiAgaWYgKHR5cGVvZiBiID09PSAnc3RyaW5nJykge1xuXHQgIGJhc2UgPSBiLmxlbmd0aDtcblx0ICBzdHIgPSBiO1xuICB9IGVsc2Uge1xuXHQgIGJhc2UgPSBiO1xuXHQgIHN0ciA9IGRpZ2l0c1N0cjtcbiAgfVxuXG4gIGlmIChzNi5sZW5ndGghPXgubGVuZ3RoKVxuICAgIHM2PWR1cCh4KTtcbiAgZWxzZVxuICAgIGNvcHlfKHM2LHgpO1xuXG4gIGlmIChiYXNlPT0tMSkgeyAvL3JldHVybiB0aGUgbGlzdCBvZiBhcnJheSBjb250ZW50c1xuICAgIGZvciAoaT14Lmxlbmd0aC0xO2k+MDtpLS0pXG4gICAgICBzKz14W2ldKycsJztcbiAgICBzKz14WzBdO1xuICB9XG4gIGVsc2UgeyAvL3JldHVybiBpdCBpbiB0aGUgZ2l2ZW4gYmFzZVxuICAgIHdoaWxlICghaXNaZXJvKHM2KSkge1xuICAgICAgdD1kaXZJbnRfKHM2LGJhc2UpOyAgLy90PXM2ICUgYmFzZTsgczY9Zmxvb3IoczYvYmFzZSk7XG4gICAgICBzPXN0ci5zdWJzdHJpbmcodCx0KzEpK3M7XG4gICAgfVxuICB9XG4gIGlmIChzLmxlbmd0aD09MClcbiAgICBzPXN0clswXTtcbiAgcmV0dXJuIHM7XG59XG5cbi8vcmV0dXJucyBhIGR1cGxpY2F0ZSBvZiBiaWdJbnQgeFxuZnVuY3Rpb24gZHVwKHgpIHtcbiAgdmFyIGk7XG4gIGJ1ZmY9bmV3IEFycmF5KHgubGVuZ3RoKTtcbiAgY29weV8oYnVmZix4KTtcbiAgcmV0dXJuIGJ1ZmY7XG59XG5cbi8vZG8geD15IG9uIGJpZ0ludHMgeCBhbmQgeS4gIHggbXVzdCBiZSBhbiBhcnJheSBhdCBsZWFzdCBhcyBiaWcgYXMgeSAobm90IGNvdW50aW5nIHRoZSBsZWFkaW5nIHplcm9zIGluIHkpLlxuZnVuY3Rpb24gY29weV8oeCx5KSB7XG4gIHZhciBpO1xuICB2YXIgaz14Lmxlbmd0aDx5Lmxlbmd0aCA/IHgubGVuZ3RoIDogeS5sZW5ndGg7XG4gIGZvciAoaT0wO2k8aztpKyspXG4gICAgeFtpXT15W2ldO1xuICBmb3IgKGk9aztpPHgubGVuZ3RoO2krKylcbiAgICB4W2ldPTA7XG59XG5cbi8vZG8geD15IG9uIGJpZ0ludCB4IGFuZCBpbnRlZ2VyIHkuXG5mdW5jdGlvbiBjb3B5SW50Xyh4LG4pIHtcbiAgdmFyIGksYztcbiAgZm9yIChjPW4saT0wO2k8eC5sZW5ndGg7aSsrKSB7XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPj49YnBlO1xuICB9XG59XG5cbi8vZG8geD14K24gd2hlcmUgeCBpcyBhIGJpZ0ludCBhbmQgbiBpcyBhbiBpbnRlZ2VyLlxuLy94IG11c3QgYmUgbGFyZ2UgZW5vdWdoIHRvIGhvbGQgdGhlIHJlc3VsdC5cbmZ1bmN0aW9uIGFkZEludF8oeCxuKSB7XG4gIHZhciBpLGssYyxiO1xuICB4WzBdKz1uO1xuICBrPXgubGVuZ3RoO1xuICBjPTA7XG4gIGZvciAoaT0wO2k8aztpKyspIHtcbiAgICBjKz14W2ldO1xuICAgIGI9MDtcbiAgICBpZiAoYzwwKSB7XG4gICAgICBiPS0oYz4+YnBlKTtcbiAgICAgIGMrPWIqcmFkaXg7XG4gICAgfVxuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz0oYz4+YnBlKS1iO1xuICAgIGlmICghYykgcmV0dXJuOyAvL3N0b3AgY2FycnlpbmcgYXMgc29vbiBhcyB0aGUgY2FycnkgaXMgemVyb1xuICB9XG59XG5cbi8vcmlnaHQgc2hpZnQgYmlnSW50IHggYnkgbiBiaXRzLiAgMCA8PSBuIDwgYnBlLlxuZnVuY3Rpb24gcmlnaHRTaGlmdF8oeCxuKSB7XG4gIHZhciBpO1xuICB2YXIgaz1NYXRoLmZsb29yKG4vYnBlKTtcbiAgaWYgKGspIHtcbiAgICBmb3IgKGk9MDtpPHgubGVuZ3RoLWs7aSsrKSAvL3JpZ2h0IHNoaWZ0IHggYnkgayBlbGVtZW50c1xuICAgICAgeFtpXT14W2kra107XG4gICAgZm9yICg7aTx4Lmxlbmd0aDtpKyspXG4gICAgICB4W2ldPTA7XG4gICAgbiU9YnBlO1xuICB9XG4gIGZvciAoaT0wO2k8eC5sZW5ndGgtMTtpKyspIHtcbiAgICB4W2ldPW1hc2sgJiAoKHhbaSsxXTw8KGJwZS1uKSkgfCAoeFtpXT4+bikpO1xuICB9XG4gIHhbaV0+Pj1uO1xufVxuXG4vL2RvIHg9Zmxvb3IofHh8LzIpKnNnbih4KSBmb3IgYmlnSW50IHggaW4gMidzIGNvbXBsZW1lbnRcbmZ1bmN0aW9uIGhhbHZlXyh4KSB7XG4gIHZhciBpO1xuICBmb3IgKGk9MDtpPHgubGVuZ3RoLTE7aSsrKSB7XG4gICAgeFtpXT1tYXNrICYgKCh4W2krMV08PChicGUtMSkpIHwgKHhbaV0+PjEpKTtcbiAgfVxuICB4W2ldPSh4W2ldPj4xKSB8ICh4W2ldICYgKHJhZGl4Pj4xKSk7ICAvL21vc3Qgc2lnbmlmaWNhbnQgYml0IHN0YXlzIHRoZSBzYW1lXG59XG5cbi8vbGVmdCBzaGlmdCBiaWdJbnQgeCBieSBuIGJpdHMuXG5mdW5jdGlvbiBsZWZ0U2hpZnRfKHgsbikge1xuICB2YXIgaTtcbiAgdmFyIGs9TWF0aC5mbG9vcihuL2JwZSk7XG4gIGlmIChrKSB7XG4gICAgZm9yIChpPXgubGVuZ3RoOyBpPj1rOyBpLS0pIC8vbGVmdCBzaGlmdCB4IGJ5IGsgZWxlbWVudHNcbiAgICAgIHhbaV09eFtpLWtdO1xuICAgIGZvciAoO2k+PTA7aS0tKVxuICAgICAgeFtpXT0wO1xuICAgIG4lPWJwZTtcbiAgfVxuICBpZiAoIW4pXG4gICAgcmV0dXJuO1xuICBmb3IgKGk9eC5sZW5ndGgtMTtpPjA7aS0tKSB7XG4gICAgeFtpXT1tYXNrICYgKCh4W2ldPDxuKSB8ICh4W2ktMV0+PihicGUtbikpKTtcbiAgfVxuICB4W2ldPW1hc2sgJiAoeFtpXTw8bik7XG59XG5cbi8vZG8geD14Km4gd2hlcmUgeCBpcyBhIGJpZ0ludCBhbmQgbiBpcyBhbiBpbnRlZ2VyLlxuLy94IG11c3QgYmUgbGFyZ2UgZW5vdWdoIHRvIGhvbGQgdGhlIHJlc3VsdC5cbmZ1bmN0aW9uIG11bHRJbnRfKHgsbikge1xuICB2YXIgaSxrLGMsYjtcbiAgaWYgKCFuKVxuICAgIHJldHVybjtcbiAgaz14Lmxlbmd0aDtcbiAgYz0wO1xuICBmb3IgKGk9MDtpPGs7aSsrKSB7XG4gICAgYys9eFtpXSpuO1xuICAgIGI9MDtcbiAgICBpZiAoYzwwKSB7XG4gICAgICBiPS0oYz4+YnBlKTtcbiAgICAgIGMrPWIqcmFkaXg7XG4gICAgfVxuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz0oYz4+YnBlKS1iO1xuICB9XG59XG5cbi8vZG8geD1mbG9vcih4L24pIGZvciBiaWdJbnQgeCBhbmQgaW50ZWdlciBuLCBhbmQgcmV0dXJuIHRoZSByZW1haW5kZXJcbmZ1bmN0aW9uIGRpdkludF8oeCxuKSB7XG4gIHZhciBpLHI9MCxzO1xuICBmb3IgKGk9eC5sZW5ndGgtMTtpPj0wO2ktLSkge1xuICAgIHM9cipyYWRpeCt4W2ldO1xuICAgIHhbaV09TWF0aC5mbG9vcihzL24pO1xuICAgIHI9cyVuO1xuICB9XG4gIHJldHVybiByO1xufVxuXG4vL2RvIHRoZSBsaW5lYXIgY29tYmluYXRpb24geD1hKngrYip5IGZvciBiaWdJbnRzIHggYW5kIHksIGFuZCBpbnRlZ2VycyBhIGFuZCBiLlxuLy94IG11c3QgYmUgbGFyZ2UgZW5vdWdoIHRvIGhvbGQgdGhlIGFuc3dlci5cbmZ1bmN0aW9uIGxpbkNvbWJfKHgseSxhLGIpIHtcbiAgdmFyIGksYyxrLGtrO1xuICBrPXgubGVuZ3RoPHkubGVuZ3RoID8geC5sZW5ndGggOiB5Lmxlbmd0aDtcbiAga2s9eC5sZW5ndGg7XG4gIGZvciAoYz0wLGk9MDtpPGs7aSsrKSB7XG4gICAgYys9YSp4W2ldK2IqeVtpXTtcbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM+Pj1icGU7XG4gIH1cbiAgZm9yIChpPWs7aTxraztpKyspIHtcbiAgICBjKz1hKnhbaV07XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPj49YnBlO1xuICB9XG59XG5cbi8vZG8gdGhlIGxpbmVhciBjb21iaW5hdGlvbiB4PWEqeCtiKih5PDwoeXMqYnBlKSkgZm9yIGJpZ0ludHMgeCBhbmQgeSwgYW5kIGludGVnZXJzIGEsIGIgYW5kIHlzLlxuLy94IG11c3QgYmUgbGFyZ2UgZW5vdWdoIHRvIGhvbGQgdGhlIGFuc3dlci5cbmZ1bmN0aW9uIGxpbkNvbWJTaGlmdF8oeCx5LGIseXMpIHtcbiAgdmFyIGksYyxrLGtrO1xuICBrPXgubGVuZ3RoPHlzK3kubGVuZ3RoID8geC5sZW5ndGggOiB5cyt5Lmxlbmd0aDtcbiAga2s9eC5sZW5ndGg7XG4gIGZvciAoYz0wLGk9eXM7aTxrO2krKykge1xuICAgIGMrPXhbaV0rYip5W2kteXNdO1xuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz4+PWJwZTtcbiAgfVxuICBmb3IgKGk9aztjICYmIGk8a2s7aSsrKSB7XG4gICAgYys9eFtpXTtcbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM+Pj1icGU7XG4gIH1cbn1cblxuLy9kbyB4PXgrKHk8PCh5cypicGUpKSBmb3IgYmlnSW50cyB4IGFuZCB5LCBhbmQgaW50ZWdlcnMgYSxiIGFuZCB5cy5cbi8veCBtdXN0IGJlIGxhcmdlIGVub3VnaCB0byBob2xkIHRoZSBhbnN3ZXIuXG5mdW5jdGlvbiBhZGRTaGlmdF8oeCx5LHlzKSB7XG4gIHZhciBpLGMsayxraztcbiAgaz14Lmxlbmd0aDx5cyt5Lmxlbmd0aCA/IHgubGVuZ3RoIDogeXMreS5sZW5ndGg7XG4gIGtrPXgubGVuZ3RoO1xuICBmb3IgKGM9MCxpPXlzO2k8aztpKyspIHtcbiAgICBjKz14W2ldK3lbaS15c107XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPj49YnBlO1xuICB9XG4gIGZvciAoaT1rO2MgJiYgaTxraztpKyspIHtcbiAgICBjKz14W2ldO1xuICAgIHhbaV09YyAmIG1hc2s7XG4gICAgYz4+PWJwZTtcbiAgfVxufVxuXG4vL2RvIHg9eC0oeTw8KHlzKmJwZSkpIGZvciBiaWdJbnRzIHggYW5kIHksIGFuZCBpbnRlZ2VycyBhLGIgYW5kIHlzLlxuLy94IG11c3QgYmUgbGFyZ2UgZW5vdWdoIHRvIGhvbGQgdGhlIGFuc3dlci5cbmZ1bmN0aW9uIHN1YlNoaWZ0Xyh4LHkseXMpIHtcbiAgdmFyIGksYyxrLGtrO1xuICBrPXgubGVuZ3RoPHlzK3kubGVuZ3RoID8geC5sZW5ndGggOiB5cyt5Lmxlbmd0aDtcbiAga2s9eC5sZW5ndGg7XG4gIGZvciAoYz0wLGk9eXM7aTxrO2krKykge1xuICAgIGMrPXhbaV0teVtpLXlzXTtcbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM+Pj1icGU7XG4gIH1cbiAgZm9yIChpPWs7YyAmJiBpPGtrO2krKykge1xuICAgIGMrPXhbaV07XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPj49YnBlO1xuICB9XG59XG5cbi8vZG8geD14LXkgZm9yIGJpZ0ludHMgeCBhbmQgeS5cbi8veCBtdXN0IGJlIGxhcmdlIGVub3VnaCB0byBob2xkIHRoZSBhbnN3ZXIuXG4vL25lZ2F0aXZlIGFuc3dlcnMgd2lsbCBiZSAycyBjb21wbGVtZW50XG5mdW5jdGlvbiBzdWJfKHgseSkge1xuICB2YXIgaSxjLGssa2s7XG4gIGs9eC5sZW5ndGg8eS5sZW5ndGggPyB4Lmxlbmd0aCA6IHkubGVuZ3RoO1xuICBmb3IgKGM9MCxpPTA7aTxrO2krKykge1xuICAgIGMrPXhbaV0teVtpXTtcbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM+Pj1icGU7XG4gIH1cbiAgZm9yIChpPWs7YyAmJiBpPHgubGVuZ3RoO2krKykge1xuICAgIGMrPXhbaV07XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPj49YnBlO1xuICB9XG59XG5cbi8vZG8geD14K3kgZm9yIGJpZ0ludHMgeCBhbmQgeS5cbi8veCBtdXN0IGJlIGxhcmdlIGVub3VnaCB0byBob2xkIHRoZSBhbnN3ZXIuXG5mdW5jdGlvbiBhZGRfKHgseSkge1xuICB2YXIgaSxjLGssa2s7XG4gIGs9eC5sZW5ndGg8eS5sZW5ndGggPyB4Lmxlbmd0aCA6IHkubGVuZ3RoO1xuICBmb3IgKGM9MCxpPTA7aTxrO2krKykge1xuICAgIGMrPXhbaV0reVtpXTtcbiAgICB4W2ldPWMgJiBtYXNrO1xuICAgIGM+Pj1icGU7XG4gIH1cbiAgZm9yIChpPWs7YyAmJiBpPHgubGVuZ3RoO2krKykge1xuICAgIGMrPXhbaV07XG4gICAgeFtpXT1jICYgbWFzaztcbiAgICBjPj49YnBlO1xuICB9XG59XG5cbi8vZG8geD14KnkgZm9yIGJpZ0ludHMgeCBhbmQgeS4gIFRoaXMgaXMgZmFzdGVyIHdoZW4geTx4LlxuZnVuY3Rpb24gbXVsdF8oeCx5KSB7XG4gIHZhciBpO1xuICBpZiAoc3MubGVuZ3RoIT0yKngubGVuZ3RoKVxuICAgIHNzPW5ldyBBcnJheSgyKngubGVuZ3RoKTtcbiAgY29weUludF8oc3MsMCk7XG4gIGZvciAoaT0wO2k8eS5sZW5ndGg7aSsrKVxuICAgIGlmICh5W2ldKVxuICAgICAgbGluQ29tYlNoaWZ0Xyhzcyx4LHlbaV0saSk7ICAgLy9zcz0xKnNzK3lbaV0qKHg8PChpKmJwZSkpXG4gIGNvcHlfKHgsc3MpO1xufVxuXG4vL2RvIHg9eCBtb2QgbiBmb3IgYmlnSW50cyB4IGFuZCBuLlxuZnVuY3Rpb24gbW9kXyh4LG4pIHtcbiAgaWYgKHM0Lmxlbmd0aCE9eC5sZW5ndGgpXG4gICAgczQ9ZHVwKHgpO1xuICBlbHNlXG4gICAgY29weV8oczQseCk7XG4gIGlmIChzNS5sZW5ndGghPXgubGVuZ3RoKVxuICAgIHM1PWR1cCh4KTtcbiAgZGl2aWRlXyhzNCxuLHM1LHgpOyAgLy94ID0gcmVtYWluZGVyIG9mIHM0IC8gblxufVxuXG4vL2RvIHg9eCp5IG1vZCBuIGZvciBiaWdJbnRzIHgseSxuLlxuLy9mb3IgZ3JlYXRlciBzcGVlZCwgbGV0IHk8eC5cbmZ1bmN0aW9uIG11bHRNb2RfKHgseSxuKSB7XG4gIHZhciBpO1xuICBpZiAoczAubGVuZ3RoIT0yKngubGVuZ3RoKVxuICAgIHMwPW5ldyBBcnJheSgyKngubGVuZ3RoKTtcbiAgY29weUludF8oczAsMCk7XG4gIGZvciAoaT0wO2k8eS5sZW5ndGg7aSsrKVxuICAgIGlmICh5W2ldKVxuICAgICAgbGluQ29tYlNoaWZ0XyhzMCx4LHlbaV0saSk7ICAgLy9zMD0xKnMwK3lbaV0qKHg8PChpKmJwZSkpXG4gIG1vZF8oczAsbik7XG4gIGNvcHlfKHgsczApO1xufVxuXG4vL2RvIHg9eCp4IG1vZCBuIGZvciBiaWdJbnRzIHgsbi5cbmZ1bmN0aW9uIHNxdWFyZU1vZF8oeCxuKSB7XG4gIHZhciBpLGosZCxjLGt4LGtuLGs7XG4gIGZvciAoa3g9eC5sZW5ndGg7IGt4PjAgJiYgIXhba3gtMV07IGt4LS0pOyAgLy9pZ25vcmUgbGVhZGluZyB6ZXJvcyBpbiB4XG4gIGs9a3g+bi5sZW5ndGggPyAyKmt4IDogMipuLmxlbmd0aDsgLy9rPSMgZWxlbWVudHMgaW4gdGhlIHByb2R1Y3QsIHdoaWNoIGlzIHR3aWNlIHRoZSBlbGVtZW50cyBpbiB0aGUgbGFyZ2VyIG9mIHggYW5kIG5cbiAgaWYgKHMwLmxlbmd0aCE9aylcbiAgICBzMD1uZXcgQXJyYXkoayk7XG4gIGNvcHlJbnRfKHMwLDApO1xuICBmb3IgKGk9MDtpPGt4O2krKykge1xuICAgIGM9czBbMippXSt4W2ldKnhbaV07XG4gICAgczBbMippXT1jICYgbWFzaztcbiAgICBjPj49YnBlO1xuICAgIGZvciAoaj1pKzE7ajxreDtqKyspIHtcbiAgICAgIGM9czBbaStqXSsyKnhbaV0qeFtqXStjO1xuICAgICAgczBbaStqXT0oYyAmIG1hc2spO1xuICAgICAgYz4+PWJwZTtcbiAgICB9XG4gICAgczBbaStreF09YztcbiAgfVxuICBtb2RfKHMwLG4pO1xuICBjb3B5Xyh4LHMwKTtcbn1cblxuLy9yZXR1cm4geCB3aXRoIGV4YWN0bHkgayBsZWFkaW5nIHplcm8gZWxlbWVudHNcbmZ1bmN0aW9uIHRyaW0oeCxrKSB7XG4gIHZhciBpLHk7XG4gIGZvciAoaT14Lmxlbmd0aDsgaT4wICYmICF4W2ktMV07IGktLSk7XG4gIHk9bmV3IEFycmF5KGkrayk7XG4gIGNvcHlfKHkseCk7XG4gIHJldHVybiB5O1xufVxuXG4vL2RvIHg9eCoqeSBtb2Qgbiwgd2hlcmUgeCx5LG4gYXJlIGJpZ0ludHMgYW5kICoqIGlzIGV4cG9uZW50aWF0aW9uLiAgMCoqMD0xLlxuLy90aGlzIGlzIGZhc3RlciB3aGVuIG4gaXMgb2RkLiAgeCB1c3VhbGx5IG5lZWRzIHRvIGhhdmUgYXMgbWFueSBlbGVtZW50cyBhcyBuLlxuZnVuY3Rpb24gcG93TW9kXyh4LHksbikge1xuICB2YXIgazEsazIsa24sbnA7XG4gIGlmKHM3Lmxlbmd0aCE9bi5sZW5ndGgpXG4gICAgczc9ZHVwKG4pO1xuXG4gIC8vZm9yIGV2ZW4gbW9kdWx1cywgdXNlIGEgc2ltcGxlIHNxdWFyZS1hbmQtbXVsdGlwbHkgYWxnb3JpdGhtLFxuICAvL3JhdGhlciB0aGFuIHVzaW5nIHRoZSBtb3JlIGNvbXBsZXggTW9udGdvbWVyeSBhbGdvcml0aG0uXG4gIGlmICgoblswXSYxKT09MCkge1xuICAgIGNvcHlfKHM3LHgpO1xuICAgIGNvcHlJbnRfKHgsMSk7XG4gICAgd2hpbGUoIWVxdWFsc0ludCh5LDApKSB7XG4gICAgICBpZiAoeVswXSYxKVxuICAgICAgICBtdWx0TW9kXyh4LHM3LG4pO1xuICAgICAgZGl2SW50Xyh5LDIpO1xuICAgICAgc3F1YXJlTW9kXyhzNyxuKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy9jYWxjdWxhdGUgbnAgZnJvbSBuIGZvciB0aGUgTW9udGdvbWVyeSBtdWx0aXBsaWNhdGlvbnNcbiAgY29weUludF8oczcsMCk7XG4gIGZvciAoa249bi5sZW5ndGg7a24+MCAmJiAhbltrbi0xXTtrbi0tKTtcbiAgbnA9cmFkaXgtaW52ZXJzZU1vZEludChtb2RJbnQobixyYWRpeCkscmFkaXgpO1xuICBzN1trbl09MTtcbiAgbXVsdE1vZF8oeCAsczcsbik7ICAgLy8geCA9IHggKiAyKiooa24qYnApIG1vZCBuXG5cbiAgaWYgKHMzLmxlbmd0aCE9eC5sZW5ndGgpXG4gICAgczM9ZHVwKHgpO1xuICBlbHNlXG4gICAgY29weV8oczMseCk7XG5cbiAgZm9yIChrMT15Lmxlbmd0aC0xO2sxPjAgJiAheVtrMV07IGsxLS0pOyAgLy9rMT1maXJzdCBub256ZXJvIGVsZW1lbnQgb2YgeVxuICBpZiAoeVtrMV09PTApIHsgIC8vYW55dGhpbmcgdG8gdGhlIDB0aCBwb3dlciBpcyAxXG4gICAgY29weUludF8oeCwxKTtcbiAgICByZXR1cm47XG4gIH1cbiAgZm9yIChrMj0xPDwoYnBlLTEpO2syICYmICEoeVtrMV0gJiBrMik7IGsyPj49MSk7ICAvL2syPXBvc2l0aW9uIG9mIGZpcnN0IDEgYml0IGluIHlbazFdXG4gIGZvciAoOzspIHtcbiAgICBpZiAoIShrMj4+PTEpKSB7ICAvL2xvb2sgYXQgbmV4dCBiaXQgb2YgeVxuICAgICAgazEtLTtcbiAgICAgIGlmIChrMTwwKSB7XG4gICAgICAgIG1vbnRfKHgsb25lLG4sbnApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBrMj0xPDwoYnBlLTEpO1xuICAgIH1cbiAgICBtb250Xyh4LHgsbixucCk7XG5cbiAgICBpZiAoazIgJiB5W2sxXSkgLy9pZiBuZXh0IGJpdCBpcyBhIDFcbiAgICAgIG1vbnRfKHgsczMsbixucCk7XG4gIH1cbn1cblxuXG4vL2RvIHg9eCp5KlJpIG1vZCBuIGZvciBiaWdJbnRzIHgseSxuLFxuLy8gIHdoZXJlIFJpID0gMioqKC1rbipicGUpIG1vZCBuLCBhbmQga24gaXMgdGhlXG4vLyAgbnVtYmVyIG9mIGVsZW1lbnRzIGluIHRoZSBuIGFycmF5LCBub3Rcbi8vICBjb3VudGluZyBsZWFkaW5nIHplcm9zLlxuLy94IGFycmF5IG11c3QgaGF2ZSBhdCBsZWFzdCBhcyBtYW55IGVsZW1udHMgYXMgdGhlIG4gYXJyYXlcbi8vSXQncyBPSyBpZiB4IGFuZCB5IGFyZSB0aGUgc2FtZSB2YXJpYWJsZS5cbi8vbXVzdCBoYXZlOlxuLy8gIHgseSA8IG5cbi8vICBuIGlzIG9kZFxuLy8gIG5wID0gLShuXigtMSkpIG1vZCByYWRpeFxuZnVuY3Rpb24gbW9udF8oeCx5LG4sbnApIHtcbiAgdmFyIGksaixjLHVpLHQsa3M7XG4gIHZhciBrbj1uLmxlbmd0aDtcbiAgdmFyIGt5PXkubGVuZ3RoO1xuXG4gIGlmIChzYS5sZW5ndGghPWtuKVxuICAgIHNhPW5ldyBBcnJheShrbik7XG5cbiAgY29weUludF8oc2EsMCk7XG5cbiAgZm9yICg7a24+MCAmJiBuW2tuLTFdPT0wO2tuLS0pOyAvL2lnbm9yZSBsZWFkaW5nIHplcm9zIG9mIG5cbiAgZm9yICg7a3k+MCAmJiB5W2t5LTFdPT0wO2t5LS0pOyAvL2lnbm9yZSBsZWFkaW5nIHplcm9zIG9mIHlcbiAga3M9c2EubGVuZ3RoLTE7IC8vc2Egd2lsbCBuZXZlciBoYXZlIG1vcmUgdGhhbiB0aGlzIG1hbnkgbm9uemVybyBlbGVtZW50cy5cblxuICAvL3RoZSBmb2xsb3dpbmcgbG9vcCBjb25zdW1lcyA5NSUgb2YgdGhlIHJ1bnRpbWUgZm9yIHJhbmRUcnVlUHJpbWVfKCkgYW5kIHBvd01vZF8oKSBmb3IgbGFyZ2UgbnVtYmVyc1xuICBmb3IgKGk9MDsgaTxrbjsgaSsrKSB7XG4gICAgdD1zYVswXSt4W2ldKnlbMF07XG4gICAgdWk9KCh0ICYgbWFzaykgKiBucCkgJiBtYXNrOyAgLy90aGUgaW5uZXIgXCImIG1hc2tcIiB3YXMgbmVlZGVkIG9uIFNhZmFyaSAoYnV0IG5vdCBNU0lFKSBhdCBvbmUgdGltZVxuICAgIGM9KHQrdWkqblswXSkgPj4gYnBlO1xuICAgIHQ9eFtpXTtcblxuICAgIC8vZG8gc2E9KHNhK3hbaV0qeSt1aSpuKS9iICAgd2hlcmUgYj0yKipicGUuICBMb29wIGlzIHVucm9sbGVkIDUtZm9sZCBmb3Igc3BlZWRcbiAgICBqPTE7XG4gICAgZm9yICg7ajxreS00OykgeyBjKz1zYVtqXSt1aSpuW2pdK3QqeVtqXTsgICBzYVtqLTFdPWMgJiBtYXNrOyAgIGM+Pj1icGU7ICAgaisrO1xuICAgICAgICAgICAgICAgICAgICAgYys9c2Fbal0rdWkqbltqXSt0Knlbal07ICAgc2Fbai0xXT1jICYgbWFzazsgICBjPj49YnBlOyAgIGorKztcbiAgICAgICAgICAgICAgICAgICAgIGMrPXNhW2pdK3VpKm5bal0rdCp5W2pdOyAgIHNhW2otMV09YyAmIG1hc2s7ICAgYz4+PWJwZTsgICBqKys7XG4gICAgICAgICAgICAgICAgICAgICBjKz1zYVtqXSt1aSpuW2pdK3QqeVtqXTsgICBzYVtqLTFdPWMgJiBtYXNrOyAgIGM+Pj1icGU7ICAgaisrO1xuICAgICAgICAgICAgICAgICAgICAgYys9c2Fbal0rdWkqbltqXSt0Knlbal07ICAgc2Fbai0xXT1jICYgbWFzazsgICBjPj49YnBlOyAgIGorKzsgfVxuICAgIGZvciAoO2o8a3k7KSAgIHsgYys9c2Fbal0rdWkqbltqXSt0Knlbal07ICAgc2Fbai0xXT1jICYgbWFzazsgICBjPj49YnBlOyAgIGorKzsgfVxuICAgIGZvciAoO2o8a24tNDspIHsgYys9c2Fbal0rdWkqbltqXTsgICAgICAgICAgc2Fbai0xXT1jICYgbWFzazsgICBjPj49YnBlOyAgIGorKztcbiAgICAgICAgICAgICAgICAgICAgIGMrPXNhW2pdK3VpKm5bal07ICAgICAgICAgIHNhW2otMV09YyAmIG1hc2s7ICAgYz4+PWJwZTsgICBqKys7XG4gICAgICAgICAgICAgICAgICAgICBjKz1zYVtqXSt1aSpuW2pdOyAgICAgICAgICBzYVtqLTFdPWMgJiBtYXNrOyAgIGM+Pj1icGU7ICAgaisrO1xuICAgICAgICAgICAgICAgICAgICAgYys9c2Fbal0rdWkqbltqXTsgICAgICAgICAgc2Fbai0xXT1jICYgbWFzazsgICBjPj49YnBlOyAgIGorKztcbiAgICAgICAgICAgICAgICAgICAgIGMrPXNhW2pdK3VpKm5bal07ICAgICAgICAgIHNhW2otMV09YyAmIG1hc2s7ICAgYz4+PWJwZTsgICBqKys7IH1cbiAgICBmb3IgKDtqPGtuOykgICB7IGMrPXNhW2pdK3VpKm5bal07ICAgICAgICAgIHNhW2otMV09YyAmIG1hc2s7ICAgYz4+PWJwZTsgICBqKys7IH1cbiAgICBmb3IgKDtqPGtzOykgICB7IGMrPXNhW2pdOyAgICAgICAgICAgICAgICAgIHNhW2otMV09YyAmIG1hc2s7ICAgYz4+PWJwZTsgICBqKys7IH1cbiAgICBzYVtqLTFdPWMgJiBtYXNrO1xuICB9XG5cbiAgaWYgKCFncmVhdGVyKG4sc2EpKVxuICAgIHN1Yl8oc2Esbik7XG4gIGNvcHlfKHgsc2EpO1xufVxuXG5pZiAodHlwZW9mIG1vZHVsZSA9PT0gJ3VuZGVmaW5lZCcpIHtcblx0bW9kdWxlID0ge307XG59XG5CaWdJbnQgPSBtb2R1bGUuZXhwb3J0cyA9IHtcblx0J2FkZCc6IGFkZCwgJ2FkZEludCc6IGFkZEludCwgJ2JpZ0ludDJzdHInOiBiaWdJbnQyc3RyLCAnYml0U2l6ZSc6IGJpdFNpemUsXG5cdCdkdXAnOiBkdXAsICdlcXVhbHMnOiBlcXVhbHMsICdlcXVhbHNJbnQnOiBlcXVhbHNJbnQsICdleHBhbmQnOiBleHBhbmQsXG5cdCdmaW5kUHJpbWVzJzogZmluZFByaW1lcywgJ0dDRCc6IEdDRCwgJ2dyZWF0ZXInOiBncmVhdGVyLFxuXHQnZ3JlYXRlclNoaWZ0JzogZ3JlYXRlclNoaWZ0LCAnaW50MmJpZ0ludCc6IGludDJiaWdJbnQsXG5cdCdpbnZlcnNlTW9kJzogaW52ZXJzZU1vZCwgJ2ludmVyc2VNb2RJbnQnOiBpbnZlcnNlTW9kSW50LCAnaXNaZXJvJzogaXNaZXJvLFxuXHQnbWlsbGVyUmFiaW4nOiBtaWxsZXJSYWJpbiwgJ21pbGxlclJhYmluSW50JzogbWlsbGVyUmFiaW5JbnQsICdtb2QnOiBtb2QsXG5cdCdtb2RJbnQnOiBtb2RJbnQsICdtdWx0JzogbXVsdCwgJ211bHRNb2QnOiBtdWx0TW9kLCAnbmVnYXRpdmUnOiBuZWdhdGl2ZSxcblx0J3Bvd01vZCc6IHBvd01vZCwgJ3JhbmRCaWdJbnQnOiByYW5kQmlnSW50LCAncmFuZFRydWVQcmltZSc6IHJhbmRUcnVlUHJpbWUsXG5cdCdyYW5kUHJvYlByaW1lJzogcmFuZFByb2JQcmltZSwgJ3N0cjJiaWdJbnQnOiBzdHIyYmlnSW50LCAnc3ViJzogc3ViLFxuXHQndHJpbSc6IHRyaW0sICdhZGRJbnRfJzogYWRkSW50XywgJ2FkZF8nOiBhZGRfLCAnY29weV8nOiBjb3B5Xyxcblx0J2NvcHlJbnRfJzogY29weUludF8sICdHQ0RfJzogR0NEXywgJ2ludmVyc2VNb2RfJzogaW52ZXJzZU1vZF8sICdtb2RfJzogbW9kXyxcblx0J211bHRfJzogbXVsdF8sICdtdWx0TW9kXyc6IG11bHRNb2RfLCAncG93TW9kXyc6IHBvd01vZF8sXG5cdCdyYW5kQmlnSW50Xyc6IHJhbmRCaWdJbnRfLCAncmFuZFRydWVQcmltZV8nOiByYW5kVHJ1ZVByaW1lXywgJ3N1Yl8nOiBzdWJfLFxuXHQnYWRkU2hpZnRfJzogYWRkU2hpZnRfLCAnY2FycnlfJzogY2FycnlfLCAnZGl2aWRlXyc6IGRpdmlkZV8sXG5cdCdkaXZJbnRfJzogZGl2SW50XywgJ2VHQ0RfJzogZUdDRF8sICdoYWx2ZV8nOiBoYWx2ZV8sICdsZWZ0U2hpZnRfJzogbGVmdFNoaWZ0Xyxcblx0J2xpbkNvbWJfJzogbGluQ29tYl8sICdsaW5Db21iU2hpZnRfJzogbGluQ29tYlNoaWZ0XywgJ21vbnRfJzogbW9udF8sXG5cdCdtdWx0SW50Xyc6IG11bHRJbnRfLCAncmlnaHRTaGlmdF8nOiByaWdodFNoaWZ0XywgJ3NxdWFyZU1vZF8nOiBzcXVhcmVNb2RfLFxuXHQnc3ViU2hpZnRfJzogc3ViU2hpZnRfLCAncG93TW9kXyc6IHBvd01vZF8sICdlR0NEXyc6IGVHQ0RfLFxuXHQnaW52ZXJzZU1vZF8nOiBpbnZlcnNlTW9kXywgJ0dDRF8nOiBHQ0RfLCAnbW9udF8nOiBtb250XywgJ2RpdmlkZV8nOiBkaXZpZGVfLFxuXHQnc3F1YXJlTW9kXyc6IHNxdWFyZU1vZF8sICdyYW5kVHJ1ZVByaW1lXyc6IHJhbmRUcnVlUHJpbWVfLFxuXHQnbWlsbGVyUmFiaW4nOiBtaWxsZXJSYWJpblxufTtcblxufSkoKTtcbiIsInZhciBTb3J0ZWRBcnJheSA9IHJlcXVpcmUoJ3NvcnRlZC1jbXAtYXJyYXknKTtcblxuU29ydGVkQXJyYXkucHJvdG90eXBlLmdldCA9IGZ1bmN0aW9uKGVudHJ5KXtcbiAgICB2YXIgaW5kZXggPSB0aGlzLmluZGV4T2YoZW50cnkpO1xuICAgIHJldHVybiAoKGluZGV4ID49IDApJiZ0aGlzLmFycltpbmRleF0pIHx8IG51bGw7XG59O1xuXG5cblNvcnRlZEFycmF5LnByb3RvdHlwZS5jb250YWlucyA9IGZ1bmN0aW9uKGVudHJ5KXtcbiAgICByZXR1cm4gKHRoaXMuaW5kZXhPZihlbnRyeSkgPj0gMCk7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IFNvcnRlZEFycmF5O1xuIiwiLyohXG4gKiBcXGJyaWVmIG1lc3NhZ2UgcmVxdWVzdGluZyBhbiBleGNoYW5nZSBvZiBuZWlnaGJvcmhvb2RcbiAqIFxccGFyYW0gaW52aWV3IHRoZSBpZGVudGlmaWVyIG9mIHRoZSBpbnZpZXdcbiAqIFxccGFyYW0gb3V0dmlldyB0aGUgaWRlbnRpZmllciBvZiB0aGUgb3V0dmlld1xuICogXFxwYXJhbSBwcm90b2NvbCB0aGUgcHJvdG9jb2wgdGhhdCBjcmVhdGVzIHRoZSBtZXNzYWdlXG4gKi9cbm1vZHVsZS5leHBvcnRzLk1FeGNoYW5nZSA9IGZ1bmN0aW9uKGludmlldywgb3V0dmlldywgcHJvdG9jb2wpe1xuICAgIHJldHVybiB7cHJvdG9jb2w6ICdzcHJheS13cnRjJyxcbiAgICAgICAgICAgIHR5cGU6ICdNRXhjaGFuZ2UnLFxuICAgICAgICAgICAgaW52aWV3OiBpbnZpZXcsXG4gICAgICAgICAgICBvdXR2aWV3OiBvdXR2aWV3LFxuICAgICAgICAgICAgcHJvdG9jb2w6IHByb3RvY29sfTtcbn07XG4iLCJ2YXIgU29ydGVkQXJyYXkgPSByZXF1aXJlKFwiLi9leHRlbmRlZC1zb3J0ZWQtYXJyYXkuanNcIik7XG5cbi8qIVxuICogXFxicmllZiBzdHJ1Y3R1cmUgY29udGFpbmluZyB0aGUgbmVpZ2hib3Job29kIG9mIGEgcGVlci5cbiAqL1xuZnVuY3Rpb24gUGFydGlhbFZpZXcoKXtcbiAgICAvLyAjMSBpbml0aWFsaXplIHRoZSBwYXJ0aWFsIHZpZXcgYXMgYW4gYXJyYXkgc29ydGVkIGJ5IGFnZVxuICAgIC8vIGVudHJpZXMgYXJlIHthZ2UsIGlkLCBzb2NrZXRJZH1cbiAgICB0aGlzLmFycmF5ID0gbmV3IFNvcnRlZEFycmF5KENvbXBhcmF0b3IpO1xufTtcblxuLyohXG4gKiBcXHJldHVybiB0aGUgb2xkZXN0IHBlZXIgaW4gdGhlIGFycmF5XG4gKi9cblBhcnRpYWxWaWV3LnByb3RvdHlwZS5nZXRPbGRlc3QgPSBmdW5jdGlvbigpe1xuICAgIHJldHVybiB0aGlzLmFycmF5LmFyclswXTtcbn07XG5cbi8qIVxuICogXFxicmllZiBpbmNyZW1lbnQgdGhlIGFnZSBvZiB0aGUgd2hvbGUgcGFydGlhbCB2aWV3XG4gKi9cblBhcnRpYWxWaWV3LnByb3RvdHlwZS5pbmNyZW1lbnQgPSBmdW5jdGlvbigpe1xuICAgIGZvciAodmFyIGk9MDsgaTx0aGlzLmFycmF5LmFyci5sZW5ndGg7ICsraSl7XG4gICAgICAgIHRoaXMuYXJyYXkuYXJyW2ldLmFnZSArPSAxO1xuICAgIH07XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0IGEgc2FtcGxlIG9mIHRoZSBwYXJ0aWFsIHZpZXdcbiAqIFxccGFyYW0gbmVpZ2hib3IgdGhlIG5laWdoYm9yIHdoaWNoIHBlcmZvcm1zIHRoZSBleGNoYW5nZSB3aXRoIHVzXG4gKiBcXHBhcmFtIGlzSW5pdGlhdG9yIHdoZXRoZXIgb3Igbm90IHRoZSBjYWxsZXIgaXMgdGhlIGluaXRpYXRvciBvZiB0aGVcbiAqIGV4Y2hhbmdlXG4gKiBcXHJldHVybiBhbiBhcnJheSBjb250YWluaW5nIG5laWdoYm9ycyBmcm9tIHRoaXMgcGFydGlhbCB2aWV3XG4gKi9cblBhcnRpYWxWaWV3LnByb3RvdHlwZS5nZXRTYW1wbGUgPSBmdW5jdGlvbihuZWlnaGJvciwgaXNJbml0aWF0b3Ipe1xuICAgIHZhciBzYW1wbGUgPSBbXTtcbiAgICAvLyAjMSBjb3B5IHRoZSBwYXJ0aWFsIHZpZXdcbiAgICB2YXIgY2xvbmUgPSBuZXcgU29ydGVkQXJyYXkoQ29tcGFyYXRvcik7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLmFycmF5LmFyci5sZW5ndGg7ICsraSl7XG4gICAgICAgIGNsb25lLmFyci5wdXNoKHRoaXMuYXJyYXkuYXJyW2ldKTtcbiAgICB9O1xuXG4gICAgLy8gIzIgcHJvY2VzcyB0aGUgc2l6ZSBvZiB0aGUgc2FtcGxlXG4gICAgdmFyIHNhbXBsZVNpemUgPSBNYXRoLmNlaWwodGhpcy5hcnJheS5hcnIubGVuZ3RoLzIuKTtcbiAgICBcbiAgICBpZiAoaXNJbml0aWF0b3Ipe1xuICAgICAgICAvLyAjQSByZW1vdmUgYW4gb2NjdXJyZW5jZSBvZiB0aGUgY2hvc2VuIG5laWdoYm9yXG4gICAgICAgIHZhciBpbmRleCA9IGNsb25lLmluZGV4T2YobmVpZ2hib3IpO1xuICAgICAgICBzYW1wbGUucHVzaChjbG9uZS5hcnJbaW5kZXhdKTsgXG4gICAgICAgIGNsb25lLmFyci5zcGxpY2UoaW5kZXgsIDEpO1xuICAgIH07XG4gICAgXG4gICAgLy8gIzMgcmFuZG9tbHkgYWRkIG5laWdoYm9ycyB0byB0aGUgc2FtcGxlXG4gICAgd2hpbGUgKHNhbXBsZS5sZW5ndGggPCBzYW1wbGVTaXplKXtcbiAgICAgICAgdmFyIHJuID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKmNsb25lLmFyci5sZW5ndGgpO1xuICAgICAgICBzYW1wbGUucHVzaChjbG9uZS5hcnJbcm5dKTtcbiAgICAgICAgY2xvbmUuYXJyLnNwbGljZShybiwgMSk7XG4gICAgfTtcbiAgICBcbiAgICByZXR1cm4gc2FtcGxlO1xufTtcblxuXG5cbi8qIVxuICogXFxicmllZiByZXBsYWNlIHRoZSBvY2N1cnJlbmNlcyBvZiB0aGUgb2xkIHBlZXIgYnkgdGhlIGZyZXNoIG9uZVxuICogXFxwYXJhbSBzYW1wbGUgdGhlIHNhbXBsZSB0byBtb2RpZnlcbiAqIFxccGFyYW0gb2xkIHRoZSBvbGQgcmVmZXJlbmNlIHRvIHJlcGxhY2VcbiAqIFxccGFyYW0gZnJlc2ggdGhlIG5ldyByZWZlcmVuY2UgdG8gaW5zZXJ0XG4gKiBcXHJldHVybiBhbiBhcnJheSB3aXRoIHRoZSByZXBsYWNlZCBvY2N1cmVuY2VzXG4gKi9cblBhcnRpYWxWaWV3LnByb3RvdHlwZS5yZXBsYWNlID0gZnVuY3Rpb24oc2FtcGxlLCBvbGQsIGZyZXNoKXtcbiAgICB2YXIgcmVzdWx0ID0gW107XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzYW1wbGUubGVuZ3RoOyArK2kpe1xuICAgICAgICBpZiAoc2FtcGxlW2ldLmlkID09PSBvbGQuaWQpe1xuICAgICAgICAgICAgcmVzdWx0LnB1c2goZnJlc2gpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmVzdWx0LnB1c2goc2FtcGxlW2ldKTtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIHJldHVybiByZXN1bHQ7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgYWRkIHRoZSBuZWlnYmhvciB0byB0aGUgcGFydGlhbCB2aWV3IHdpdGggYW4gYWdlIG9mIDBcbiAqIFxccGFyYW0gaWQgdGhlIHBlZXIgdG8gYWRkIHRvIHRoZSBwYXJ0aWFsIHZpZXdcbiAqL1xuUGFydGlhbFZpZXcucHJvdG90eXBlLmFkZE5laWdoYm9yID0gZnVuY3Rpb24oaWQpe1xuICAgIHRoaXMuYXJyYXkuaW5zZXJ0KHthZ2U6IDAsIGlkOiBpZCwgcmFuZDogTWF0aC5yYW5kb20oKX0pO1xufTtcblxuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0IHRoZSBpbmRleCBvZiB0aGUgcGVlciBpbiB0aGUgcGFydGlhbHZpZXdcbiAqIFxccmV0dXJuIHRoZSBpbmRleCBvZiB0aGUgcGVlciBpbiB0aGUgYXJyYXksIC0xIGlmIG5vdCBmb3VuZFxuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUuZ2V0SW5kZXggPSBmdW5jdGlvbihpZCl7XG4gICAgdmFyIGkgPSAgdGhpcy5hcnJheS5hcnIubGVuZ3RoLTEsIGluZGV4ID0gLTEsIGZvdW5kID0gZmFsc2U7XG4gICAgd2hpbGUgKCFmb3VuZCAmJiBpID49IDApe1xuICAgICAgICBpZiAoaWQgPT09IHRoaXMuYXJyYXkuYXJyW2ldLmlkKXtcbiAgICAgICAgICAgIGZvdW5kID0gdHJ1ZTtcbiAgICAgICAgICAgIGluZGV4ID0gaTtcbiAgICAgICAgfTtcbiAgICAgICAgLS1pO1xuICAgIH07XG4gICAgcmV0dXJuIGluZGV4O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHJlbW92ZSB0aGUgcGVlciBmcm9tIHRoZSBwYXJ0aWFsIHZpZXdcbiAqIFxccGFyYW0gcGVlciB0aGUgcGVlciB0byByZW1vdmVcbiAqIFxccmV0dXJuIHRoZSByZW1vdmVkIGVudHJ5IGlmIGl0IGV4aXN0cywgbnVsbCBvdGhlcndpc2VcbiAqL1xuUGFydGlhbFZpZXcucHJvdG90eXBlLnJlbW92ZVBlZXIgPSBmdW5jdGlvbihpZCwgYWdlKXtcbiAgICBpZiAoIWFnZSl7ICAgIFxuICAgICAgICB2YXIgaW5kZXggPSB0aGlzLmdldEluZGV4KGlkKSwgcmVtb3ZlZEVudHJ5ID0gbnVsbDtcbiAgICAgICAgaWYgKGluZGV4ID4gLTEpe1xuICAgICAgICAgICAgcmVtb3ZlZEVudHJ5ID0gdGhpcy5hcnJheS5hcnJbaW5kZXhdO1xuICAgICAgICAgICAgdGhpcy5hcnJheS5hcnIuc3BsaWNlKGluZGV4LCAxKTtcbiAgICAgICAgfTtcbiAgICAgICAgcmV0dXJuIHJlbW92ZWRFbnRyeTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByZW1vdmVQZWVyQWdlLmNhbGwodGhpcywgaWQsIGFnZSk7XG4gICAgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiByZW1vdmUgdGhlIHBlZXIgd2l0aCB0aGUgYXNzb2NpYXRlZCBhZ2UgZnJvbSB0aGUgcGFydGlhbCB2aWV3XG4gKiBcXHBhcmFtIHBlZXIgdGhlIHBlZXIgdG8gcmVtb3ZlXG4gKiBcXHBhcmFtIGFnZSB0aGUgYWdlIG9mIHRoZSBwZWVyIHRvIHJlbW92ZVxuICogXFxyZXR1cm4gdGhlIHJlbW92ZWQgZW50cnkgaWYgaXQgZXhpc3RzLCBudWxsIG90aGVyd2lzZVxuICovXG5mdW5jdGlvbiByZW1vdmVQZWVyQWdlKGlkLCBhZ2Upe1xuICAgIHZhciBmb3VuZCA9IGZhbHNlLCBpID0gMCwgcmVtb3ZlZEVudHJ5ID0gbnVsbDtcbiAgICB3aGlsZSghZm91bmQgJiYgaSA8IHRoaXMuYXJyYXkuYXJyLmxlbmd0aCl7XG4gICAgICAgIGlmIChpZCA9PT0gdGhpcy5hcnJheS5hcnJbaV0uaWQgJiYgYWdlID09PSB0aGlzLmFycmF5LmFycltpXS5hZ2Upe1xuICAgICAgICAgICAgZm91bmQgPSB0cnVlO1xuICAgICAgICAgICAgcmVtb3ZlZEVudHJ5ID0gdGhpcy5hcnJheS5hcnJbaV07XG4gICAgICAgICAgICB0aGlzLmFycmF5LmFyci5zcGxpY2UoaSwgMSk7XG4gICAgICAgIH07XG4gICAgICAgICsraTtcbiAgICB9O1xuICAgIHJldHVybiByZW1vdmVkRW50cnk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgcmVtb3ZlIGFsbCBvY2N1cnJlbmNlcyBvZiB0aGUgcGVlciBhbmQgcmV0dXJuIHRoZSBudW1iZXIgb2YgcmVtb3ZhbHNcbiAqIFxccGFyYW0gcGVlciB0aGUgcGVlciB0byByZW1vdmVcbiAqIFxccmV0dXJuIHRoZSBudW1iZXIgb2Ygb2NjdXJyZW5jZXMgb2YgdGhlIHJlbW92ZWQgcGVlclxuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUucmVtb3ZlQWxsID0gZnVuY3Rpb24oaWQpe1xuICAgIHZhciBvY2MgPSAwLCBpID0gMDtcbiAgICB3aGlsZSAoaSA8IHRoaXMuYXJyYXkuYXJyLmxlbmd0aCl7XG4gICAgICAgIGlmICh0aGlzLmFycmF5LmFycltpXS5pZCA9PT0gaWQpe1xuICAgICAgICAgICAgdGhpcy5hcnJheS5hcnIuc3BsaWNlKGksIDEpO1xuICAgICAgICAgICAgb2NjICs9IDE7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICArK2k7XG4gICAgICAgIH07XG4gICAgfTtcbiAgICByZXR1cm4gb2NjO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHJlbW92ZSBhbGwgdGhlIGVsZW1lbnRzIGNvbnRhaW5lZCBpbiB0aGUgc2FtcGxlIGluIGFyZ3VtZW50XG4gKiBcXHBhcmFtIHNhbXBsZSB0aGUgZWxlbWVudHMgdG8gcmVtb3ZlXG4gKi9cblBhcnRpYWxWaWV3LnByb3RvdHlwZS5yZW1vdmVTYW1wbGUgPSBmdW5jdGlvbihzYW1wbGUpe1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc2FtcGxlLmxlbmd0aDsgKytpKXtcbiAgICAgICAgdGhpcy5yZW1vdmVQZWVyKHNhbXBsZVtpXS5pZCwgc2FtcGxlW2ldLmFnZSk7XG4gICAgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiBnZXQgdGhlIHNpemUgb2YgdGhlIHBhcnRpYWwgdmlld1xuICogXFxyZXR1cm4gdGhlIHNpemUgb2YgdGhlIHBhcnRpYWwgdmlld1xuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUubGVuZ3RoID0gZnVuY3Rpb24oKXtcbiAgICByZXR1cm4gdGhpcy5hcnJheS5hcnIubGVuZ3RoO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNoZWNrIGlmIHRoZSBwYXJ0aWFsIHZpZXcgY29udGFpbnMgdGhlIHJlZmVyZW5jZVxuICogXFxwYXJhbSBwZWVyIHRoZSBwZWVyIHRvIGNoZWNrXG4gKiBcXHJldHVybiB0cnVlIGlmIHRoZSBwZWVyIGlzIGluIHRoZSBwYXJ0aWFsIHZpZXcsIGZhbHNlIG90aGVyd2lzZVxuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUuY29udGFpbnMgPSBmdW5jdGlvbihpZCl7XG4gICAgcmV0dXJuIHRoaXMuZ2V0SW5kZXgoaWQpPj0wO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHJlbW92ZSBhbGwgZWxlbWVudHMgZnJvbSB0aGUgcGFydGlhbCB2aWV3XG4gKi9cblBhcnRpYWxWaWV3LnByb3RvdHlwZS5jbGVhciA9IGZ1bmN0aW9uKCl7XG4gICAgdGhpcy5hcnJheS5hcnIuc3BsaWNlKDAsIHRoaXMuYXJyYXkuYXJyLmxlbmd0aCk7XG59O1xuXG5cbi8qIVxuICogXFxicmllZiBnZXQgdGhlIGFycmF5IG9mIHBhaXJzIChhZ2UsIGlkKVxuICovXG5QYXJ0aWFsVmlldy5wcm90b3R5cGUuZ2V0ID0gZnVuY3Rpb24oKXtcbiAgICByZXR1cm4gdGhpcy5hcnJheS5hcnI7XG59O1xuXG5mdW5jdGlvbiBDb21wYXJhdG9yKGEsIGIpe1xuICAgIHZhciBmaXJzdCA9IGEuYWdlIHx8IGE7XG4gICAgdmFyIHNlY29uZCA9IGIuYWdlIHx8IGI7XG4gICAgaWYgKGZpcnN0IDwgc2Vjb25kKXsgcmV0dXJuIC0xO307XG4gICAgaWYgKGZpcnN0ID4gc2Vjb25kKXsgcmV0dXJuICAxO307XG4gICAgaWYgKGEucmFuZCA8IGIucmFuZCl7IHJldHVybiAtMTt9O1xuICAgIGlmIChhLnJhbmQgPiBiLnJhbmQpeyByZXR1cm4gIDE7fTtcbiAgICByZXR1cm4gMDtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gUGFydGlhbFZpZXc7XG4iLCJ2YXIgRXZlbnRFbWl0dGVyID0gcmVxdWlyZSgnZXZlbnRzJykuRXZlbnRFbWl0dGVyO1xudmFyIE5PID0gcmVxdWlyZSgnbjJuLW92ZXJsYXktd3J0YycpO1xudmFyIGNsb25lID0gcmVxdWlyZSgnY2xvbmUnKTtcbnZhciB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuXG52YXIgUGFydGlhbFZpZXcgPSByZXF1aXJlKCcuL3BhcnRpYWx2aWV3LmpzJyk7XG52YXIgR1VJRCA9IHJlcXVpcmUoJy4vZ3VpZC5qcycpO1xuXG52YXIgTUV4Y2hhbmdlID0gcmVxdWlyZSgnLi9tZXNzYWdlcy5qcycpLk1FeGNoYW5nZTtcblxudXRpbC5pbmhlcml0cyhTcHJheSwgRXZlbnRFbWl0dGVyKTtcblxuLyohXG4gKiBcXGJyaWVmIEltcGxlbWVudGF0aW9uIG9mIHRoZSByYW5kb20gcGVlciBzYW1wbGluZyBTcHJheVxuICovXG5mdW5jdGlvbiBTcHJheShvcHRpb25zKXtcbiAgICBFdmVudEVtaXR0ZXIuY2FsbCh0aGlzKTtcbiAgICAvLyAjQSBjb25zdGFudHNcbiAgICB0aGlzLnByb3RvY29sID0gKG9wdGlvbnMgJiYgb3B0aW9ucy5wcm90b2NvbCkgfHwgJ3NwcmF5LXdydGMnO1xuICAgIHRoaXMuREVMVEFUSU1FID0gKG9wdGlvbnMgJiYgb3B0aW9ucy5kZWx0YXRpbWUpIHx8IDEwMDAgKiA2MCAqIDI7IC8vIDJtaW5cblxuICAgIHZhciBvcHRzID0gKG9wdGlvbnMgJiYgY2xvbmUob3B0aW9ucykpIHx8IHt9O1xuICAgIG9wdHMucHJvdG9jb2wgPSB0aGlzLnByb3RvY29sKyctbjJuJztcbiAgICAvLyAjQiBwcm90b2NvbCB2YXJpYWJsZXNcbiAgICB0aGlzLnBhcnRpYWxWaWV3ID0gbmV3IFBhcnRpYWxWaWV3KCk7XG4gICAgdGhpcy5uZWlnaGJvcmhvb2RzID0gbmV3IE5PKG9wdHMpO1xuICAgIHRoaXMuc3RhdGUgPSAnZGlzY29ubmVjdCc7IC8vIChUT0RPKSB1cGRhdGUgc3RhdGVcblxuICAgIC8vICNDIHBlcmlvZGljIHNodWZmbGluZ1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBzZXRJbnRlcnZhbChmdW5jdGlvbigpe1xuICAgICAgICAoc2VsZi5wYXJ0aWFsVmlldy5sZW5ndGgoKT4wKSAmJiBleGNoYW5nZS5jYWxsKHNlbGYpO1xuICAgIH0sIHRoaXMuREVMVEFUSU1FKTtcbiAgICBcbiAgICAvLyAjRCByZWNlaXZlIGV2ZW50XG4gICAgZnVuY3Rpb24gcmVjZWl2ZShpZCwgbWVzc2FnZSl7XG4gICAgICAgIC8vICMwIG11c3QgY29udGFpbiBhIG1lc3NhZ2UgYW5kIGEgcHJvdG9jb2wsIG90aGVyd2lzZSBmb3J3YXJkXG4gICAgICAgIGlmICghbWVzc2FnZSB8fCBtZXNzYWdlLnByb3RvY29sIT09c2VsZi5wcm90b2NvbCl7XG4gICAgICAgICAgICBzZWxmLmVtaXQoJ3JlY2VpdmUnLCBpZCwgbWVzc2FnZSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH07XG4gICAgICAgIC8vICMyIGhhbmRsZSBtZXNzYWdlcyBmcm9tIHNwcmF5XG4gICAgICAgIHN3aXRjaCAobWVzc2FnZS50eXBlKXtcbiAgICAgICAgY2FzZSAnTUV4Y2hhbmdlJzpcbiAgICAgICAgICAgIG9uRXhjaGFuZ2UuY2FsbChzZWxmLCBtZXNzYWdlKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9O1xuICAgIH07XG5cbiAgICB0aGlzLm5laWdoYm9yaG9vZHMub24oJ3JlY2VpdmUnLCByZWNlaXZlKTtcbiAgICB0aGlzLm5laWdoYm9yaG9vZHMub24oJ3JlYWR5JywgZnVuY3Rpb24gKGlkLCB2aWV3KXtcbiAgICAgICAgKHZpZXcgPT09ICdvdXR2aWV3JykgJiYgc2VsZi5wYXJ0aWFsVmlldy5hZGROZWlnaGJvcihpZCk7XG4gICAgICAgIHVwZGF0ZVN0YXRlLmNhbGwoc2VsZik7XG4gICAgfSk7XG4gICAgXG4gICAgdGhpcy5uZWlnaGJvcmhvb2RzLm9uKCdmYWlsJywgZnVuY3Rpb24oaWQsIHZpZXcpe1xuICAgICAgICAodmlldyA9PT0gJ291dHZpZXcnKSAmJiBvbkFyY0Rvd24uY2FsbChzZWxmKTtcbiAgICB9KTtcbiAgICBcbiAgICB0aGlzLm5laWdoYm9yaG9vZHMub24oJ2Rpc2Nvbm5lY3QnLCBmdW5jdGlvbiAoaWQsIHZpZXcpe1xuICAgICAgICB1cGRhdGVTdGF0ZS5jYWxsKHNlbGYpO1xuICAgIH0pO1xuICAgIFxuICAgIC8vIChUT0RPKSByZW1vdmUgZmFzdCBhY2Nlc3MgdXNlZnVsbCA0IGRlYnVnXG4gICAgdGhpcy5leGNoYW5nZSA9IGZ1bmN0aW9uKCl7IGV4Y2hhbmdlLmNhbGwoc2VsZikgfTtcbn07XG5cblxuLyohXG4gKiBcXGJyaWVmIEpvaW5pbmcgYXM7IG9yIGNvbnRhY3RlZCBieSBhbiBvdXRzaWRlclxuICogXFxwYXJhbSBjYWxsYmFja3MgdGhlIGNhbGxiYWNrcyBmdW5jdGlvbiwgc2VlIG1vZHVsZSAnbjJuLW92ZXJsYXktd3J0YycuXG4gKi9cblNwcmF5LnByb3RvdHlwZS5jb25uZWN0aW9uID0gZnVuY3Rpb24oY2FsbGJhY2tzLCBtZXNzYWdlKXtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgdmFyIG9uUmVhZHlGdW5jdGlvbiA9IGNhbGxiYWNrcyAmJiBjYWxsYmFja3Mub25SZWFkeTtcbiAgICAvLyAjMSBpZiB0aGlzIHBlZXIgaXMgdGhlIGNvbnRhY3QsIG92ZXJsb2FkIHRoZSBvbnJlYWR5IGZ1bmN0aW9uXG4gICAgLy8gd2l0aCB0aGUgc3ByYXkgam9pbmluZyBtZWNoYW5pc20gdGhhdCB3aWxsIGluamVjdCBsb2coeCkgYXJjcyBpblxuICAgIC8vIHRoZSBuZXR3b3JrXG4gICAgaWYgKG1lc3NhZ2UpeyBcbiAgICAgICAgY2FsbGJhY2tzLm9uUmVhZHkgPSBmdW5jdGlvbihpZCl7XG4gICAgICAgICAgICBpZiAoc2VsZi5wYXJ0aWFsVmlldy5sZW5ndGgoKSA+IDApe1xuICAgICAgICAgICAgICAgIC8vICNBIHNpZ25hbCB0aGUgYXJyaXZhbCBvZiBhIG5ldyBwZWVyIHRvIGl0cyBvdXR2aWV3XG4gICAgICAgICAgICAgICAgc2VsZi5wYXJ0aWFsVmlldy5nZXQoKS5mb3JFYWNoKGZ1bmN0aW9uKG4pe1xuICAgICAgICAgICAgICAgICAgICBzZWxmLm5laWdoYm9yaG9vZHMuY29ubmVjdChuLCBpZCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vICNCIGFkZHMgaXQgdG8gaXRzIG93biBvdXR2aWV3IChmb3Igb25seSAyLXBlZXJzIG5ldHdvcmspXG4gICAgICAgICAgICAgICAgc2VsZi5uZWlnaGJvcmhvb2RzLmNvbm5lY3QobnVsbCwgaWQpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIC8vICNDIGNhbGxiYWNrIHRoZSBvcmlnaW5hbCBvblJlYWR5IGZ1bmN0aW9uXG4gICAgICAgICAgICBvblJlYWR5RnVuY3Rpb24gJiYgb25SZWFkeUZ1bmN0aW9uKGlkKTtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIC8vICMyIHN0YXJ0IGVzdGFibGlzaGluZyB0aGUgZmlyc3QgY29ubmVjdGlvblxuICAgIHRoaXMubmVpZ2hib3Job29kcy5jb25uZWN0aW9uKGNhbGxiYWNrcywgbWVzc2FnZSk7ICAgIFxufTtcbiAgICBcbi8qIVxuICogXFxicmllZiBMZWF2ZSB0aGUgbmV0d29ya1xuICogXFxwYXJhbSB0aW1lciB0aGUgdGltZW91dCBiZWZvcmUgcmVhbGx5IHNodXR0aW5nIGRvd24uIFRoZSB0aW1lIGNhblxuICogYmUgc3BlbnQgb24gaGVhbGluZyB0aGUgbmV0d29yayBiZWZvcmUgZGVwYXJ0dXJlLlxuICovXG5TcHJheS5wcm90b3R5cGUubGVhdmUgPSBmdW5jdGlvbih0aW1lcil7XG4gICAgdGhpcy5wYXJ0aWFsVmlldy5jbGVhcigpOyBcbiAgICB0aGlzLm5laWdoYm9yaG9vZHMuZGlzY29ubmVjdCgpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGdldCBhIHNldCBvZiBuZWlnaGJvcnMgZnJvbSBib3RoIGludmlldyBhbmQgb3V0dmlldy4gSXQgaXMgd29ydGhcbiAqIG5vdGluZyB0aGF0IGVhY2ggcGVlciBjb250cm9scyBpdHMgb3V0dmlldywgYnV0IG5vdCBpdHMgaW52aWV3LiBUaHVzLCB0aGUgXG4gKiBvdXR2aWV3IG1heSBiZSBsZXNzIHZlcnNhdGlsZS5cbiAqIFxccGFyYW0gayB0aGUgbnVtYmVyIG9mIG5laWdoYm9ycyByZXF1ZXN0ZWQsIGlmIGsgaXMgbm90IGRlZmluZWQsIGl0IHJldHVybnNcbiAqIGV2ZXJ5IGtub3duIGlkZW50aWZpZXJzLlxuICogXFxyZXR1cm4geyBpOltpZDEsaWQyLi4uaWRrXSwgbzpbaWQxLGlkMi4uLmlka10gfVxuICovXG5TcHJheS5wcm90b3R5cGUuZ2V0UGVlcnMgPSBmdW5jdGlvbihrKXtcbiAgICB2YXIgcmVzdWx0ID0ge2k6W10sIG86W119O1xuICAgIC8vICNBIGNvcHkgdGhlIGlkZW50aWZpZXJzIG9mIHRoZSBpbnZpZXdcbiAgICB2YXIgaW52aWV3ID0gdGhpcy5uZWlnaGJvcmhvb2RzLmdldCgnaW52aWV3Jyk7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBpbnZpZXcubGVuZ3RoOyArK2kpe1xuICAgICAgICByZXN1bHQuaS5wdXNoKGludmlld1tpXS5pZCk7XG4gICAgfTtcbiAgICAvLyAjQiByZW1vdmUgZW50cmllcyBpZiB0aGVyZSBhcmUgdG9vIG1hbnlcbiAgICB3aGlsZSAoayAmJiAocmVzdWx0LmkubGVuZ3RoID4gaykgJiYgKHJlc3VsdC5pLmxlbmd0aCA+IDApKXtcbiAgICAgICAgdmFyIHJuID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKnJlc3VsdC5pLmxlbmd0aCk7XG4gICAgICAgIHJlc3VsdC5pLnNwbGljZShybiwgMSk7XG4gICAgfTtcbiAgICAvLyAjQyBjb3B5IHRoZSBpZGVudGlmaWVycyBvZiB0aGUgb3V0dmlld1xuICAgIHZhciBvdXR2aWV3ID0gdGhpcy5uZWlnaGJvcmhvb2RzLmdldCgnb3V0dmlldycpO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgb3V0dmlldy5sZW5ndGg7ICsraSl7XG4gICAgICAgIHJlc3VsdC5vLnB1c2gob3V0dmlld1tpXS5pZCk7XG4gICAgfTtcbiAgICAvLyAjRCByZW1vdmUgZW50cmllcyBpZiB0aGVyZSBhcmUgdG9vIG1hbnlcbiAgICB3aGlsZSAoayAmJiAocmVzdWx0Lm8ubGVuZ3RoID4gaykgJiYgKHJlc3VsdC5vLmxlbmd0aCA+IDApKXtcbiAgICAgICAgdmFyIHJuID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKnJlc3VsdC5vLmxlbmd0aCk7XG4gICAgICAgIHJlc3VsdC5vLnNwbGljZShybiwgMSk7XG4gICAgfTtcbiAgICByZXR1cm4gcmVzdWx0O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHNlbmQgYSBtZXNzYWdlIHVzaW5nIHRoZSBpZCBvZiB0aGUgYXJjIHVzZWQgdG8gY29tbXVuaWNhdGVcbiAqIFxccGFyYW0gaWQgdGhlIGlkZW50aWZpZXIgb2YgdGhlIGNvbW11bmljYXRpb24gY2hhbm5lbFxuICogXFxwYXJhbSBtZXNzYWdlIHRoZSBtZXNzYWdlIHRvIHNlbmRcbiAqIFxccGFyYW0gcmV0dXJuIHRydWUgaWYgdGhlIG1lc3NhZ2UgaXMgc2VudCwgZmFsc2Ugb3RoZXJ3aXNlXG4gKi9cblNwcmF5LnByb3RvdHlwZS5zZW5kID0gZnVuY3Rpb24oaWQsIG1lc3NhZ2Upe1xuICAgIHZhciByZXN1bHQgPSB0aGlzLm5laWdoYm9yaG9vZHMuc2VuZChpZCwgbWVzc2FnZSk7XG4gICAgKCFyZXN1bHQpICYmIG9uUGVlckRvd24uY2FsbCh0aGlzLGlkKTtcbiAgICByZXR1cm4gcmVzdWx0O1xufTtcblxuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0IHRoZSBzdHJpbmcgcmVwcmVzZW50YXRpb24gb2YgdGhlIHBhcnRpYWwgdmlldyBvZiBzcHJheVxuICovIFxuU3ByYXkucHJvdG90eXBlLnRvU3RyaW5nID0gZnVuY3Rpb24oKXtcbiAgICB2YXIgcmVzdWx0ID0gJ0AnK3RoaXMubmVpZ2hib3Job29kcy5pbnZpZXcuSUQgKyc7JytcbiAgICAgICAgdGhpcy5uZWlnaGJvcmhvb2RzLm91dHZpZXcuSUQgKyAnICAgWyAnO1xuICAgIHZhciBwdiA9IHRoaXMucGFydGlhbFZpZXcuZ2V0KCk7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBwdi5sZW5ndGg7ICsraSl7XG4gICAgICAgIHJlc3VsdCArPSAnKCcrKHB2W2ldLmFnZSArICcgJyArIHB2W2ldLmlkICsnKSAnKTtcbiAgICB9O1xuICAgIHJlc3VsdCArPSAnXSc7XG4gICAgcmV0dXJuIHJlc3VsdDtcbn07XG5cbi8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4vLyAgICAgICAgUFJJVkFURSBmdW5jdGlvbnMgICAgICAgICAvL1xuLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cblxuLyohXG4gKiBcXGJyaWVmIHVwZGF0ZSB0aGUgbG9jYWwgY29ubmVjdGlvbiBzdGF0ZSBvZiB0aGUgcGVlciBhbmQgZW1pdCBhbiBldmVudFxuICogaWYgdGhlIHN0YXRlIGlzIGRpZmZlcmVudCB0aGFuIGF0IHRoZSBwcmV2aW91cyBjYWxsIG9mIHRoaXMgZnVuY3Rpb24uXG4gKiBUaGUgZW1pdHRlZCBldmVudCBpcyAnc3RhdGVjaGFuZ2UnIHdpdGggdGhlIFxuICogYXJndW1lbnRzICdjb25uZWN0JyB8ICdwYXJ0aWFsJyB8ICdkaXNjb25uZWN0J1xuICovXG5mdW5jdGlvbiB1cGRhdGVTdGF0ZSgpe1xuICAgIC8vIChUT0RPKSBoYW5kbGUgaXQgd2l0aG91dCByZWFjaGluZyB0aGUgbmVpZ2hib3Itd3J0YyBtb2R1bGUuLi5cbiAgICBpZiAodGhpcy5wYXJ0aWFsVmlldy5sZW5ndGgoKSA+IDAgJiZcbiAgICAgICAgdGhpcy5uZWlnaGJvcmhvb2RzLmkubGl2aW5nLm1zLmFyci5sZW5ndGggPiAwICYmXG4gICAgICAgIHRoaXMuc3RhdGUgIT09ICdjb25uZWN0Jyl7XG4gICAgICAgIC8vICMxIGNvbm5lY3RlZCBtZWFucyAoMSsgaW52aWV3LCAxKyBvdXR2aWV3KVxuICAgICAgICB0aGlzLnN0YXRlID0gJ2Nvbm5lY3QnO1xuICAgICAgICB0aGlzLmVtaXQoJ3N0YXRlY2hhbmdlJywgJ2Nvbm5lY3QnKTtcbiAgICB9IGVsc2UgaWYgKFxuICAgICAgICAodGhpcy5wYXJ0aWFsVmlldy5sZW5ndGgoKSA9PT0gMCB8fFxuICAgICAgICAgdGhpcy5uZWlnaGJvcmhvb2RzLmkubGl2aW5nLm1zLmFyci5sZW5ndGggPT09IDApICYmXG4gICAgICAgICAgICAodGhpcy5wYXJ0aWFsVmlldy5sZW5ndGgoKSA+IDAgfHxcbiAgICAgICAgICAgICB0aGlzLm5laWdoYm9yaG9vZHMuaS5saXZpbmcubXMuYXJyLmxlbmd0aCA+IDApICYmXG4gICAgICAgICAgICAodGhpcy5zdGF0ZSAhPT0gJ3BhcnRpYWwnKSl7XG4gICAgICAgIC8vICMyIHBhcnRpYWxseSBjb25uZWN0ZWQgbWVhbnMgKDErIGludmlldywgMCBvdXR2aWV3KSBvciAoMCBpLCAxKyBvKVxuICAgICAgICB0aGlzLnN0YXRlID0gJ3BhcnRpYWwnO1xuICAgICAgICB0aGlzLmVtaXQoJ3N0YXRlY2hhbmdlJywgJ3BhcnRpYWwnKTtcbiAgICB9IGVsc2UgaWYgKHRoaXMucGFydGlhbFZpZXcubGVuZ3RoKCkgPT09IDAgJiZcbiAgICAgICAgICAgICAgIHRoaXMubmVpZ2hib3Job29kcy5pLmxpdmluZy5tcy5hcnIubGVuZ3RoID09PSAwICYmICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICB0aGlzLnN0YXRlICE9PSAnZGlzY29ubmVjdCcpe1xuICAgICAgICAvLyAjMyBkaXNjb25uZWN0ZWQgbWVhbnMgKDAgaW52aWV3LCAwIG91dHZpZXcpXG4gICAgICAgIHRoaXMuc3RhdGUgPSAnZGlzY29ubmVjdCc7XG4gICAgICAgIHRoaXMuZW1pdCgnc3RhdGVjaGFuZ2UnLCAnZGlzY29ubmVjdCcpO1xuICAgIH07XG59O1xuXG4vKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKlxuICogU3ByYXkncyBwcm90b2NvbCBpbXBsZW1lbnRhdGlvblxuICoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKi9cblxuLyohXG4gKiBcXGJyaWVmIHBlcmlvZGljYWxseSBjYWxsZWQgZnVuY3Rpb24gdGhhdCBhaW1zIHRvIGJhbGFuY2UgdGhlIHBhcnRpYWwgdmlld1xuICogYW5kIHRvIG1peCB0aGUgbmVpZ2hib3Job29kc1xuICovXG5mdW5jdGlvbiBleGNoYW5nZSgpe1xuICAgIHZhciBzZWxmID0gdGhpcywgb2xkZXN0ID0gbnVsbCwgc2VudCA9IGZhbHNlO1xuICAgIHRoaXMucGFydGlhbFZpZXcuaW5jcmVtZW50KCk7XG4gICAgLy8gIzEgZ2V0IHRoZSBvbGRlc3QgbmVpZ2hib3IgcmVhY2hhYmxlXG4gICAgd2hpbGUgKCFvbGRlc3QgJiYgIXNlbnQgJiYgdGhpcy5wYXJ0aWFsVmlldy5sZW5ndGgoKT4wKXtcbiAgICAgICAgb2xkZXN0ID0gdGhpcy5wYXJ0aWFsVmlldy5nZXRPbGRlc3QoKTtcbiAgICAgICAgc2VudCA9IHRoaXMuc2VuZChvbGRlc3QuaWQsIE1FeGNoYW5nZSh0aGlzLm5laWdoYm9yaG9vZHMuaS5JRCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLm5laWdoYm9yaG9vZHMuby5JRCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnByb3RvY29sKSk7XG4gICAgICAgIHNlbnQgfHwgb25QZWVyRG93bi5jYWxsKHRoaXMsIG9sZGVzdCk7XG4gICAgfTtcbiAgICBpZiAodGhpcy5wYXJ0aWFsVmlldy5sZW5ndGgoKT09PTApe3JldHVybjt9OyAvLyB1Z2x5IHJldHVyblxuICAgIC8vICMyIGdldCBhIHNhbXBsZSBmcm9tIG91ciBwYXJ0aWFsIHZpZXcgKFRPRE8pIGJlZm9yZSBzZW5kaW5nIHRoZSBleGNoYW5nZSByZXF1ZXN0XG4gICAgdmFyIHNhbXBsZSA9IHRoaXMucGFydGlhbFZpZXcuZ2V0U2FtcGxlKG9sZGVzdCwgdHJ1ZSk7IFxuICAgIC8vICMzIGVzdGFibGlzaCBjb25uZWN0aW9ucyBvbGRlc3QgLT4gc2FtcGxlXG4gICAgLy8gI0EgcmVtb3ZlIHRoZSBjaG9zZW4gYXJjc1xuICAgIHNhbXBsZS5mb3JFYWNoKGZ1bmN0aW9uKGUpe1xuICAgICAgICBzZWxmLm5laWdoYm9yaG9vZHMuZGlzY29ubmVjdChlLmlkKTtcbiAgICAgICAgc2VsZi5wYXJ0aWFsVmlldy5yZW1vdmVQZWVyKGUuaWQsIGUuYWdlKTtcbiAgICB9KTtcbiAgICAvLyAjQiBmcm9tIG9sZGVzdCB0byBjaG9zZW4gbmVpZ2hib3JcbiAgICBzYW1wbGUuZm9yRWFjaChmdW5jdGlvbihlKXtcbiAgICAgICAgc2VsZi5uZWlnaGJvcmhvb2RzLmNvbm5lY3Qob2xkZXN0LmlkLCAoZS5pZCAhPT0gb2xkZXN0LmlkKSAmJiBlLmlkKTtcbiAgICB9KTtcbn07XG5cbi8qIVxuICogXFxicmllZiBldmVudCBleGVjdXRlZCB3aGVuIHdlIHJlY2VpdmUgYW4gZXhjaGFuZ2UgcmVxdWVzdFxuICogXFxwYXJhbSBtc2cgbWVzc2FnZSBjb250YWluaW5nIHRoZSBpZGVudGlmaWVyIG9mIHRoZSBwZWVyIHRoYXQgc3RhcnRlZCB0aGUgXG4gKiBleGNoYW5nZVxuICovXG5mdW5jdGlvbiBvbkV4Y2hhbmdlKG1zZyl7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIC8vICMxIGdldCBhIHNhbXBsZSBvZiBuZWlnaGJvcnMgZnJvbSBvdXIgcGFydGlhbCB2aWV3XG4gICAgdGhpcy5wYXJ0aWFsVmlldy5pbmNyZW1lbnQoKTtcbiAgICB2YXIgc2FtcGxlID0gdGhpcy5wYXJ0aWFsVmlldy5nZXRTYW1wbGUobXNnLmludmlldywgZmFsc2UpO1xuICAgIC8vICNBIHJlbW92ZSB0aGUgY2hvc2VuIG5laWdoYm9yIGZyb20gb3VyIHBhcnRpYWx2aWV3XG4gICAgc2FtcGxlLmZvckVhY2goZnVuY3Rpb24oZSl7XG4gICAgICAgIHNlbGYubmVpZ2hib3Job29kcy5kaXNjb25uZWN0KGUuaWQpO1xuICAgICAgICBzZWxmLnBhcnRpYWxWaWV3LnJlbW92ZVBlZXIoZS5pZCwgZS5hZ2UpO1xuICAgIH0pO1xuICAgIC8vICNCIGZyb20gaW5pdGlhdG9yIHRvIGNob3NlbiBuZWlnYmhvclxuICAgIHNhbXBsZS5mb3JFYWNoKGZ1bmN0aW9uKGUpe1xuICAgICAgICBzZWxmLm5laWdoYm9yaG9vZHMuY29ubmVjdChtc2cub3V0dmlldywgKGUuaWQgIT09IG1zZy5pbnZpZXcpICYmIGUuaWQpO1xuICAgIH0pO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHRoZSBmdW5jdGlvbiBjYWxsZWQgd2hlbiBhIG5laWdoYm9yIGlzIHVucmVhY2hhYmxlIGFuZCBzdXBwb3NlZGx5XG4gKiBjcmFzaGVkL2RlcGFydGVkLiBJdCBwcm9iYWJpbGlzdGljYWxseSBrZWVwcyBhbiBhcmMgdXBcbiAqIFxccGFyYW0gaWQgdGhlIGlkZW50aWZpZXIgb2YgdGhlIGNoYW5uZWwgdGhhdCBzZWVtcyBkb3duXG4gKi9cbmZ1bmN0aW9uIG9uUGVlckRvd24oaWQpe1xuICAgIGNvbnNvbGUubG9nKCdwZWVyZG93bicpO1xuICAgIC8vICNBIHJlbW92ZSBhbGwgb2NjdXJyZW5jZXMgb2YgdGhlIHBlZXIgaW4gdGhlIHBhcnRpYWwgdmlld1xuICAgIHZhciBvY2MgPSB0aGlzLnBhcnRpYWxWaWV3LnJlbW92ZUFsbChpZCk7XG4gICAgLy8gI0IgcHJvYmFiaWxpc3RpY2FsbHkgcmVjcmVhdGUgYW4gYXJjIHRvIGEga25vd24gcGVlclxuICAgIGlmICh0aGlzLnBhcnRpYWxWaWV3Lmxlbmd0aCgpID4gMCl7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgb2NjOyArK2kpe1xuICAgICAgICAgICAgaWYgKE1hdGgucmFuZG9tKCkgPiAoMS8odGhpcy5wYXJ0aWFsVmlldy5sZW5ndGgoKStvY2MpKSl7XG4gICAgICAgICAgICAgICAgdmFyIHJuID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKnRoaXMucGFydGlhbFZpZXcubGVuZ3RoKCkpO1xuICAgICAgICAgICAgICAgIHRoaXMubmVpZ2hib3Job29kcy5jb25uZWN0KG51bGwsdGhpcy5wYXJ0aWFsVmlldy5hcnJheS5hcnJbcm5dKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgIH07XG4gICAgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiBhIGNvbm5lY3Rpb24gZmFpbGVkIHRvIGVzdGFibGlzaCBwcm9wZXJseSwgc3lzdGVtYXRpY2FsbHkgZHVwbGljYXRlc1xuICogYW4gZWxlbWVudCBvZiB0aGUgcGFydGlhbCB2aWV3LiAoVE9ETykgaW50ZWdyYXRlcyB0aGlzXG4gKi9cbmZ1bmN0aW9uIG9uQXJjRG93bigpe1xuICAgIGNvbnNvbGUubG9nKCdhcmNkb3duJyk7XG4gICAgaWYgKHRoaXMucGFydGlhbFZpZXcubGVuZ3RoKCk+MCl7XG4gICAgICAgIHZhciBybiA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSp0aGlzLnBhcnRpYWxWaWV3Lmxlbmd0aCgpKTtcbiAgICAgICAgdGhpcy5uZWlnaGJvcmhvb2RzLmNvbm5lY3QobnVsbCwgdGhpcy5wYXJ0aWFsVmlldy5hcnJheS5hcnJbcm5dKTtcbiAgICB9O1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBTcHJheTtcbiIsIm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oaGF5c3RhY2ssIG5lZWRsZSwgY29tcGFyYXRvciwgbG93LCBoaWdoKSB7XG4gIHZhciBtaWQsIGNtcDtcblxuICBpZihsb3cgPT09IHVuZGVmaW5lZClcbiAgICBsb3cgPSAwO1xuXG4gIGVsc2Uge1xuICAgIGxvdyA9IGxvd3wwO1xuICAgIGlmKGxvdyA8IDAgfHwgbG93ID49IGhheXN0YWNrLmxlbmd0aClcbiAgICAgIHRocm93IG5ldyBSYW5nZUVycm9yKFwiaW52YWxpZCBsb3dlciBib3VuZFwiKTtcbiAgfVxuXG4gIGlmKGhpZ2ggPT09IHVuZGVmaW5lZClcbiAgICBoaWdoID0gaGF5c3RhY2subGVuZ3RoIC0gMTtcblxuICBlbHNlIHtcbiAgICBoaWdoID0gaGlnaHwwO1xuICAgIGlmKGhpZ2ggPCBsb3cgfHwgaGlnaCA+PSBoYXlzdGFjay5sZW5ndGgpXG4gICAgICB0aHJvdyBuZXcgUmFuZ2VFcnJvcihcImludmFsaWQgdXBwZXIgYm91bmRcIik7XG4gIH1cblxuICB3aGlsZShsb3cgPD0gaGlnaCkge1xuICAgIC8qIE5vdGUgdGhhdCBcIihsb3cgKyBoaWdoKSA+Pj4gMVwiIG1heSBvdmVyZmxvdywgYW5kIHJlc3VsdHMgaW4gYSB0eXBlY2FzdFxuICAgICAqIHRvIGRvdWJsZSAod2hpY2ggZ2l2ZXMgdGhlIHdyb25nIHJlc3VsdHMpLiAqL1xuICAgIG1pZCA9IGxvdyArIChoaWdoIC0gbG93ID4+IDEpO1xuICAgIGNtcCA9ICtjb21wYXJhdG9yKGhheXN0YWNrW21pZF0sIG5lZWRsZSk7XG5cbiAgICAvKiBUb28gbG93LiAqL1xuICAgIGlmKGNtcCA8IDAuMCkgXG4gICAgICBsb3cgID0gbWlkICsgMTtcblxuICAgIC8qIFRvbyBoaWdoLiAqL1xuICAgIGVsc2UgaWYoY21wID4gMC4wKVxuICAgICAgaGlnaCA9IG1pZCAtIDE7XG4gICAgXG4gICAgLyogS2V5IGZvdW5kLiAqL1xuICAgIGVsc2VcbiAgICAgIHJldHVybiBtaWQ7XG4gIH1cblxuICAvKiBLZXkgbm90IGZvdW5kLiAqL1xuICByZXR1cm4gfmxvdztcbn1cbiIsIihmdW5jdGlvbiAoQnVmZmVyKXtcbnZhciBjbG9uZSA9IChmdW5jdGlvbigpIHtcbid1c2Ugc3RyaWN0JztcblxuLyoqXG4gKiBDbG9uZXMgKGNvcGllcykgYW4gT2JqZWN0IHVzaW5nIGRlZXAgY29weWluZy5cbiAqXG4gKiBUaGlzIGZ1bmN0aW9uIHN1cHBvcnRzIGNpcmN1bGFyIHJlZmVyZW5jZXMgYnkgZGVmYXVsdCwgYnV0IGlmIHlvdSBhcmUgY2VydGFpblxuICogdGhlcmUgYXJlIG5vIGNpcmN1bGFyIHJlZmVyZW5jZXMgaW4geW91ciBvYmplY3QsIHlvdSBjYW4gc2F2ZSBzb21lIENQVSB0aW1lXG4gKiBieSBjYWxsaW5nIGNsb25lKG9iaiwgZmFsc2UpLlxuICpcbiAqIENhdXRpb246IGlmIGBjaXJjdWxhcmAgaXMgZmFsc2UgYW5kIGBwYXJlbnRgIGNvbnRhaW5zIGNpcmN1bGFyIHJlZmVyZW5jZXMsXG4gKiB5b3VyIHByb2dyYW0gbWF5IGVudGVyIGFuIGluZmluaXRlIGxvb3AgYW5kIGNyYXNoLlxuICpcbiAqIEBwYXJhbSBgcGFyZW50YCAtIHRoZSBvYmplY3QgdG8gYmUgY2xvbmVkXG4gKiBAcGFyYW0gYGNpcmN1bGFyYCAtIHNldCB0byB0cnVlIGlmIHRoZSBvYmplY3QgdG8gYmUgY2xvbmVkIG1heSBjb250YWluXG4gKiAgICBjaXJjdWxhciByZWZlcmVuY2VzLiAob3B0aW9uYWwgLSB0cnVlIGJ5IGRlZmF1bHQpXG4gKiBAcGFyYW0gYGRlcHRoYCAtIHNldCB0byBhIG51bWJlciBpZiB0aGUgb2JqZWN0IGlzIG9ubHkgdG8gYmUgY2xvbmVkIHRvXG4gKiAgICBhIHBhcnRpY3VsYXIgZGVwdGguIChvcHRpb25hbCAtIGRlZmF1bHRzIHRvIEluZmluaXR5KVxuICogQHBhcmFtIGBwcm90b3R5cGVgIC0gc2V0cyB0aGUgcHJvdG90eXBlIHRvIGJlIHVzZWQgd2hlbiBjbG9uaW5nIGFuIG9iamVjdC5cbiAqICAgIChvcHRpb25hbCAtIGRlZmF1bHRzIHRvIHBhcmVudCBwcm90b3R5cGUpLlxuKi9cbmZ1bmN0aW9uIGNsb25lKHBhcmVudCwgY2lyY3VsYXIsIGRlcHRoLCBwcm90b3R5cGUpIHtcbiAgdmFyIGZpbHRlcjtcbiAgaWYgKHR5cGVvZiBjaXJjdWxhciA9PT0gJ29iamVjdCcpIHtcbiAgICBkZXB0aCA9IGNpcmN1bGFyLmRlcHRoO1xuICAgIHByb3RvdHlwZSA9IGNpcmN1bGFyLnByb3RvdHlwZTtcbiAgICBmaWx0ZXIgPSBjaXJjdWxhci5maWx0ZXI7XG4gICAgY2lyY3VsYXIgPSBjaXJjdWxhci5jaXJjdWxhclxuICB9XG4gIC8vIG1haW50YWluIHR3byBhcnJheXMgZm9yIGNpcmN1bGFyIHJlZmVyZW5jZXMsIHdoZXJlIGNvcnJlc3BvbmRpbmcgcGFyZW50c1xuICAvLyBhbmQgY2hpbGRyZW4gaGF2ZSB0aGUgc2FtZSBpbmRleFxuICB2YXIgYWxsUGFyZW50cyA9IFtdO1xuICB2YXIgYWxsQ2hpbGRyZW4gPSBbXTtcblxuICB2YXIgdXNlQnVmZmVyID0gdHlwZW9mIEJ1ZmZlciAhPSAndW5kZWZpbmVkJztcblxuICBpZiAodHlwZW9mIGNpcmN1bGFyID09ICd1bmRlZmluZWQnKVxuICAgIGNpcmN1bGFyID0gdHJ1ZTtcblxuICBpZiAodHlwZW9mIGRlcHRoID09ICd1bmRlZmluZWQnKVxuICAgIGRlcHRoID0gSW5maW5pdHk7XG5cbiAgLy8gcmVjdXJzZSB0aGlzIGZ1bmN0aW9uIHNvIHdlIGRvbid0IHJlc2V0IGFsbFBhcmVudHMgYW5kIGFsbENoaWxkcmVuXG4gIGZ1bmN0aW9uIF9jbG9uZShwYXJlbnQsIGRlcHRoKSB7XG4gICAgLy8gY2xvbmluZyBudWxsIGFsd2F5cyByZXR1cm5zIG51bGxcbiAgICBpZiAocGFyZW50ID09PSBudWxsKVxuICAgICAgcmV0dXJuIG51bGw7XG5cbiAgICBpZiAoZGVwdGggPT0gMClcbiAgICAgIHJldHVybiBwYXJlbnQ7XG5cbiAgICB2YXIgY2hpbGQ7XG4gICAgdmFyIHByb3RvO1xuICAgIGlmICh0eXBlb2YgcGFyZW50ICE9ICdvYmplY3QnKSB7XG4gICAgICByZXR1cm4gcGFyZW50O1xuICAgIH1cblxuICAgIGlmIChjbG9uZS5fX2lzQXJyYXkocGFyZW50KSkge1xuICAgICAgY2hpbGQgPSBbXTtcbiAgICB9IGVsc2UgaWYgKGNsb25lLl9faXNSZWdFeHAocGFyZW50KSkge1xuICAgICAgY2hpbGQgPSBuZXcgUmVnRXhwKHBhcmVudC5zb3VyY2UsIF9fZ2V0UmVnRXhwRmxhZ3MocGFyZW50KSk7XG4gICAgICBpZiAocGFyZW50Lmxhc3RJbmRleCkgY2hpbGQubGFzdEluZGV4ID0gcGFyZW50Lmxhc3RJbmRleDtcbiAgICB9IGVsc2UgaWYgKGNsb25lLl9faXNEYXRlKHBhcmVudCkpIHtcbiAgICAgIGNoaWxkID0gbmV3IERhdGUocGFyZW50LmdldFRpbWUoKSk7XG4gICAgfSBlbHNlIGlmICh1c2VCdWZmZXIgJiYgQnVmZmVyLmlzQnVmZmVyKHBhcmVudCkpIHtcbiAgICAgIGNoaWxkID0gbmV3IEJ1ZmZlcihwYXJlbnQubGVuZ3RoKTtcbiAgICAgIHBhcmVudC5jb3B5KGNoaWxkKTtcbiAgICAgIHJldHVybiBjaGlsZDtcbiAgICB9IGVsc2Uge1xuICAgICAgaWYgKHR5cGVvZiBwcm90b3R5cGUgPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgcHJvdG8gPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YocGFyZW50KTtcbiAgICAgICAgY2hpbGQgPSBPYmplY3QuY3JlYXRlKHByb3RvKTtcbiAgICAgIH1cbiAgICAgIGVsc2Uge1xuICAgICAgICBjaGlsZCA9IE9iamVjdC5jcmVhdGUocHJvdG90eXBlKTtcbiAgICAgICAgcHJvdG8gPSBwcm90b3R5cGU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGNpcmN1bGFyKSB7XG4gICAgICB2YXIgaW5kZXggPSBhbGxQYXJlbnRzLmluZGV4T2YocGFyZW50KTtcblxuICAgICAgaWYgKGluZGV4ICE9IC0xKSB7XG4gICAgICAgIHJldHVybiBhbGxDaGlsZHJlbltpbmRleF07XG4gICAgICB9XG4gICAgICBhbGxQYXJlbnRzLnB1c2gocGFyZW50KTtcbiAgICAgIGFsbENoaWxkcmVuLnB1c2goY2hpbGQpO1xuICAgIH1cblxuICAgIGZvciAodmFyIGkgaW4gcGFyZW50KSB7XG4gICAgICB2YXIgYXR0cnM7XG4gICAgICBpZiAocHJvdG8pIHtcbiAgICAgICAgYXR0cnMgPSBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKHByb3RvLCBpKTtcbiAgICAgIH1cblxuICAgICAgaWYgKGF0dHJzICYmIGF0dHJzLnNldCA9PSBudWxsKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY2hpbGRbaV0gPSBfY2xvbmUocGFyZW50W2ldLCBkZXB0aCAtIDEpO1xuICAgIH1cblxuICAgIHJldHVybiBjaGlsZDtcbiAgfVxuXG4gIHJldHVybiBfY2xvbmUocGFyZW50LCBkZXB0aCk7XG59XG5cbi8qKlxuICogU2ltcGxlIGZsYXQgY2xvbmUgdXNpbmcgcHJvdG90eXBlLCBhY2NlcHRzIG9ubHkgb2JqZWN0cywgdXNlZnVsbCBmb3IgcHJvcGVydHlcbiAqIG92ZXJyaWRlIG9uIEZMQVQgY29uZmlndXJhdGlvbiBvYmplY3QgKG5vIG5lc3RlZCBwcm9wcykuXG4gKlxuICogVVNFIFdJVEggQ0FVVElPTiEgVGhpcyBtYXkgbm90IGJlaGF2ZSBhcyB5b3Ugd2lzaCBpZiB5b3UgZG8gbm90IGtub3cgaG93IHRoaXNcbiAqIHdvcmtzLlxuICovXG5jbG9uZS5jbG9uZVByb3RvdHlwZSA9IGZ1bmN0aW9uIGNsb25lUHJvdG90eXBlKHBhcmVudCkge1xuICBpZiAocGFyZW50ID09PSBudWxsKVxuICAgIHJldHVybiBudWxsO1xuXG4gIHZhciBjID0gZnVuY3Rpb24gKCkge307XG4gIGMucHJvdG90eXBlID0gcGFyZW50O1xuICByZXR1cm4gbmV3IGMoKTtcbn07XG5cbi8vIHByaXZhdGUgdXRpbGl0eSBmdW5jdGlvbnNcblxuZnVuY3Rpb24gX19vYmpUb1N0cihvKSB7XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwobyk7XG59O1xuY2xvbmUuX19vYmpUb1N0ciA9IF9fb2JqVG9TdHI7XG5cbmZ1bmN0aW9uIF9faXNEYXRlKG8pIHtcbiAgcmV0dXJuIHR5cGVvZiBvID09PSAnb2JqZWN0JyAmJiBfX29ialRvU3RyKG8pID09PSAnW29iamVjdCBEYXRlXSc7XG59O1xuY2xvbmUuX19pc0RhdGUgPSBfX2lzRGF0ZTtcblxuZnVuY3Rpb24gX19pc0FycmF5KG8pIHtcbiAgcmV0dXJuIHR5cGVvZiBvID09PSAnb2JqZWN0JyAmJiBfX29ialRvU3RyKG8pID09PSAnW29iamVjdCBBcnJheV0nO1xufTtcbmNsb25lLl9faXNBcnJheSA9IF9faXNBcnJheTtcblxuZnVuY3Rpb24gX19pc1JlZ0V4cChvKSB7XG4gIHJldHVybiB0eXBlb2YgbyA9PT0gJ29iamVjdCcgJiYgX19vYmpUb1N0cihvKSA9PT0gJ1tvYmplY3QgUmVnRXhwXSc7XG59O1xuY2xvbmUuX19pc1JlZ0V4cCA9IF9faXNSZWdFeHA7XG5cbmZ1bmN0aW9uIF9fZ2V0UmVnRXhwRmxhZ3MocmUpIHtcbiAgdmFyIGZsYWdzID0gJyc7XG4gIGlmIChyZS5nbG9iYWwpIGZsYWdzICs9ICdnJztcbiAgaWYgKHJlLmlnbm9yZUNhc2UpIGZsYWdzICs9ICdpJztcbiAgaWYgKHJlLm11bHRpbGluZSkgZmxhZ3MgKz0gJ20nO1xuICByZXR1cm4gZmxhZ3M7XG59O1xuY2xvbmUuX19nZXRSZWdFeHBGbGFncyA9IF9fZ2V0UmVnRXhwRmxhZ3M7XG5cbnJldHVybiBjbG9uZTtcbn0pKCk7XG5cbmlmICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykge1xuICBtb2R1bGUuZXhwb3J0cyA9IGNsb25lO1xufVxuXG59KS5jYWxsKHRoaXMscmVxdWlyZShcImJ1ZmZlclwiKS5CdWZmZXIpIiwiXG5tb2R1bGUuZXhwb3J0cy5NQ29ubmVjdFRvID0gZnVuY3Rpb24ocHJvdG9jb2wsIGZyb20sIHRvKXtcbiAgICByZXR1cm4geyBwcm90b2NvbDogcHJvdG9jb2wsXG4gICAgICAgICAgICAgdHlwZTogJ01Db25uZWN0VG8nLFxuICAgICAgICAgICAgIGZyb206IGZyb20sXG4gICAgICAgICAgICAgdG86IHRvIH07XG59O1xuXG5tb2R1bGUuZXhwb3J0cy5NRm9yd2FyZFRvID0gZnVuY3Rpb24oZnJvbSwgdG8sIG1lc3NhZ2UsIHByb3RvY29sKXtcbiAgICByZXR1cm4geyBwcm90b2NvbDogcHJvdG9jb2wsXG4gICAgICAgICAgICAgdHlwZTogJ01Gb3J3YXJkVG8nLFxuICAgICAgICAgICAgIGZyb206IGZyb20sXG4gICAgICAgICAgICAgdG86IHRvLFxuICAgICAgICAgICAgIG1lc3NhZ2U6IG1lc3NhZ2UgfTtcbn07XG5cbm1vZHVsZS5leHBvcnRzLk1Gb3J3YXJkZWQgPSBmdW5jdGlvbihmcm9tLCB0bywgbWVzc2FnZSwgcHJvdG9jb2wpe1xuICAgIHJldHVybiB7IHByb3RvY29sOiBwcm90b2NvbCxcbiAgICAgICAgICAgICB0eXBlOiAnTUZvcndhcmRlZCcsXG4gICAgICAgICAgICAgZnJvbTogZnJvbSxcbiAgICAgICAgICAgICB0bzogdG8sXG4gICAgICAgICAgICAgbWVzc2FnZTogbWVzc2FnZSB9O1xufTtcblxubW9kdWxlLmV4cG9ydHMuTURpcmVjdCA9IGZ1bmN0aW9uKGZyb20sIG1lc3NhZ2UsIHByb3RvY29sKXtcbiAgICByZXR1cm4geyBwcm90b2NvbDogcHJvdG9jb2wsXG4gICAgICAgICAgICAgdHlwZTogJ01EaXJlY3QnLFxuICAgICAgICAgICAgIGZyb206IGZyb20sXG4gICAgICAgICAgICAgbWVzc2FnZTogbWVzc2FnZSB9O1xufTtcbiIsInZhciBOZWlnaGJvcmhvb2QgPSByZXF1aXJlKCduZWlnaGJvcmhvb2Qtd3J0YycpO1xudmFyIEV2ZW50RW1pdHRlciA9IHJlcXVpcmUoJ2V2ZW50cycpLkV2ZW50RW1pdHRlcjtcbnZhciB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuXG51dGlsLmluaGVyaXRzKE5laWdoYm9yLCBFdmVudEVtaXR0ZXIpO1xuXG52YXIgTUZvcndhcmRUbyA9IHJlcXVpcmUoJy4vbWVzc2FnZXMuanMnKS5NRm9yd2FyZFRvO1xudmFyIE1Gb3J3YXJkZWQgPSByZXF1aXJlKCcuL21lc3NhZ2VzLmpzJykuTUZvcndhcmRlZDtcbnZhciBNQ29ubmVjdFRvID0gcmVxdWlyZSgnLi9tZXNzYWdlcy5qcycpLk1Db25uZWN0VG87XG52YXIgTURpcmVjdCA9IHJlcXVpcmUoJy4vbWVzc2FnZXMuanMnKS5NRGlyZWN0O1xuXG5cbi8qIVxuICogXFxicmllZiBBIG5laWdoYm9yIGhhcyBhbiBpbnZpZXcgYW5kIGFuIG91dHZpZXcgYW5kIGlzIGFibGUgdG8gYWN0IGFzIGEgYnJpZGdlXG4gKiBiZXR3ZWVuIGl0cyBuZWlnaGJvcnMgc28gdGhleSBjYW4gZXN0YWJsaXNoIHRoZWlyIG93biBjb21tdW5pY2F0aW9uIGNoYW5uZWxzXG4gKi9cbmZ1bmN0aW9uIE5laWdoYm9yKG9wdGlvbnMpe1xuICAgIEV2ZW50RW1pdHRlci5jYWxsKHRoaXMpO1xuICAgIHZhciBwcm90b2NvbCA9IChvcHRpb25zICYmIG9wdGlvbnMucHJvdG9jb2wpIHx8ICduMm4tb3ZlcmxheS13cnRjJztcbiAgICAvLyAjMSBkaXNzb2NpYXRlIGVudGVyaW5nIGFyY3MgZnJvbSBvdXRnb2luZyBhcmNzXG4gICAgdGhpcy5pbnZpZXcgPSAob3B0aW9ucyAmJiBvcHRpb25zLmludmlldykgfHwgbmV3IE5laWdoYm9yaG9vZChvcHRpb25zKTtcbiAgICB0aGlzLm91dHZpZXcgPSAob3B0aW9ucyAmJiBvcHRpb25zLm91dHZpZXcpIHx8IG5ldyBOZWlnaGJvcmhvb2Qob3B0aW9ucyk7XG4gICAgLy8gIzIgY29uY2lzZSBhY2Nlc3NcbiAgICB0aGlzLmkgPSB0aGlzLmludmlldztcbiAgICB0aGlzLm8gPSB0aGlzLm91dHZpZXc7XG4gICAgXG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIC8vICNBIGNhbGxiYWNrcyB3aGVuIHRoZXJlIGlzIGEgYnJpZGdlIHRvIGNyZWF0ZSBhIGNvbm5lY3Rpb25cbiAgICB2YXIgY2FsbGJhY2tzID0gZnVuY3Rpb24oaWQsIG1lc3NhZ2UsIHZpZXcpe1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb25Jbml0aWF0ZTogZnVuY3Rpb24ob2ZmZXIpe1xuICAgICAgICAgICAgICAgIHNlbGYuc2VuZChpZCwgTUZvcndhcmRUbyhtZXNzYWdlLmZyb20sIG1lc3NhZ2UudG8sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9mZmVyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm90b2NvbCkpO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIG9uQWNjZXB0OiBmdW5jdGlvbihvZmZlcil7XG4gICAgICAgICAgICAgICAgc2VsZi5zZW5kKGlkLCBNRm9yd2FyZFRvKG1lc3NhZ2UudG8sIG1lc3NhZ2UuZnJvbSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2ZmZXIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3RvY29sKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgfTtcbiAgICAvLyAjQiBjYWxsYmFja3Mgd2hlbiBpdCBlc3RhYmxpc2hlcyBhIGNvbm5lY3Rpb24gdG8gYSBuZWlnaGJvciwgZWl0aGVyXG4gICAgLy8gdGhpcyAtPiBuZWlnaGJvciBvciBuZWlnYmhvciAtPiB0aGlzLiBJdCBpcyB3b3J0aCBub3RpbmcgdGhhdCBpZiBpdFxuICAgIC8vIGEgY2hhbm5lbCBleGlzdHMgaW4gdGhlIGludmlldyBhbmQgd2Ugd2FudCB0byBjcmVhdGUgYW4gaWRlbnRpY2FsIGluIHRoZVxuICAgIC8vIG91dHZpZXcsIGEgbmV3IGNoYW5uZWwgbXVzdCBiZSBjcmVhdGVkOyBmb3IgdGhlIHBlZXIgdGhhdCBvd25zIHRoZSBhcmNcbiAgICAvLyBpbiBpdHMgb3V0dmlldyBjYW4gZGVzdHJveSBpdCB3aXRob3V0IHdhcm5pbmcuXG4gICAgdmFyIGRpcmVjdENhbGxiYWNrcyA9IGZ1bmN0aW9uKGlkLCBpZFZpZXcsIHZpZXcpe1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb25Jbml0aWF0ZTogZnVuY3Rpb24ob2ZmZXIpe1xuICAgICAgICAgICAgICAgIHNlbGYuc2VuZChpZCwgTURpcmVjdChpZFZpZXcsIG9mZmVyLCBwcm90b2NvbCkpO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIG9uQWNjZXB0OiBmdW5jdGlvbihvZmZlcil7XG4gICAgICAgICAgICAgICAgc2VsZi5zZW5kKGlkLCBNRGlyZWN0KGlkVmlldywgb2ZmZXIsIHByb3RvY29sKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgfTsgICAgICBcblxuICAgIC8vICNDIHJlY2VpdmUgYSBtZXNzYWdlIGZyb20gYW4gYXJjLCBpdCBmb3J3YXJkcyBpdCB0byBhIGxpc3RlbmVyXG4gICAgLy8gb2YgdGhpcyBtb2R1bGUsIG90aGVyd2lzZSwgaXQga2VlcHMgYW5kIGludGVycHJldHMgaXQuXG4gICAgZnVuY3Rpb24gcmVjZWl2ZShpZCwgbWVzc2FnZSl7XG4gICAgICAgIC8vICMxIHJlZGlyZWN0ICAgICAgIFxuICAgICAgICBpZiAoIW1lc3NhZ2UucHJvdG9jb2wgfHwgbWVzc2FnZS5wcm90b2NvbCE9PXByb3RvY29sKXtcbiAgICAgICAgICAgIHNlbGYuZW1pdCgncmVjZWl2ZScsIGlkLCBtZXNzYWdlKTtcbiAgICAgICAgICAgIHJldHVybjsgLy8gdWdseSBlYXJseSByZXR1cm5cbiAgICAgICAgfTtcbiAgICAgICAgLy8gIzIgb3RoZXJ3aXNlLCBpbnRlcnByZXRcbiAgICAgICAgc3dpdGNoIChtZXNzYWdlLnR5cGUpe1xuICAgICAgICBjYXNlICdNQ29ubmVjdFRvJzogLy8gI0EgYSBuZWlnaGJvciBhc2tzIHVzIHRvIGNvbm5lY3QgdG8gYSByZW1vdGUgb25lXG4gICAgICAgICAgICBpZiAobWVzc2FnZS50byAmJiBtZXNzYWdlLmZyb20pe1xuICAgICAgICAgICAgICAgIHNlbGYuY29ubmVjdGlvbihjYWxsYmFja3MoaWQsIG1lc3NhZ2UsICdvdXR2aWV3JykpO1xuICAgICAgICAgICAgfSBlbHNlIHsgLy8gI0IgYSBuZWlnaGJvciBhc2tzIHVzIHRvIGNvbm5lY3QgdG8gaGltXG4gICAgICAgICAgICAgICAgc2VsZi5jb25uZWN0aW9uKGRpcmVjdENhbGxiYWNrcyhpZCwgc2VsZi5vdXR2aWV3LklELCdvdXR2aWV3JykpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdNRm9yd2FyZFRvJzogLy8gI0MgYSBtZXNzYWdlIGlzIHRvIGJlIGZvcndhcmRlZCB0byBhIG5laWdoYm9yXG4gICAgICAgICAgICBzZWxmLnNlbmQobWVzc2FnZS50bywgTUZvcndhcmRlZChtZXNzYWdlLmZyb20sIG1lc3NhZ2UudG8sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXNzYWdlLm1lc3NhZ2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXNzYWdlLnByb3RvY29sKSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnTUZvcndhcmRlZCc6IC8vICNEIGEgbWVzc2FnZSBoYXMgYmVlbiBmb3J3YXJkZWQgdG8gdXMsIGRlbGl2ZXJcbiAgICAgICAgICAgIHNlbGYuaW52aWV3LmNvbm5lY3Rpb24oY2FsbGJhY2tzKGlkLCBtZXNzYWdlLCAnaW52aWV3JyksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1lc3NhZ2UubWVzc2FnZSkgfHxcbiAgICAgICAgICAgICAgICBzZWxmLm91dHZpZXcuY29ubmVjdGlvbihtZXNzYWdlLm1lc3NhZ2UpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ01EaXJlY3QnOiAvLyAjRSBhIGRpcmVjdCBuZWlnYmhvciBzZW5kcyBvZmZlcnMgdG8gYWNjZXB0XG4gICAgICAgICAgICBzZWxmLmludmlldy5jb25uZWN0aW9uKFxuICAgICAgICAgICAgICAgIGRpcmVjdENhbGxiYWNrcyhpZCwgbWVzc2FnZS5mcm9tLCAnaW52aWV3JyksXG4gICAgICAgICAgICAgICAgbWVzc2FnZS5tZXNzYWdlKSB8fFxuICAgICAgICAgICAgICAgIHNlbGYub3V0dmlldy5jb25uZWN0aW9uKG1lc3NhZ2UubWVzc2FnZSk7XG4gICAgICAgICAgICBicmVhazsgICAgICAgICAgICBcbiAgICAgICAgfTtcbiAgICB9O1xuXG4gICAgdGhpcy5pbnZpZXcub24oJ3JlY2VpdmUnLCByZWNlaXZlKTtcbiAgICB0aGlzLm91dHZpZXcub24oJ3JlY2VpdmUnLCByZWNlaXZlKTtcbiAgICBcbiAgICAvLyAjRCBhbiBhcmMgaW4gb25lIG9mIHRoZSB2aWV3IGlzIHJlYWR5LCByZWRpcmVjdCBldmVudFxuICAgIGZ1bmN0aW9uIHJlYWR5KHZpZXcpe1xuICAgICAgICByZXR1cm4gZnVuY3Rpb24oaWQpeyBzZWxmLmVtaXQoJ3JlYWR5JywgaWQsIHZpZXcpOyB9O1xuICAgIH07XG5cbiAgICB0aGlzLmludmlldy5vbigncmVhZHktJytwcm90b2NvbCwgcmVhZHkoJ2ludmlldycpKTtcbiAgICB0aGlzLm91dHZpZXcub24oJ3JlYWR5LScrcHJvdG9jb2wsIHJlYWR5KCdvdXR2aWV3JykpO1xuXG4gICAgLy8gI0UgYSBjb25uZWN0aW9uIGZhaWxlZCB0byBlc3RhYmxpc2hcbiAgICBmdW5jdGlvbiBmYWlsKHZpZXcpe1xuICAgICAgICByZXR1cm4gZnVuY3Rpb24oKXsgc2VsZi5lbWl0KCdmYWlsJywgdmlldyk7IH07XG4gICAgfTtcbiAgICBcbiAgICB0aGlzLmludmlldy5vbignZmFpbCcsIGZhaWwoJ2ludmlldycpKTtcbiAgICB0aGlzLm91dHZpZXcub24oJ2ZhaWwnLCBmYWlsKCdvdXR2aWV3JykpO1xuXG4gICAgLy8gI0YgYW4gYXJjIGhhcyBiZWVuIHJlbW92ZVxuICAgIGZ1bmN0aW9uIGRpc2Nvbm5lY3Qodmlldyl7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbihpZCkgeyBzZWxmLmVtaXQoJ2Rpc2Nvbm5lY3QnLCBpZCwgdmlldyk7IH07XG4gICAgfTtcbiAgICBcbiAgICB0aGlzLmludmlldy5vbignZGlzY29ubmVjdCcsIGRpc2Nvbm5lY3QoJ2ludmlldycpKTtcbiAgICB0aGlzLm91dHZpZXcub24oJ2Rpc2Nvbm5lY3QnLCBkaXNjb25uZWN0KCdvdXR2aWV3JykpO1xuICAgIFxuICAgIC8qIVxuICAgICAqIFxcYnJpZWYgY29ubmVjdCB0aGUgcGVlcnMgYXQgdGhlIG90aGVyIGVuZHMgb2Ygc29ja2V0cyBpZGVudGlmaWVkXG4gICAgICogXFxwYXJhbSBmcm9tIHRoZSBpZGVudGlmaWVyIG9mIHRoZSBzb2NrZXQgbGVhZGluZyB0byBhIHBlZXIgd2hpY2ggd2lsbCBhZGRcbiAgICAgKiBhIHNvY2tldCBpbiBpdHMgb3V0dmlld1xuICAgICAqIFxccGFyYW0gdG8gdGhlIGlkZW50aWZpZXIgb2YgdGhlIHNvY2tldCBsZWFkaW5nIHRvIGEgcGVlciB3aGljaCB3aWxsIGFkZCBcbiAgICAgKiBhIHNvY2tldCBpbiBpdHMgaW52aWV3XG4gICAgICovXG4gICAgdGhpcy5jb25uZWN0ID0gZnVuY3Rpb24oZnJvbSwgdG8pe1xuICAgICAgICBpZiAoIWZyb20gJiYgdG8pe1xuICAgICAgICAgICAgLy8gI0Egb25seSB0aGUgJ3RvJyBhcmd1bWVudCBpbXBsaWNpdGx5IG1lYW5zIGZyb20gPSB0aGlzXG4gICAgICAgICAgICAvLyB0aGlzIC0+IHRvXG4gICAgICAgICAgICBzZWxmLmNvbm5lY3Rpb24oZGlyZWN0Q2FsbGJhY2tzKCB0bywgc2VsZi5vdXR2aWV3LklELCAnb3V0dmlldycpKTtcbiAgICAgICAgfSBlbHNlIGlmIChmcm9tICYmICF0byl7XG4gICAgICAgICAgICAvLyAjQiBvbmx5IHRoZSAnZnJvbScgYXJndW1lbnQgaW1wbGljaXRseSBtZWFucyB0byA9IHRoaXNcbiAgICAgICAgICAgIC8vIGZyb20gLT4gdGhpc1xuICAgICAgICAgICAgc2VsZi5zZW5kKGZyb20sIE1Db25uZWN0VG8ocHJvdG9jb2wpKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vICNDIGFzayB0byB0aGUgZnJvbS1wZWVyIHRvIHRoZSB0by1wZWVyXG4gICAgICAgICAgICAvLyBmcm9tIC0+IHRvXG4gICAgICAgICAgICBzZWxmLnNlbmQoZnJvbSwgTUNvbm5lY3RUbyhwcm90b2NvbCwgZnJvbSwgdG8pKTtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIFxuICAgIC8qIVxuICAgICAqIFxcYnJpZWYgYm9vdHN0cmFwIHRoZSBuZXR3b3JrLCBpLmUuIGZpcnN0IGpvaW4gdGhlIG5ldHdvcmsuIFRoaXMgcGVlclxuICAgICAqIHdpbGwgYWRkIGEgcGVlciB3aGljaCBhbHJlYWR5IGJlbG9uZyB0byB0aGUgbmV0d29yay4gVGhlIHJlc3Qgb2YgXG4gICAgICogcHJvdG9jb2wgY2FuIGJlIGRvbmUgaW5zaWRlIHRoZSBuZXR3b3JrIHdpdGggdGhlIGZ1bmN0aW9uIGNvbm5lY3QuXG4gICAgICogXFxwYXJhbSBjYWxsYmFja3Mgc2VlIGNhbGxiYWNrcyBvZiBuZWlnaGJvcmhvb2Qtd3J0Y1xuICAgICAqIFxccGFyYW0gbWVzc2FnZSBzZWUgbWVzc2FnZXMgb2YgbmVpZ2hib3Job29kLXdydGNcbiAgICAgKiBcXHJldHVybiB0aGUgaWQgb2YgdGhlIHNvY2tldFxuICAgICAqL1xuICAgIHRoaXMuY29ubmVjdGlvbiA9IGZ1bmN0aW9uKGNhbGxiYWNrcywgbWVzc2FnZSl7XG4gICAgICAgIGlmICghbWVzc2FnZSB8fCAobWVzc2FnZSAmJiBtZXNzYWdlLnR5cGU9PT0nTVJlc3BvbnNlJykpe1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMub3V0dmlldy5jb25uZWN0aW9uKGNhbGxiYWNrcywgbWVzc2FnZSwgcHJvdG9jb2wpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuaW52aWV3LmNvbm5lY3Rpb24oY2FsbGJhY2tzLCBtZXNzYWdlLCBwcm90b2NvbCk7XG4gICAgICAgIH07XG4gICAgfTtcbn07XG5cbi8qIVxuICogXFxicmllZiByZW1vdmUgYW4gYXJjIG9mIHRoZSBvdXR2aWV3IG9yIGFsbCBhcmNzXG4gKiBcXHBhcmFtIGlkIHRoZSBhcmMgdG8gcmVtb3ZlLCBpZiBub25lLCByZW1vdmUgYWxsIGFyY3NcbiAqL1xuTmVpZ2hib3IucHJvdG90eXBlLmRpc2Nvbm5lY3QgPSBmdW5jdGlvbihpZCl7XG4gICAgaWYgKCFpZCl7XG4gICAgICAgIHRoaXMub3V0dmlldy5kaXNjb25uZWN0KCk7XG4gICAgICAgIHRoaXMuaW52aWV3LmRpc2Nvbm5lY3QoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLm91dHZpZXcuZGlzY29ubmVjdChpZCk7XG4gICAgfTtcbn07XG5cblxuXG4vKiFcbiAqIFxcYnJpZWYgdHJpZXMgdG8gc2VuZCB0aGUgbWVzc2FnZSB0byB0aGUgcGVlciBpZGVudGlmaWVkIGJ5IGlkXG4gKiBcXHBhcmFtIGlkIHRoZSBpZGVudGlmaWVyIG9mIHRoZSBzb2NrZXQgdXNlZCB0byBzZW5kIHRoZSBtZXNzYWdlXG4gKiBcXHBhcmFtIG1lc3NhZ2UgdGhlIG1lc3NhZ2UgdG8gc2VuZFxuICogXFxwYXJhbSByZXR1cm4gdHJ1ZSBpZiB0aGUgbWVzc2FnZSBoYXMgYmVlbiBzZW50LCBmYWxzZSBvdGhlcndpc2VcbiAqL1xuTmVpZ2hib3IucHJvdG90eXBlLnNlbmQgPSBmdW5jdGlvbihpZCwgbWVzc2FnZSl7XG4gICAgcmV0dXJuIHRoaXMub3V0dmlldy5zZW5kKGlkLCBtZXNzYWdlKSB8fCB0aGlzLmludmlldy5zZW5kKGlkLCBtZXNzYWdlKTtcbn07XG5cbi8qIVxuICogXFxicmllZiBnZXQgdGhlIHNvY2tldCBjb3JyZXNwb25kaW5nIHRvIHRoZSBpZCBpbiBhcmd1bWVudCBhbmQgdmlld3NcbiAqIFxccGFyYW0gaWRPclZpZXcgaWQgb3IgJ2ludmlldycgb3IgJ291dHZpZXcnXG4gKiBcXHJldHVybiBhIGxpc3Qgb2YgZW50cmllcyBvciBhbiBlbnRyeVxuICovXG5OZWlnaGJvci5wcm90b3R5cGUuZ2V0ID0gZnVuY3Rpb24oaWRPclZpZXcpe1xuICAgIHJldHVybiAgKChpZE9yVmlldz09PSdpbnZpZXcnKSAmJiB0aGlzLmludmlldy5saXZpbmcubXMuYXJyKSB8fC8vIGFsbCBpbnZpZXdcbiAgICAoKGlkT3JWaWV3PT09J291dHZpZXcnKSAmJiB0aGlzLm91dHZpZXcubGl2aW5nLm1zLmFycikgfHwgLy8gYWxsIG91dHZpZXdcbiAgICAoaWRPclZpZXcgJiYgKHRoaXMub3V0dmlldy5nZXQoaWRPclZpZXcpIHx8XG4gICAgICAgICAgICAgICAgICB0aGlzLmludmlldy5nZXQoaWRPclZpZXcpKSk7IC8vIGNoZXJyeSBwaWNraW5nXG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgc2ltcGxlIHN0cmluZyByZXByZXNlbnRpbmcgdGhlIGluIGFuZCBvdXQgdmlld3NcbiAqIFxccmV0dXJuIGEgc3RyaW5nIHdpdGggaW4gYW5kIG91dCB2aWV3c1xuICovXG5OZWlnaGJvci5wcm90b3R5cGUudG9TdHJpbmcgPSBmdW5jdGlvbigpe1xuICAgIHZhciByZXN1bHQgPSAnJztcbiAgICByZXN1bHQgKz0gJ0lEUyBbJyArIHRoaXMuaW52aWV3LklEICsnLCAnKyB0aGlzLm91dHZpZXcuSUQgKyddICc7XG4gICAgcmVzdWx0ICs9ICdJbiB7JztcbiAgICB2YXIgSSA9IHRoaXMuZ2V0KCdpbnZpZXcnKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IEkubGVuZ3RoOyArK2kpe1xuICAgICAgICByZXN1bHQgKz0gIElbaV0uaWQgKyAnIHgnICsgSVtpXS5vY2MgKyAnOyAnO1xuICAgIH07XG4gICAgcmVzdWx0ICs9ICd9ICBPdXQgeyc7XG4gICAgdmFyIE8gPSB0aGlzLmdldCgnb3V0dmlldycpO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgTy5sZW5ndGg7ICsraSl7XG4gICAgICAgIHJlc3VsdCArPSAgT1tpXS5pZCArICcgeCcgKyBPW2ldLm9jYyArICc7ICc7XG4gICAgfTtcbiAgICByZXN1bHQgKz0gJ30nO1xuICAgIHJldHVybiByZXN1bHQ7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IE5laWdoYm9yO1xuIiwibW9kdWxlLmV4cG9ydHMuTVJlcXVlc3QgPSBmdW5jdGlvbih0aWQsIHBpZCwgb2ZmZXIsIHByb3RvY29sKXtcbiAgICByZXR1cm4geyB0aWQ6IHRpZCxcbiAgICAgICAgICAgICBwaWQ6IHBpZCxcbiAgICAgICAgICAgICBwcm90b2NvbDogcHJvdG9jb2wsXG4gICAgICAgICAgICAgdHlwZTogJ01SZXF1ZXN0JyxcbiAgICAgICAgICAgICBvZmZlcjogb2ZmZXIgfTtcbn07XG5cbm1vZHVsZS5leHBvcnRzLk1SZXNwb25zZSA9IGZ1bmN0aW9uKHRpZCwgcGlkLCBvZmZlciwgcHJvdG9jb2wpe1xuICAgIHJldHVybiB7IHRpZDogdGlkLFxuICAgICAgICAgICAgIHBpZDogcGlkLFxuICAgICAgICAgICAgIHByb3RvY29sOiBwcm90b2NvbCxcbiAgICAgICAgICAgICB0eXBlOiAnTVJlc3BvbnNlJyxcbiAgICAgICAgICAgICBvZmZlcjogb2ZmZXIgfTtcbn07XG4iLCJ2YXIgU29ydGVkQXJyYXkgPSByZXF1aXJlKCcuL2V4dGVuZGVkLXNvcnRlZC1hcnJheScpO1xuXG5mdW5jdGlvbiBNdWx0aVNldChDb21wYXJhdG9yKXtcbiAgICB0aGlzLm1zID0gbmV3IFNvcnRlZEFycmF5KENvbXBhcmF0b3J8fGRlZmF1bHRDb21wYXJhdG9yKTtcbn07XG5cbk11bHRpU2V0LnByb3RvdHlwZS5pbnNlcnQgPSBmdW5jdGlvbihlbnRyeU9ySWQpe1xuICAgIHZhciBvYmplY3QgPSB0aGlzLm1zLmdldChlbnRyeU9ySWQpO1xuICAgIGlmIChvYmplY3Qpe1xuICAgICAgICAvLyAjMSBpZiB0aGUgb2JqZWN0IGFscmVhZHkgZXhpc3RzLCBpbmNyZW1lbnQgaXRzIG9jY3VycmVuY2VcbiAgICAgICAgb2JqZWN0Lm9jYyArPSAxO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIC8vICMyIGluaXRhbGl6ZSB0aGUgb2NjdXJyZW5jZSB0byAxIGFuZCBpbnNlcnQgaXQgb3RoZXJ3aXNlXG4gICAgICAgIGVudHJ5T3JJZC5vY2MgPSAxO1xuICAgICAgICB0aGlzLm1zLmluc2VydChlbnRyeU9ySWQpO1xuICAgIH07XG4gICAgcmV0dXJuIG9iamVjdDtcbn07XG5cbk11bHRpU2V0LnByb3RvdHlwZS5yZW1vdmUgPSBmdW5jdGlvbihlbnRyeU9ySWQpe1xuICAgIHZhciBvYmplY3QgPSB0aGlzLm1zLmdldChlbnRyeU9ySWQpO1xuICAgIGlmIChvYmplY3Qpe1xuICAgICAgICBvYmplY3Qub2NjIC09IDE7XG4gICAgICAgIChvYmplY3Qub2NjIDw9IDApICYmIHRoaXMubXMucmVtb3ZlKGVudHJ5T3JJZCk7XG4gICAgfTtcbiAgICByZXR1cm4gb2JqZWN0O1xufTtcblxuTXVsdGlTZXQucHJvdG90eXBlLnJlbW92ZUFsbCA9IGZ1bmN0aW9uKGVudHJ5T3JJZCl7XG4gICAgdmFyIG9iamVjdCA9IHRoaXMubXMuZ2V0KGVudHJ5T3JJZCk7XG4gICAgaWYgKG9iamVjdCl7XG4vLyAgICAgICAgb2JqZWN0Lm9jYyA9IDA7XG4gICAgICAgIHRoaXMubXMucmVtb3ZlKGVudHJ5T3JJZCk7XG4gICAgfTtcbiAgICByZXR1cm4gb2JqZWN0O1xufTtcblxuTXVsdGlTZXQucHJvdG90eXBlLmNvbnRhaW5zID0gZnVuY3Rpb24oZW50cnlPcklkKXtcbiAgICByZXR1cm4gdGhpcy5tcy5jb250YWlucyhlbnRyeU9ySWQpO1xufTtcblxuTXVsdGlTZXQucHJvdG90eXBlLmdldCA9IGZ1bmN0aW9uKGVudHJ5T3JJZCl7XG4gICAgcmV0dXJuIHRoaXMubXMuZ2V0KGVudHJ5T3JJZCk7XG59O1xuXG5mdW5jdGlvbiBkZWZhdWx0Q29tcGFyYXRvcihhLCBiKXtcbiAgICB2YXIgZmlyc3QgPSBhLmlkIHx8IGE7XG4gICAgdmFyIHNlY29uZCA9IGIuaWQgfHwgYjtcbiAgICBpZiAoZmlyc3QgPCBzZWNvbmQpe3JldHVybiAtMX07XG4gICAgaWYgKGZpcnN0ID4gc2Vjb25kKXtyZXR1cm4gIDF9O1xuICAgIHJldHVybiAwO1xufTtcblxuXG5tb2R1bGUuZXhwb3J0cyA9IE11bHRpU2V0O1xuIiwidmFyIEV2ZW50RW1pdHRlciA9IHJlcXVpcmUoJ2V2ZW50cycpLkV2ZW50RW1pdHRlcjtcbnZhciBTb2NrZXQgPSByZXF1aXJlKCdzaW1wbGUtcGVlcicpO1xudmFyIHV0aWwgPSByZXF1aXJlKCd1dGlsJyk7XG5cbnV0aWwuaW5oZXJpdHMoTmVpZ2hib3Job29kLCBFdmVudEVtaXR0ZXIpO1xuXG52YXIgU29ydGVkQXJyYXkgPSByZXF1aXJlKCcuL2V4dGVuZGVkLXNvcnRlZC1hcnJheS5qcycpO1xudmFyIE11bHRpU2V0ID0gcmVxdWlyZSgnLi9tdWx0aXNldC5qcycpO1xuLy92YXIgR1VJRCA9IHJlcXVpcmUoJy4vZ3VpZC5qcycpOyAoVE9ETykgdW5jb21tZW50XG52YXIgR1VJRCA9IGZ1bmN0aW9uKCl7cmV0dXJuICgnJytNYXRoLmNlaWwoTWF0aC5yYW5kb20oKSoxMDAwMDApKycnKTsgfTtcblxudmFyIE1SZXF1ZXN0ID0gcmVxdWlyZSgnLi9tZXNzYWdlcy5qcycpLk1SZXF1ZXN0O1xudmFyIE1SZXNwb25zZSA9IHJlcXVpcmUoJy4vbWVzc2FnZXMuanMnKS5NUmVzcG9uc2U7XG5cblxuLyohXG4gKiBcXGJyaWVmIG5laWdiaG9yaG9vZCB0YWJsZSBwcm92aWRpbmcgZWFzeSBlc3RhYmxpc2htZW50IGFuZCBtYW5hZ2VtZW50IG9mXG4gKiBjb25uZWN0aW9uc1xuICogXFxwYXJhbSBvcHRpb25zIHRoZSBvcHRpb25zIGF2YWlsYWJsZSB0byB0aGUgY29ubmVjdGlvbnMsIGUuZy4gdGltZW91dCBiZWZvcmVcbiAqIGNvbm5lY3Rpb24gYXJlIHRydWVseSByZW1vdmVkLCBXZWJSVEMgb3B0aW9uc1xuICovXG5mdW5jdGlvbiBOZWlnaGJvcmhvb2Qob3B0aW9ucyl7XG4gICAgRXZlbnRFbWl0dGVyLmNhbGwodGhpcyk7XG4gICAgdGhpcy5QUk9UT0NPTCA9ICduZWlnaGJvcmhvb2Qtd3J0Yyc7XG4gICAgdGhpcy5JRCA9IEdVSUQoKTsgICBcbiAgICAvLyAjMSBzYXZlIG9wdGlvbnNcbiAgICB0aGlzLm9wdGlvbnMgPSAob3B0aW9ucyAmJiBvcHRpb25zLndlYnJ0YykgfHwge307XG4gICAgdGhpcy5vcHRpb25zLnRyaWNrbGUgPSAob3B0aW9ucyAmJiBvcHRpb25zLndlYnJ0YyAmJlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wdGlvbnMud2VicnRjLnRyaWNrbGUpIHx8IGZhbHNlO1xuICAgIHRoaXMuVElNRU9VVCA9IChvcHRpb25zICYmIG9wdGlvbnMudGltZW91dCkgfHwgKDIgKiA2MCAqIDEwMDApOyAvLyAyIG1pbnV0ZXNcbiAgICAvLyAjMiBpbml0aWFsaXplIHRhYmxlcyAgICBcbiAgICB0aGlzLnBlbmRpbmcgPSBuZXcgU29ydGVkQXJyYXkoQ29tcGFyYXRvcik7IC8vIG5vdCBmaW5hbGl6ZWQgeWV0XG4gICAgdGhpcy5saXZpbmcgPSBuZXcgTXVsdGlTZXQoQ29tcGFyYXRvcik7IC8vIGxpdmUgYW5kIHVzYWJsZVxuICAgIHRoaXMuZHlpbmcgPSBuZXcgU29ydGVkQXJyYXkoQ29tcGFyYXRvcik7IC8vIGJlaW5nIHJlbW92ZVxufTtcblxuLyohXG4gKiBcXGJyaWVmIGNyZWF0ZXMgYSBuZXcgaW5jb21taW5nIG9yIG91dGdvaW5nIGNvbm5lY3Rpb24gZGVwZW5kaW5nIG9uIGFyZ3VtZW50c1xuICogXFxwYXJhbSBjYWxsYmFjayB0aGUgY2FsbGJhY2sgZnVuY3Rpb24gd2hlbiB0aGUgc3R1bi9pY2Ugc2VydmVyIHJldHVybnMgdGhlXG4gKiBvZmZlclxuICogXFxwYXJhbSBvYmplY3QgZW1wdHkgaWYgaXQgbXVzdCBpbml0aWF0ZSBhIGNvbm5lY3Rpb24sIG9yIHRoZSBtZXNzYWdlIHJlY2VpdmVkXG4gKiBpZiBpdCBtdXN0IGFuc3dlciBvciBmaW5hbGl6ZSBvbmVcbiAqIFxccGFyYW0gcHJvdG9jb2wgdGhlIGNvbm5lY3Rpb24gaXMgZXN0YWJsaXNoZWQgZm9yIGEgc3BlY2lmaWMgcHJvdG9jb2xcbiAqIFxccmV0dXJuIHRoZSBpZCBvZiB0aGUgc29ja2V0XG4gKi9cbk5laWdoYm9yaG9vZC5wcm90b3R5cGUuY29ubmVjdGlvbiA9IGZ1bmN0aW9uKGNhbGxiYWNrcywgbWVzc2FnZSwgcHJvdG9jb2wpe1xuICAgIHZhciBtc2cgPSAoY2FsbGJhY2tzICYmIGNhbGxiYWNrcy50eXBlICYmIGNhbGxiYWNrcykgfHwgbWVzc2FnZTtcbiAgICB2YXIgcmVzdWx0O1xuICAgIFxuICAgIGlmICghbXNnKXtcbiAgICAgICAgcmVzdWx0ID0gaW5pdGlhdGUuY2FsbCh0aGlzLCBjYWxsYmFja3MsIHByb3RvY29sKTtcbiAgICB9IGVsc2UgaWYgKG1zZy50eXBlPT09J01SZXF1ZXN0Jyl7XG4gICAgICAgIHJlc3VsdCA9IGFjY2VwdC5jYWxsKHRoaXMsIG1zZywgY2FsbGJhY2tzKTtcbiAgICAgICAgcmVzdWx0ID0gYWxyZWFkeUV4aXN0cy5jYWxsKHRoaXMsIG1zZywgY2FsbGJhY2tzKSB8fCByZXN1bHQ7XG4gICAgfSBlbHNlIGlmIChtc2cudHlwZT09PSdNUmVzcG9uc2UnKXtcbiAgICAgICAgcmVzdWx0ID0gZmluYWxpemUuY2FsbCh0aGlzLCBtc2cpO1xuICAgICAgICByZXN1bHQgPSBhbHJlYWR5RXhpc3RzLmNhbGwodGhpcywgbXNnKSB8fCByZXN1bHQ7XG4gICAgfTtcblxuICAgIHJldHVybiByZXN1bHQgJiYgcmVzdWx0LmlkO1xufTtcblxuXG4vKiFcbiAqIFxcYnJpZWYgZGlzY29ubmVjdCBvbmUgb2YgdGhlIGFyYyB3aXRoIHRoZSBpZGVudGlmaWVyIGluIGFyZ3VtZW50LiBJZiBcbiAqIGl0IHdhcyB0aGUgbGFzdCBhcmMgd2l0aCBzdWNoIGlkLCB0aGUgc29ja2V0IGlzIHJlbG9jYXRlZCB0byB0aGUgZHlpbmdcbiAqIHRhYmxlLiBUaGUgc29ja2V0IHdpbGwgYmUgZGVzdHJveSBhZnRlciBhIGJpdC4gSWYgdGhlcmUgaXMgbm8gYXJndW1lbnQsXG4gKiBkaXNjb25uZWN0IHRoZSB3aG9sZS5cbiAqL1xuTmVpZ2hib3Job29kLnByb3RvdHlwZS5kaXNjb25uZWN0ID0gZnVuY3Rpb24oaWQpe1xuICAgIGlmICghaWQpe1xuICAgICAgICAvLyAjMSBkaXNjb25uZWN0IGV2ZXJ5dGhpbmdcbiAgICAgICAgdGhpcy5wZW5kaW5nLmFyci5mb3JFYWNoKGZ1bmN0aW9uKGUpe1xuICAgICAgICAgICAgZS5zb2NrZXQgJiYgZS5zb2NrZXQuZGVzdHJveSgpOyAgICAgICAgICAgIFxuICAgICAgICB9KTtcbiAgICAgICAgd2hpbGUgKHRoaXMubGl2aW5nLm1zLmFyci5sZW5ndGg+MCl7XG4gICAgICAgICAgICB2YXIgZSA9IHRoaXMubGl2aW5nLm1zLmFyclswXTtcbiAgICAgICAgICAgIGUuc29ja2V0ICYmIGUuc29ja2V0LmRlc3Ryb3koKTtcbiAgICAgICAgfTtcbiAgICAgICAgd2hpbGUgKHRoaXMuZHlpbmcuYXJyLmxlbmd0aD4wKXtcbiAgICAgICAgICAgIHZhciBlID0gdGhpcy5keWluZy5hcnJbMF07XG4gICAgICAgICAgICBlLnNvY2tldCAmJiBlLnNvY2tldC5kZXN0cm95KCk7XG4gICAgICAgIH07XG4gICAgfSBlbHNlIHtcbiAgICAgICAgLy8gIzIgcmVtb3ZlIG9uZSBhcmNcbiAgICAgICAgdmFyIGVudHJ5ID0gdGhpcy5saXZpbmcucmVtb3ZlKGlkKTtcbiAgICAgICAgZW50cnkgJiYgdGhpcy5lbWl0KCdkaXNjb25uZWN0JywgZW50cnkuaWQpO1xuICAgICAgICBpZiAoZW50cnkgJiYgZW50cnkub2NjIDw9IDApe1xuICAgICAgICAgICAgZW50cnkudGltZW91dCA9IHNldFRpbWVvdXQoZnVuY3Rpb24oKXtcbiAgICAgICAgICAgICAgICBlbnRyeS5zb2NrZXQuZGVzdHJveSgpO1xuICAgICAgICAgICAgfSwgdGhpcy5USU1FT1VUKTtcbiAgICAgICAgICAgIHRoaXMuZHlpbmcuaW5zZXJ0KGVudHJ5KTtcbiAgICAgICAgfTtcbiAgICB9O1xufTtcblxuXG4vKiFcbiAqIFxcYnJpZWYgZ2V0IHRoZSBlbnRyeSBjb3JyZXNwb25kaW5nIHRvIHRoZSBpZCBpbiBhcmd1bWVudC4gVGhlIGVudHJ5IGNvbnRhaW5zXG4gKiB0aGUgc29ja2V0LlxuICogXFxwYXJhbSBpZCB0aGUgaWRlbnRpZmllciBvZiB0aGUgc29ja2V0IHRvIHJldHJpZXZlXG4gKiBcXHJldHVybiBhbiBlbnRyeSBmcm9tIHRhYmxlcy4gSXQgcHJpb3JpemVzIGVudHJpZXMgaW4gbGl2aW5nLCB0aGVuIGR5aW5nLFxuICogdGhlbiBwZW5kaW5nLlxuICovXG5OZWlnaGJvcmhvb2QucHJvdG90eXBlLmdldCA9IGZ1bmN0aW9uKGlkKXtcbiAgICByZXR1cm4gdGhpcy5saXZpbmcuZ2V0KGlkKSB8fCB0aGlzLmR5aW5nLmdldChpZCkgfHwgdGhpcy5wZW5kaW5nLmdldChpZCk7XG59O1xuXG5cbi8qIVxuICogXFxicmllZiBzZW5kIGEgbWVzc2FnZSB0byB0aGUgc29ja2V0IGluIGFyZ3VtZW50XG4gKiBcXHBhcmFtIGlkIHRoZSBpZGVudGlmaWVyIG9mIHRoZSBzb2NrZXRcbiAqIFxccGFyYW0gbWVzc2FnZSB0aGUgbWVzc2FnZSB0byBzZW5kIFxuICogXFxyZXR1cm4gdHJ1ZSBpZiB0aGUgbWVzc2FnZSBpcyBzZW50LCBmYWxzZSBvdGhlcndpc2VcbiAqL1xuTmVpZ2hib3Job29kLnByb3RvdHlwZS5zZW5kID0gZnVuY3Rpb24oaWQsIG1lc3NhZ2Upe1xuICAgIC8vICMxIGNvbnZlcnQgbWVzc2FnZSB0byBzdHJpbmcgKFRPRE8pIGNoZWNrIGlmIHRoZXJlIGlzIGEgYmV0dGVyIHdheVxuICAgIHZhciBtc2cgPSAoKG1lc3NhZ2UgaW5zdGFuY2VvZiBTdHJpbmcpICYmIG1lc3NhZ2UpIHx8XG4gICAgICAgIEpTT04uc3RyaW5naWZ5KG1lc3NhZ2UpO1xuICAgIC8vICMyIGdldCB0aGUgc29ja2V0IHRvIHVzZVxuICAgIHZhciBlbnRyeSA9IHRoaXMuZ2V0KGlkKTtcbiAgICB2YXIgc29ja2V0ID0gZW50cnkgJiYgZW50cnkuc29ja2V0O1xuICAgIC8vICMzIHNlbmRcbiAgICB2YXIgcmVzdWx0ID0gbXNnICYmIHNvY2tldCAmJiBzb2NrZXQuY29ubmVjdGVkICYmIHNvY2tldC5fY2hhbm5lbCAmJlxuICAgICAgICAoc29ja2V0Ll9jaGFubmVsLnJlYWR5U3RhdGUgPT09ICdvcGVuJyk7XG4gICAgcmVzdWx0ICYmIHNvY2tldC5zZW5kKG1zZyk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbn07XG5cblxuLy8gLy8gLy8gLy8gLy8gLy8gLy8gLy8gLy8gLy9cbi8vICAgIFBSSVZBVEUgZnVuY3Rpb25zICAgIC8vXG4vLyAvLyAvLyAvLyAvLyAvLyAvLyAvLyAvLyAvL1xuXG4vKiFcbiAqIFxcYnJpZWYgaW5pdGlhdGVzIGEgY29ubmVjdGlvbiB3aXRoIGFub3RoZXIgcGVlciAtLSB0aGUgaWQgb2Ygd2hpY2ggaXMgdW5rbm93blxuICogXFxwYXJhbSBjYWxsYmFja3MgdGhlIGZ1bmN0aW9uIHRvIGNhbGwgd2hlbiBzaWduYWxpbmcgaW5mbyBhcmUgcmVjZWl2ZWQgYW5kXG4gKiB3aGVuIHRoZSBjb25uZWN0aW9uIGlzIHJlYWR5IHRvIGJlIHVzZWRcbiAqL1xuZnVuY3Rpb24gaW5pdGlhdGUoY2FsbGJhY2tzLCBwcm90b2NvbCl7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHZhciBvcHRzID0gdGhpcy5vcHRpb25zO1xuICAgIG9wdHMuaW5pdGlhdG9yID0gdHJ1ZTsgICAgICAgIFxuICAgIHZhciBzb2NrZXQgPSBuZXcgU29ja2V0KG9wdHMpO1xuICAgIHZhciBlbnRyeSA9IHtpZDogR1VJRCgpLFxuICAgICAgICAgICAgICAgICBzb2NrZXQ6IHNvY2tldCxcbiAgICAgICAgICAgICAgICAgcHJvdG9jb2w6IHByb3RvY29sLFxuICAgICAgICAgICAgICAgICBzdWNjZXNzZnVsOiBmYWxzZSwgLy8gbm90IHlldFxuICAgICAgICAgICAgICAgICBvbk9mZmVyOiBjYWxsYmFja3MgJiYgY2FsbGJhY2tzLm9uSW5pdGlhdGUsXG4gICAgICAgICAgICAgICAgIG9uUmVhZHk6IGNhbGxiYWNrcyAmJiBjYWxsYmFja3Mub25SZWFkeSB9O1xuICAgIFxuICAgIHRoaXMucGVuZGluZy5pbnNlcnQoZW50cnkpO1xuICAgIHNvY2tldC5vbignc2lnbmFsJywgZnVuY3Rpb24ob2ZmZXIpe1xuICAgICAgICBlbnRyeS5vbk9mZmVyICYmXG4gICAgICAgICAgICBlbnRyeS5vbk9mZmVyKG5ldyBNUmVxdWVzdChlbnRyeS5pZCwgc2VsZi5JRCwgb2ZmZXIsIHByb3RvY29sKSk7XG4gICAgfSk7XG4gICAgZW50cnkudGltZW91dCA9IHNldFRpbWVvdXQoZnVuY3Rpb24oKXtcbiAgICAgICAgdmFyIGUgPSBzZWxmLnBlbmRpbmcuZ2V0KGVudHJ5LmlkKTtcbiAgICAgICAgaWYgKGUgJiYgIWUuc3VjY2Vzc2Z1bCl7IHNlbGYuZW1pdCgnZmFpbCcpOyB9OyAgICAgICAgXG4gICAgICAgIHNlbGYucGVuZGluZy5yZW1vdmUoZW50cnkpICYmIHNvY2tldC5kZXN0cm95KCk7XG4gICAgfSwgdGhpcy5USU1FT1VUKTtcbiAgICBcbiAgICByZXR1cm4gZW50cnk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgYWNjZXB0IHRoZSBvZmZlciBvZiBhbm90aGVyIHBlZXJcbiAqIFxccGFyYW0gbWVzc2FnZSB0aGUgcmVjZWl2ZWQgbWVzc2FnZSBjb250YWluaW5nIGlkIGFuZCBvZmZlclxuICogXFxwYXJhbSBjYWxsYmFja3MgdGhlIGZ1bmN0aW9uIGNhbGwgYWZ0ZXIgcmVjZWl2aW5nIHRoZSBvZmZlciBhbmQgXG4gKiB3aGVuIHRoZSBjb25uZWN0aW9uIGlzIHJlYWR5XG4gKi9cbmZ1bmN0aW9uIGFjY2VwdChtZXNzYWdlLCBjYWxsYmFja3Mpe1xuICAgIC8vICMxIGlmIGFscmVhZHkgZXhpc3RzLCB1c2UgaXRcbiAgICB2YXIgcHJpb3IgPSB0aGlzLnBlbmRpbmcuZ2V0KG1lc3NhZ2UudGlkKTtcbiAgICBpZiAocHJpb3IpeyByZXR1cm4gcHJpb3I7IH07XG4gICAgLy8gIzIgb3RoZXJ3aXNlLCBjcmVhdGUgdGhlIHNvY2tldFxuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAvLyB2YXIgb3B0cz1KU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KHRoaXMub3B0aW9ucykpOy8vIHF1aWNrIGJ1dCB1Z2x5IGNvcHlcbiAgICBvcHRzID0gdGhpcy5vcHRpb25zO1xuICAgIG9wdHMuaW5pdGlhdG9yID0gZmFsc2U7XG4gICAgdmFyIHNvY2tldCA9IG5ldyBTb2NrZXQob3B0cyk7XG4gICAgdmFyIGVudHJ5ID0ge2lkOiBtZXNzYWdlLnRpZCxcbiAgICAgICAgICAgICAgICAgcGlkOiBtZXNzYWdlLnBpZCxcbiAgICAgICAgICAgICAgICAgcHJvdG9jb2w6IG1lc3NhZ2UucHJvdG9jb2wsXG4gICAgICAgICAgICAgICAgIHNvY2tldDogc29ja2V0LFxuICAgICAgICAgICAgICAgICBzdWNjZXNzZnVsOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgb25PZmZlcjogY2FsbGJhY2tzICYmIGNhbGxiYWNrcy5vbkFjY2VwdCxcbiAgICAgICAgICAgICAgICAgb25SZWFkeTogY2FsbGJhY2tzICYmIGNhbGxiYWNrcy5vblJlYWR5IH07XG4gICAgXG4gICAgdGhpcy5wZW5kaW5nLmluc2VydChlbnRyeSk7XG4gICAgc29ja2V0Lm9uKCdzaWduYWwnLCBmdW5jdGlvbihvZmZlcil7XG4gICAgICAgIGVudHJ5Lm9uT2ZmZXIgJiZcbiAgICAgICAgICAgIGVudHJ5Lm9uT2ZmZXIobmV3IE1SZXNwb25zZShlbnRyeS5pZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZWxmLklELFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9mZmVyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudHJ5LnByb3RvY29sKSk7XG4gICAgfSk7XG4gICAgc29ja2V0Lm9uKCdjb25uZWN0JywgZnVuY3Rpb24oKXtcbiAgICAgICAgc2VsZi5nZXQoZW50cnkucGlkKSAmJiBzb2NrZXQuZGVzdHJveSgpO1xuICAgICAgICBzZWxmLnBlbmRpbmcucmVtb3ZlKGVudHJ5KTtcbiAgICAgICAgc2VsZi5saXZpbmcuaW5zZXJ0KHtpZDogZW50cnkucGlkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNvY2tldDogZW50cnkuc29ja2V0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uUmVhZHk6IGVudHJ5Lm9uUmVhZHksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgb25PZmZlcjogZW50cnkub25PZmZlcn0pOyAgICAgICAgXG4gICAgICAgIGVudHJ5Lm9uUmVhZHkgJiYgZW50cnkub25SZWFkeShlbnRyeS5waWQpO1xuICAgICAgICBzZWxmLmVtaXQoJ3JlYWR5JywgZW50cnkucGlkKTtcbiAgICAgICAgZW50cnkucHJvdG9jb2wgJiYgc2VsZi5lbWl0KCdyZWFkeS0nK2VudHJ5LnByb3RvY29sLCBlbnRyeS5waWQpO1xuICAgICAgICBjbGVhclRpbWVvdXQoZW50cnkudGltZW91dCk7XG4gICAgICAgIGVudHJ5LnRpbWVvdXQgPSBudWxsOyAgICAgICAgXG4gICAgfSk7XG4gICAgc29ja2V0Lm9uKCdjbG9zZScsIGZ1bmN0aW9uKCl7XG4gICAgICAgIGlmIChzZWxmLnBlbmRpbmcuY29udGFpbnMoZW50cnkuaWQpKXtcbiAgICAgICAgICAgIC8vICNBIHBlbmRpbmc6IGVudHJ5IGlzIGtlcHQgdW50aWwgYXV0b21hdGljIGRlc3RydWN0aW9uXG4gICAgICAgICAgICBlbnRyeS5zb2NrZXQgPSBudWxsO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gI0IgbGl2aW5nIG9yIGR5aW5nOiBjbGVhciB0aGUgdGFibGVzXG4gICAgICAgICAgICBlbnRyeS50aW1lb3V0ICYmIGNsZWFyVGltZW91dChlbnRyeS50aW1lb3V0KTtcbiAgICAgICAgICAgIGVudHJ5LnRpbWVvdXQgPSBudWxsO1xuICAgICAgICAgICAgdmFyIGxpdmUgPSBzZWxmLmxpdmluZy5yZW1vdmVBbGwoZW50cnkucGlkKTtcbiAgICAgICAgICAgIGlmIChsaXZlKXtcbiAgICAgICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxpdmUub2NjOyArK2kpe1xuICAgICAgICAgICAgICAgICAgICBzZWxmLmVtaXQoJ2Rpc2Nvbm5lY3QnLCBlbnRyeS5waWQpXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBzZWxmLmR5aW5nLnJlbW92ZShlbnRyeS5waWQpO1xuICAgICAgICB9O1xuICAgIH0pO1xuXG4gICAgY29tbW9uLmNhbGwodGhpcywgZW50cnkpO1xuICAgIFxuICAgIGVudHJ5LnRpbWVvdXQgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7XG4gICAgICAgIHZhciBlID0gc2VsZi5wZW5kaW5nLmdldChlbnRyeS5pZCk7XG4gICAgICAgIGlmIChlICYmICFlLnN1Y2Nlc3NmdWwpeyBzZWxmLmVtaXQoJ2ZhaWwnKTsgfTtcbiAgICAgICAgc2VsZi5wZW5kaW5nLnJlbW92ZShlbnRyeS5pZCkgJiYgc29ja2V0LmRlc3Ryb3koKTtcbiAgICB9LCB0aGlzLlRJTUVPVVQpO1xuICAgIFxuICAgIHJldHVybiBlbnRyeTtcbn07XG5cbi8qIVxuICogXFxicmllZiBDb21tb24gYmVoYXZpb3IgdG8gaW5pdGlhdGluZyBhbmQgYWNjZXB0aW5nIHNvY2tldHNcbiAqIFxccGFyYW0gZW50cnkgdGhlIGVudHJ5IGluIHRoZSBuZWlnaGJvcmhvb2QgdGFibGVcbiAqL1xuZnVuY3Rpb24gY29tbW9uKGVudHJ5KXtcbiAgICB2YXIgc2VsZiA9IHRoaXMsIHNvY2tldCA9IGVudHJ5LnNvY2tldDtcbiAgICBcbiAgICBzb2NrZXQub24oJ2RhdGEnLCBmdW5jdGlvbihtZXNzYWdlKXtcbiAgICAgICAgbWVzc2FnZSA9IEpTT04ucGFyc2UobWVzc2FnZS50b1N0cmluZygpKTtcbiAgICAgICAgc2VsZi5lbWl0KCdyZWNlaXZlJywgZW50cnkucGlkLCBtZXNzYWdlKTtcbiAgICB9KTtcbiAgICBzb2NrZXQub24oJ3N0cmVhbScsIGZ1bmN0aW9uKHN0cmVhbSl7XG4gICAgICAgIHNlbGYuZW1pdCgnc3RyZWFtJywgZW50cnkucGlkLCBzdHJlYW0pO1xuICAgIH0pO1xuICAgIHNvY2tldC5vbignZXJyb3InLCBmdW5jdGlvbihlcnIpe1xuICAgICAgICAvL2NvbnNvbGUuZXJyb3IoZXJyKTsgKFhYWCkgZG8gc29tZXRoaW5nIHVzZWZ1bCBoZXJlXG4gICAgfSk7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgZmluYWxpemUgdGhlIGJlaGF2aW9yIG9mIGFuIGluaXRpYXRpbmcgc29ja2V0XG4gKiBcXHBhcmFtIG1lc3NnZSB0aGUgcmVjZWl2ZWQgbWVzc2FnZSBwb3NzaWJseSBjb250YWluaW5nIGFuIGFuc3dlciB0byB0aGVcbiAqIHByb3Bvc2VkIG9mZmVyXG4gKi9cbmZ1bmN0aW9uIGZpbmFsaXplKG1lc3NhZ2Upe1xuICAgIC8vICMxIGlmIGl0IGRvZXMgbm90IGV4aXN0cywgc3RvcDsgb3IgaWYgaXQgZXhpc3RzIGJ1dCBhbHJlYWR5IHNldHVwXG4gICAgLy8gcmV0dXJuIGl0XG4gICAgdmFyIHByaW9yID0gdGhpcy5wZW5kaW5nLmdldChtZXNzYWdlLnRpZCk7XG4gICAgaWYgKCFwcmlvciB8fCBwcmlvci5waWQpe3JldHVybiBwcmlvcjt9XG4gICAgLy8gIzIgb3RoZXJ3aXNlIHNldCB0aGUgZXZlbnRzIGNvcnJlY3RseVxuICAgIHByaW9yLnBpZCA9IG1lc3NhZ2UucGlkOyAgICBcbiAgICBcbiAgICB2YXIgZW50cnkgPSB7aWQ6IG1lc3NhZ2UucGlkLFxuICAgICAgICAgICAgICAgICBzb2NrZXQ6IHByaW9yLnNvY2tldCxcbiAgICAgICAgICAgICAgICAgcHJvdG9jb2w6IHByaW9yLnByb3RvY29sLFxuICAgICAgICAgICAgICAgICBvblJlYWR5OiBwcmlvci5vblJlYWR5LFxuICAgICAgICAgICAgICAgICBvbk9mZmVyOiBwcmlvci5vbk9mZmVyIH07XG4gICAgXG4gICAgdmFyIHNlbGYgPSB0aGlzLCBzb2NrZXQgPSBlbnRyeS5zb2NrZXQ7XG4gICAgc29ja2V0Lm9uKCdjb25uZWN0JywgZnVuY3Rpb24oKXtcbiAgICAgICAgc2VsZi5nZXQoZW50cnkuaWQpICYmIHNvY2tldC5kZXN0cm95KCk7XG4gICAgICAgIHNlbGYucGVuZGluZy5yZW1vdmUocHJpb3IpO1xuICAgICAgICBzZWxmLmxpdmluZy5pbnNlcnQoZW50cnkpO1xuICAgICAgICBlbnRyeS5vblJlYWR5ICYmIGVudHJ5Lm9uUmVhZHkocHJpb3IucGlkKTtcbiAgICAgICAgc2VsZi5lbWl0KCdyZWFkeScsIHByaW9yLnBpZCk7XG4gICAgICAgIGVudHJ5LnByb3RvY29sICYmIHNlbGYuZW1pdCgncmVhZHktJytlbnRyeS5wcm90b2NvbCwgcHJpb3IucGlkKTtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHByaW9yLnRpbWVvdXQpO1xuICAgIH0pO1xuICAgIHNvY2tldC5vbignY2xvc2UnLCBmdW5jdGlvbigpe1xuICAgICAgICBpZiAoc2VsZi5wZW5kaW5nLmNvbnRhaW5zKG1lc3NhZ2UudGlkKSl7XG4gICAgICAgICAgICBzZWxmLnBlbmRpbmcuZ2V0KG1lc3NhZ2UudGlkKS5zb2NrZXQgPSBudWxsO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcHJpb3IudGltZW91dCAmJiBjbGVhclRpbWVvdXQocHJpb3IudGltZW91dCk7XG4gICAgICAgICAgICBwcmlvci50aW1lb3V0ID0gbnVsbDtcbiAgICAgICAgICAgIHZhciBsaXZlID0gc2VsZi5saXZpbmcucmVtb3ZlQWxsKHByaW9yLnBpZCk7XG4gICAgICAgICAgICBpZiAobGl2ZSl7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsaXZlLm9jYzsgKytpKXtcbiAgICAgICAgICAgICAgICAgICAgc2VsZi5lbWl0KCdkaXNjb25uZWN0JywgcHJpb3IucGlkKTtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIHNlbGYuZHlpbmcucmVtb3ZlKHByaW9yLnBpZCk7XG4gICAgICAgIH07XG4gICAgfSk7ICBcblxuICAgIGNvbW1vbi5jYWxsKHRoaXMsIHByaW9yKTtcbiAgICBcbiAgICByZXR1cm4gcHJpb3I7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgdGhlIHBlZXIgaWQgYWxyZWFkeSBleGlzdHMgaW4gdGhlIHRhYmxlc1xuICovXG5mdW5jdGlvbiBhbHJlYWR5RXhpc3RzKG1lc3NhZ2UsIGNhbGxiYWNrcyl7XG4gICAgdmFyIGFscmVhZHlFeGlzdHMgPSB0aGlzLmdldChtZXNzYWdlLnBpZCk7XG4gICAgaWYgICghYWxyZWFkeUV4aXN0cyl7XG4gICAgICAgIC8vICNBIGRvZXMgbm90IGFscmVhZHkgZXhpc3RzIGJ1dCBwZW5kaW5nXG4gICAgICAgIHZhciBlbnRyeSA9IHRoaXMucGVuZGluZy5nZXQobWVzc2FnZS50aWQpO1xuICAgICAgICBlbnRyeSAmJiBlbnRyeS5zb2NrZXQgJiYgZW50cnkuc29ja2V0LnNpZ25hbChtZXNzYWdlLm9mZmVyKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICAvLyAjQiBhbHJlYWR5IGV4aXN0cyBhbmQgcGVuZGluZ1xuICAgICAgICB2YXIgdG9SZW1vdmUgPSB0aGlzLnBlbmRpbmcuZ2V0KG1lc3NhZ2UudGlkKTsgICAgICAgIFxuICAgICAgICBpZiAodG9SZW1vdmUgJiYgdG9SZW1vdmUuc29ja2V0KXsgLy8gZXhpc3RzIGJ1dCBzb2NrZXQgc3RpbGwgdzhpblxuICAgICAgICAgICAgaWYgKCFhbHJlYWR5RXhpc3RzLnRpbWVvdXQpe1xuICAgICAgICAgICAgICAgIC8vICMxIGFscmVhZHkgaW4gbGl2aW5nIHNvY2tldCwgYWRkIGFuIG9jY3VycmVuY2VcbiAgICAgICAgICAgICAgICB0aGlzLmxpdmluZy5pbnNlcnQobWVzc2FnZS5waWQpO1xuICAgICAgICAgICAgICAgIHRvUmVtb3ZlLnN1Y2Nlc3NmdWwgPSB0cnVlO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyAjMiB3YXMgZHlpbmcsIHJlc3VyZWN0IHRoZSBzb2NrZXQgXG4gICAgICAgICAgICAgICAgdGhpcy5keWluZy5yZW1vdmUoYWxyZWFkeUV4aXN0cyk7XG4gICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGFscmVhZHlFeGlzdHMudGltZW91dCk7XG4gICAgICAgICAgICAgICAgYWxyZWFkeUV4aXN0cy50aW1lb3V0ID0gbnVsbDtcbiAgICAgICAgICAgICAgICB0aGlzLmxpdmluZy5pbnNlcnQoYWxyZWFkeUV4aXN0cyk7XG4gICAgICAgICAgICAgICAgdG9SZW1vdmUuc3VjY2Vzc2Z1bCA9IHRydWU7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgdG9SZW1vdmUuc29ja2V0LmRlc3Ryb3koKTtcbiAgICAgICAgICAgIC8vICNDIHN0YW5kYXJkIG9uIGFjY2VwdCBmdW5jdGlvbiBpZiBpdCBleGlzdHMgaW4gYXJnXG4gICAgICAgICAgICBtZXNzYWdlLm9mZmVyICYmXG4gICAgICAgICAgICAgICAgY2FsbGJhY2tzICYmXG4gICAgICAgICAgICAgICAgY2FsbGJhY2tzLm9uQWNjZXB0ICYmXG4gICAgICAgICAgICAgICAgY2FsbGJhY2tzLm9uQWNjZXB0KG5ldyBNUmVzcG9uc2UobWVzc2FnZS50aWQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5JRCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBudWxsLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1lc3NhZ2UucHJvdG9jb2wpKTtcbiAgICAgICAgICAgIChjYWxsYmFja3MgJiZcbiAgICAgICAgICAgICBjYWxsYmFja3Mub25SZWFkeSAmJlxuICAgICAgICAgICAgIGNhbGxiYWNrcy5vblJlYWR5KGFscmVhZHlFeGlzdHMuaWQpKSB8fFxuICAgICAgICAgICAgICAgICh0b1JlbW92ZSAmJlxuICAgICAgICAgICAgICAgICB0b1JlbW92ZS5vblJlYWR5ICYmXG4gICAgICAgICAgICAgICAgIHRvUmVtb3ZlLm9uUmVhZHkoYWxyZWFkeUV4aXN0cy5pZCkpO1xuICAgICAgICAgICAgdGhpcy5lbWl0KCdyZWFkeScsIGFscmVhZHlFeGlzdHMuaWQpO1xuICAgICAgICAgICAgbWVzc2FnZS5wcm90b2NvbCAmJiB0aGlzLmVtaXQoJ3JlYWR5LScrbWVzc2FnZS5wcm90b2NvbCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFscmVhZHlFeGlzdHMuaWQpO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgXG4gICAgcmV0dXJuIGFscmVhZHlFeGlzdHM7XG59O1xuXG5cblxuLyohXG4gKiBcXGJyaWVmIGNvbXBhcmUgdGhlIGlkIG9mIGVudHJpZXMgaW4gdGFibGVzXG4gKi9cbmZ1bmN0aW9uIENvbXBhcmF0b3IoYSwgYil7XG4gICAgdmFyIGZpcnN0ID0gYS5pZCB8fCBhO1xuICAgIHZhciBzZWNvbmQgPSBiLmlkIHx8IGI7XG4gICAgaWYgKGZpcnN0IDwgc2Vjb25kKXsgcmV0dXJuIC0xOyB9O1xuICAgIGlmIChmaXJzdCA+IHNlY29uZCl7IHJldHVybiAgMTsgfTtcbiAgICByZXR1cm4gMDtcbn07XG5cblxubW9kdWxlLmV4cG9ydHMgPSBOZWlnaGJvcmhvb2Q7XG4iLCIoZnVuY3Rpb24gKEJ1ZmZlcil7XG4vLyBDb3B5cmlnaHQgSm95ZW50LCBJbmMuIGFuZCBvdGhlciBOb2RlIGNvbnRyaWJ1dG9ycy5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYVxuLy8gY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZVxuLy8gXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nXG4vLyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsXG4vLyBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0XG4vLyBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGVcbi8vIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkXG4vLyBpbiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTXG4vLyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GXG4vLyBNRVJDSEFOVEFCSUxJVFksIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOXG4vLyBOTyBFVkVOVCBTSEFMTCBUSEUgQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSxcbi8vIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUlxuLy8gT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRVxuLy8gVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxuLy8gTk9URTogVGhlc2UgdHlwZSBjaGVja2luZyBmdW5jdGlvbnMgaW50ZW50aW9uYWxseSBkb24ndCB1c2UgYGluc3RhbmNlb2ZgXG4vLyBiZWNhdXNlIGl0IGlzIGZyYWdpbGUgYW5kIGNhbiBiZSBlYXNpbHkgZmFrZWQgd2l0aCBgT2JqZWN0LmNyZWF0ZSgpYC5cblxuZnVuY3Rpb24gaXNBcnJheShhcmcpIHtcbiAgaWYgKEFycmF5LmlzQXJyYXkpIHtcbiAgICByZXR1cm4gQXJyYXkuaXNBcnJheShhcmcpO1xuICB9XG4gIHJldHVybiBvYmplY3RUb1N0cmluZyhhcmcpID09PSAnW29iamVjdCBBcnJheV0nO1xufVxuZXhwb3J0cy5pc0FycmF5ID0gaXNBcnJheTtcblxuZnVuY3Rpb24gaXNCb29sZWFuKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ2Jvb2xlYW4nO1xufVxuZXhwb3J0cy5pc0Jvb2xlYW4gPSBpc0Jvb2xlYW47XG5cbmZ1bmN0aW9uIGlzTnVsbChhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gbnVsbDtcbn1cbmV4cG9ydHMuaXNOdWxsID0gaXNOdWxsO1xuXG5mdW5jdGlvbiBpc051bGxPclVuZGVmaW5lZChhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PSBudWxsO1xufVxuZXhwb3J0cy5pc051bGxPclVuZGVmaW5lZCA9IGlzTnVsbE9yVW5kZWZpbmVkO1xuXG5mdW5jdGlvbiBpc051bWJlcihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdudW1iZXInO1xufVxuZXhwb3J0cy5pc051bWJlciA9IGlzTnVtYmVyO1xuXG5mdW5jdGlvbiBpc1N0cmluZyhhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdzdHJpbmcnO1xufVxuZXhwb3J0cy5pc1N0cmluZyA9IGlzU3RyaW5nO1xuXG5mdW5jdGlvbiBpc1N5bWJvbChhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdzeW1ib2wnO1xufVxuZXhwb3J0cy5pc1N5bWJvbCA9IGlzU3ltYm9sO1xuXG5mdW5jdGlvbiBpc1VuZGVmaW5lZChhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gdm9pZCAwO1xufVxuZXhwb3J0cy5pc1VuZGVmaW5lZCA9IGlzVW5kZWZpbmVkO1xuXG5mdW5jdGlvbiBpc1JlZ0V4cChyZSkge1xuICByZXR1cm4gb2JqZWN0VG9TdHJpbmcocmUpID09PSAnW29iamVjdCBSZWdFeHBdJztcbn1cbmV4cG9ydHMuaXNSZWdFeHAgPSBpc1JlZ0V4cDtcblxuZnVuY3Rpb24gaXNPYmplY3QoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBhcmcgIT09IG51bGw7XG59XG5leHBvcnRzLmlzT2JqZWN0ID0gaXNPYmplY3Q7XG5cbmZ1bmN0aW9uIGlzRGF0ZShkKSB7XG4gIHJldHVybiBvYmplY3RUb1N0cmluZyhkKSA9PT0gJ1tvYmplY3QgRGF0ZV0nO1xufVxuZXhwb3J0cy5pc0RhdGUgPSBpc0RhdGU7XG5cbmZ1bmN0aW9uIGlzRXJyb3IoZSkge1xuICByZXR1cm4gKG9iamVjdFRvU3RyaW5nKGUpID09PSAnW29iamVjdCBFcnJvcl0nIHx8IGUgaW5zdGFuY2VvZiBFcnJvcik7XG59XG5leHBvcnRzLmlzRXJyb3IgPSBpc0Vycm9yO1xuXG5mdW5jdGlvbiBpc0Z1bmN0aW9uKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ2Z1bmN0aW9uJztcbn1cbmV4cG9ydHMuaXNGdW5jdGlvbiA9IGlzRnVuY3Rpb247XG5cbmZ1bmN0aW9uIGlzUHJpbWl0aXZlKGFyZykge1xuICByZXR1cm4gYXJnID09PSBudWxsIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnYm9vbGVhbicgfHxcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICdudW1iZXInIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnc3RyaW5nJyB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ3N5bWJvbCcgfHwgIC8vIEVTNiBzeW1ib2xcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICd1bmRlZmluZWQnO1xufVxuZXhwb3J0cy5pc1ByaW1pdGl2ZSA9IGlzUHJpbWl0aXZlO1xuXG5leHBvcnRzLmlzQnVmZmVyID0gQnVmZmVyLmlzQnVmZmVyO1xuXG5mdW5jdGlvbiBvYmplY3RUb1N0cmluZyhvKSB7XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwobyk7XG59XG5cbn0pLmNhbGwodGhpcyxyZXF1aXJlKFwiYnVmZmVyXCIpLkJ1ZmZlcikiLCJcbi8qKlxuICogVGhpcyBpcyB0aGUgd2ViIGJyb3dzZXIgaW1wbGVtZW50YXRpb24gb2YgYGRlYnVnKClgLlxuICpcbiAqIEV4cG9zZSBgZGVidWcoKWAgYXMgdGhlIG1vZHVsZS5cbiAqL1xuXG5leHBvcnRzID0gbW9kdWxlLmV4cG9ydHMgPSByZXF1aXJlKCcuL2RlYnVnJyk7XG5leHBvcnRzLmxvZyA9IGxvZztcbmV4cG9ydHMuZm9ybWF0QXJncyA9IGZvcm1hdEFyZ3M7XG5leHBvcnRzLnNhdmUgPSBzYXZlO1xuZXhwb3J0cy5sb2FkID0gbG9hZDtcbmV4cG9ydHMudXNlQ29sb3JzID0gdXNlQ29sb3JzO1xuZXhwb3J0cy5zdG9yYWdlID0gJ3VuZGVmaW5lZCcgIT0gdHlwZW9mIGNocm9tZVxuICAgICAgICAgICAgICAgJiYgJ3VuZGVmaW5lZCcgIT0gdHlwZW9mIGNocm9tZS5zdG9yYWdlXG4gICAgICAgICAgICAgICAgICA/IGNocm9tZS5zdG9yYWdlLmxvY2FsXG4gICAgICAgICAgICAgICAgICA6IGxvY2Fsc3RvcmFnZSgpO1xuXG4vKipcbiAqIENvbG9ycy5cbiAqL1xuXG5leHBvcnRzLmNvbG9ycyA9IFtcbiAgJ2xpZ2h0c2VhZ3JlZW4nLFxuICAnZm9yZXN0Z3JlZW4nLFxuICAnZ29sZGVucm9kJyxcbiAgJ2RvZGdlcmJsdWUnLFxuICAnZGFya29yY2hpZCcsXG4gICdjcmltc29uJ1xuXTtcblxuLyoqXG4gKiBDdXJyZW50bHkgb25seSBXZWJLaXQtYmFzZWQgV2ViIEluc3BlY3RvcnMsIEZpcmVmb3ggPj0gdjMxLFxuICogYW5kIHRoZSBGaXJlYnVnIGV4dGVuc2lvbiAoYW55IEZpcmVmb3ggdmVyc2lvbikgYXJlIGtub3duXG4gKiB0byBzdXBwb3J0IFwiJWNcIiBDU1MgY3VzdG9taXphdGlvbnMuXG4gKlxuICogVE9ETzogYWRkIGEgYGxvY2FsU3RvcmFnZWAgdmFyaWFibGUgdG8gZXhwbGljaXRseSBlbmFibGUvZGlzYWJsZSBjb2xvcnNcbiAqL1xuXG5mdW5jdGlvbiB1c2VDb2xvcnMoKSB7XG4gIC8vIGlzIHdlYmtpdD8gaHR0cDovL3N0YWNrb3ZlcmZsb3cuY29tL2EvMTY0NTk2MDYvMzc2NzczXG4gIHJldHVybiAoJ1dlYmtpdEFwcGVhcmFuY2UnIGluIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5zdHlsZSkgfHxcbiAgICAvLyBpcyBmaXJlYnVnPyBodHRwOi8vc3RhY2tvdmVyZmxvdy5jb20vYS8zOTgxMjAvMzc2NzczXG4gICAgKHdpbmRvdy5jb25zb2xlICYmIChjb25zb2xlLmZpcmVidWcgfHwgKGNvbnNvbGUuZXhjZXB0aW9uICYmIGNvbnNvbGUudGFibGUpKSkgfHxcbiAgICAvLyBpcyBmaXJlZm94ID49IHYzMT9cbiAgICAvLyBodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1Rvb2xzL1dlYl9Db25zb2xlI1N0eWxpbmdfbWVzc2FnZXNcbiAgICAobmF2aWdhdG9yLnVzZXJBZ2VudC50b0xvd2VyQ2FzZSgpLm1hdGNoKC9maXJlZm94XFwvKFxcZCspLykgJiYgcGFyc2VJbnQoUmVnRXhwLiQxLCAxMCkgPj0gMzEpO1xufVxuXG4vKipcbiAqIE1hcCAlaiB0byBgSlNPTi5zdHJpbmdpZnkoKWAsIHNpbmNlIG5vIFdlYiBJbnNwZWN0b3JzIGRvIHRoYXQgYnkgZGVmYXVsdC5cbiAqL1xuXG5leHBvcnRzLmZvcm1hdHRlcnMuaiA9IGZ1bmN0aW9uKHYpIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHYpO1xufTtcblxuXG4vKipcbiAqIENvbG9yaXplIGxvZyBhcmd1bWVudHMgaWYgZW5hYmxlZC5cbiAqXG4gKiBAYXBpIHB1YmxpY1xuICovXG5cbmZ1bmN0aW9uIGZvcm1hdEFyZ3MoKSB7XG4gIHZhciBhcmdzID0gYXJndW1lbnRzO1xuICB2YXIgdXNlQ29sb3JzID0gdGhpcy51c2VDb2xvcnM7XG5cbiAgYXJnc1swXSA9ICh1c2VDb2xvcnMgPyAnJWMnIDogJycpXG4gICAgKyB0aGlzLm5hbWVzcGFjZVxuICAgICsgKHVzZUNvbG9ycyA/ICcgJWMnIDogJyAnKVxuICAgICsgYXJnc1swXVxuICAgICsgKHVzZUNvbG9ycyA/ICclYyAnIDogJyAnKVxuICAgICsgJysnICsgZXhwb3J0cy5odW1hbml6ZSh0aGlzLmRpZmYpO1xuXG4gIGlmICghdXNlQ29sb3JzKSByZXR1cm4gYXJncztcblxuICB2YXIgYyA9ICdjb2xvcjogJyArIHRoaXMuY29sb3I7XG4gIGFyZ3MgPSBbYXJnc1swXSwgYywgJ2NvbG9yOiBpbmhlcml0J10uY29uY2F0KEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3MsIDEpKTtcblxuICAvLyB0aGUgZmluYWwgXCIlY1wiIGlzIHNvbWV3aGF0IHRyaWNreSwgYmVjYXVzZSB0aGVyZSBjb3VsZCBiZSBvdGhlclxuICAvLyBhcmd1bWVudHMgcGFzc2VkIGVpdGhlciBiZWZvcmUgb3IgYWZ0ZXIgdGhlICVjLCBzbyB3ZSBuZWVkIHRvXG4gIC8vIGZpZ3VyZSBvdXQgdGhlIGNvcnJlY3QgaW5kZXggdG8gaW5zZXJ0IHRoZSBDU1MgaW50b1xuICB2YXIgaW5kZXggPSAwO1xuICB2YXIgbGFzdEMgPSAwO1xuICBhcmdzWzBdLnJlcGxhY2UoLyVbYS16JV0vZywgZnVuY3Rpb24obWF0Y2gpIHtcbiAgICBpZiAoJyUlJyA9PT0gbWF0Y2gpIHJldHVybjtcbiAgICBpbmRleCsrO1xuICAgIGlmICgnJWMnID09PSBtYXRjaCkge1xuICAgICAgLy8gd2Ugb25seSBhcmUgaW50ZXJlc3RlZCBpbiB0aGUgKmxhc3QqICVjXG4gICAgICAvLyAodGhlIHVzZXIgbWF5IGhhdmUgcHJvdmlkZWQgdGhlaXIgb3duKVxuICAgICAgbGFzdEMgPSBpbmRleDtcbiAgICB9XG4gIH0pO1xuXG4gIGFyZ3Muc3BsaWNlKGxhc3RDLCAwLCBjKTtcbiAgcmV0dXJuIGFyZ3M7XG59XG5cbi8qKlxuICogSW52b2tlcyBgY29uc29sZS5sb2coKWAgd2hlbiBhdmFpbGFibGUuXG4gKiBOby1vcCB3aGVuIGBjb25zb2xlLmxvZ2AgaXMgbm90IGEgXCJmdW5jdGlvblwiLlxuICpcbiAqIEBhcGkgcHVibGljXG4gKi9cblxuZnVuY3Rpb24gbG9nKCkge1xuICAvLyB0aGlzIGhhY2tlcnkgaXMgcmVxdWlyZWQgZm9yIElFOC85LCB3aGVyZVxuICAvLyB0aGUgYGNvbnNvbGUubG9nYCBmdW5jdGlvbiBkb2Vzbid0IGhhdmUgJ2FwcGx5J1xuICByZXR1cm4gJ29iamVjdCcgPT09IHR5cGVvZiBjb25zb2xlXG4gICAgJiYgY29uc29sZS5sb2dcbiAgICAmJiBGdW5jdGlvbi5wcm90b3R5cGUuYXBwbHkuY2FsbChjb25zb2xlLmxvZywgY29uc29sZSwgYXJndW1lbnRzKTtcbn1cblxuLyoqXG4gKiBTYXZlIGBuYW1lc3BhY2VzYC5cbiAqXG4gKiBAcGFyYW0ge1N0cmluZ30gbmFtZXNwYWNlc1xuICogQGFwaSBwcml2YXRlXG4gKi9cblxuZnVuY3Rpb24gc2F2ZShuYW1lc3BhY2VzKSB7XG4gIHRyeSB7XG4gICAgaWYgKG51bGwgPT0gbmFtZXNwYWNlcykge1xuICAgICAgZXhwb3J0cy5zdG9yYWdlLnJlbW92ZUl0ZW0oJ2RlYnVnJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGV4cG9ydHMuc3RvcmFnZS5kZWJ1ZyA9IG5hbWVzcGFjZXM7XG4gICAgfVxuICB9IGNhdGNoKGUpIHt9XG59XG5cbi8qKlxuICogTG9hZCBgbmFtZXNwYWNlc2AuXG4gKlxuICogQHJldHVybiB7U3RyaW5nfSByZXR1cm5zIHRoZSBwcmV2aW91c2x5IHBlcnNpc3RlZCBkZWJ1ZyBtb2Rlc1xuICogQGFwaSBwcml2YXRlXG4gKi9cblxuZnVuY3Rpb24gbG9hZCgpIHtcbiAgdmFyIHI7XG4gIHRyeSB7XG4gICAgciA9IGV4cG9ydHMuc3RvcmFnZS5kZWJ1ZztcbiAgfSBjYXRjaChlKSB7fVxuICByZXR1cm4gcjtcbn1cblxuLyoqXG4gKiBFbmFibGUgbmFtZXNwYWNlcyBsaXN0ZWQgaW4gYGxvY2FsU3RvcmFnZS5kZWJ1Z2AgaW5pdGlhbGx5LlxuICovXG5cbmV4cG9ydHMuZW5hYmxlKGxvYWQoKSk7XG5cbi8qKlxuICogTG9jYWxzdG9yYWdlIGF0dGVtcHRzIHRvIHJldHVybiB0aGUgbG9jYWxzdG9yYWdlLlxuICpcbiAqIFRoaXMgaXMgbmVjZXNzYXJ5IGJlY2F1c2Ugc2FmYXJpIHRocm93c1xuICogd2hlbiBhIHVzZXIgZGlzYWJsZXMgY29va2llcy9sb2NhbHN0b3JhZ2VcbiAqIGFuZCB5b3UgYXR0ZW1wdCB0byBhY2Nlc3MgaXQuXG4gKlxuICogQHJldHVybiB7TG9jYWxTdG9yYWdlfVxuICogQGFwaSBwcml2YXRlXG4gKi9cblxuZnVuY3Rpb24gbG9jYWxzdG9yYWdlKCl7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHdpbmRvdy5sb2NhbFN0b3JhZ2U7XG4gIH0gY2F0Y2ggKGUpIHt9XG59XG4iLCJcbi8qKlxuICogVGhpcyBpcyB0aGUgY29tbW9uIGxvZ2ljIGZvciBib3RoIHRoZSBOb2RlLmpzIGFuZCB3ZWIgYnJvd3NlclxuICogaW1wbGVtZW50YXRpb25zIG9mIGBkZWJ1ZygpYC5cbiAqXG4gKiBFeHBvc2UgYGRlYnVnKClgIGFzIHRoZSBtb2R1bGUuXG4gKi9cblxuZXhwb3J0cyA9IG1vZHVsZS5leHBvcnRzID0gZGVidWc7XG5leHBvcnRzLmNvZXJjZSA9IGNvZXJjZTtcbmV4cG9ydHMuZGlzYWJsZSA9IGRpc2FibGU7XG5leHBvcnRzLmVuYWJsZSA9IGVuYWJsZTtcbmV4cG9ydHMuZW5hYmxlZCA9IGVuYWJsZWQ7XG5leHBvcnRzLmh1bWFuaXplID0gcmVxdWlyZSgnbXMnKTtcblxuLyoqXG4gKiBUaGUgY3VycmVudGx5IGFjdGl2ZSBkZWJ1ZyBtb2RlIG5hbWVzLCBhbmQgbmFtZXMgdG8gc2tpcC5cbiAqL1xuXG5leHBvcnRzLm5hbWVzID0gW107XG5leHBvcnRzLnNraXBzID0gW107XG5cbi8qKlxuICogTWFwIG9mIHNwZWNpYWwgXCIlblwiIGhhbmRsaW5nIGZ1bmN0aW9ucywgZm9yIHRoZSBkZWJ1ZyBcImZvcm1hdFwiIGFyZ3VtZW50LlxuICpcbiAqIFZhbGlkIGtleSBuYW1lcyBhcmUgYSBzaW5nbGUsIGxvd2VyY2FzZWQgbGV0dGVyLCBpLmUuIFwiblwiLlxuICovXG5cbmV4cG9ydHMuZm9ybWF0dGVycyA9IHt9O1xuXG4vKipcbiAqIFByZXZpb3VzbHkgYXNzaWduZWQgY29sb3IuXG4gKi9cblxudmFyIHByZXZDb2xvciA9IDA7XG5cbi8qKlxuICogUHJldmlvdXMgbG9nIHRpbWVzdGFtcC5cbiAqL1xuXG52YXIgcHJldlRpbWU7XG5cbi8qKlxuICogU2VsZWN0IGEgY29sb3IuXG4gKlxuICogQHJldHVybiB7TnVtYmVyfVxuICogQGFwaSBwcml2YXRlXG4gKi9cblxuZnVuY3Rpb24gc2VsZWN0Q29sb3IoKSB7XG4gIHJldHVybiBleHBvcnRzLmNvbG9yc1twcmV2Q29sb3IrKyAlIGV4cG9ydHMuY29sb3JzLmxlbmd0aF07XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgZGVidWdnZXIgd2l0aCB0aGUgZ2l2ZW4gYG5hbWVzcGFjZWAuXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IG5hbWVzcGFjZVxuICogQHJldHVybiB7RnVuY3Rpb259XG4gKiBAYXBpIHB1YmxpY1xuICovXG5cbmZ1bmN0aW9uIGRlYnVnKG5hbWVzcGFjZSkge1xuXG4gIC8vIGRlZmluZSB0aGUgYGRpc2FibGVkYCB2ZXJzaW9uXG4gIGZ1bmN0aW9uIGRpc2FibGVkKCkge1xuICB9XG4gIGRpc2FibGVkLmVuYWJsZWQgPSBmYWxzZTtcblxuICAvLyBkZWZpbmUgdGhlIGBlbmFibGVkYCB2ZXJzaW9uXG4gIGZ1bmN0aW9uIGVuYWJsZWQoKSB7XG5cbiAgICB2YXIgc2VsZiA9IGVuYWJsZWQ7XG5cbiAgICAvLyBzZXQgYGRpZmZgIHRpbWVzdGFtcFxuICAgIHZhciBjdXJyID0gK25ldyBEYXRlKCk7XG4gICAgdmFyIG1zID0gY3VyciAtIChwcmV2VGltZSB8fCBjdXJyKTtcbiAgICBzZWxmLmRpZmYgPSBtcztcbiAgICBzZWxmLnByZXYgPSBwcmV2VGltZTtcbiAgICBzZWxmLmN1cnIgPSBjdXJyO1xuICAgIHByZXZUaW1lID0gY3VycjtcblxuICAgIC8vIGFkZCB0aGUgYGNvbG9yYCBpZiBub3Qgc2V0XG4gICAgaWYgKG51bGwgPT0gc2VsZi51c2VDb2xvcnMpIHNlbGYudXNlQ29sb3JzID0gZXhwb3J0cy51c2VDb2xvcnMoKTtcbiAgICBpZiAobnVsbCA9PSBzZWxmLmNvbG9yICYmIHNlbGYudXNlQ29sb3JzKSBzZWxmLmNvbG9yID0gc2VsZWN0Q29sb3IoKTtcblxuICAgIHZhciBhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzKTtcblxuICAgIGFyZ3NbMF0gPSBleHBvcnRzLmNvZXJjZShhcmdzWzBdKTtcblxuICAgIGlmICgnc3RyaW5nJyAhPT0gdHlwZW9mIGFyZ3NbMF0pIHtcbiAgICAgIC8vIGFueXRoaW5nIGVsc2UgbGV0J3MgaW5zcGVjdCB3aXRoICVvXG4gICAgICBhcmdzID0gWyclbyddLmNvbmNhdChhcmdzKTtcbiAgICB9XG5cbiAgICAvLyBhcHBseSBhbnkgYGZvcm1hdHRlcnNgIHRyYW5zZm9ybWF0aW9uc1xuICAgIHZhciBpbmRleCA9IDA7XG4gICAgYXJnc1swXSA9IGFyZ3NbMF0ucmVwbGFjZSgvJShbYS16JV0pL2csIGZ1bmN0aW9uKG1hdGNoLCBmb3JtYXQpIHtcbiAgICAgIC8vIGlmIHdlIGVuY291bnRlciBhbiBlc2NhcGVkICUgdGhlbiBkb24ndCBpbmNyZWFzZSB0aGUgYXJyYXkgaW5kZXhcbiAgICAgIGlmIChtYXRjaCA9PT0gJyUlJykgcmV0dXJuIG1hdGNoO1xuICAgICAgaW5kZXgrKztcbiAgICAgIHZhciBmb3JtYXR0ZXIgPSBleHBvcnRzLmZvcm1hdHRlcnNbZm9ybWF0XTtcbiAgICAgIGlmICgnZnVuY3Rpb24nID09PSB0eXBlb2YgZm9ybWF0dGVyKSB7XG4gICAgICAgIHZhciB2YWwgPSBhcmdzW2luZGV4XTtcbiAgICAgICAgbWF0Y2ggPSBmb3JtYXR0ZXIuY2FsbChzZWxmLCB2YWwpO1xuXG4gICAgICAgIC8vIG5vdyB3ZSBuZWVkIHRvIHJlbW92ZSBgYXJnc1tpbmRleF1gIHNpbmNlIGl0J3MgaW5saW5lZCBpbiB0aGUgYGZvcm1hdGBcbiAgICAgICAgYXJncy5zcGxpY2UoaW5kZXgsIDEpO1xuICAgICAgICBpbmRleC0tO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG1hdGNoO1xuICAgIH0pO1xuXG4gICAgaWYgKCdmdW5jdGlvbicgPT09IHR5cGVvZiBleHBvcnRzLmZvcm1hdEFyZ3MpIHtcbiAgICAgIGFyZ3MgPSBleHBvcnRzLmZvcm1hdEFyZ3MuYXBwbHkoc2VsZiwgYXJncyk7XG4gICAgfVxuICAgIHZhciBsb2dGbiA9IGVuYWJsZWQubG9nIHx8IGV4cG9ydHMubG9nIHx8IGNvbnNvbGUubG9nLmJpbmQoY29uc29sZSk7XG4gICAgbG9nRm4uYXBwbHkoc2VsZiwgYXJncyk7XG4gIH1cbiAgZW5hYmxlZC5lbmFibGVkID0gdHJ1ZTtcblxuICB2YXIgZm4gPSBleHBvcnRzLmVuYWJsZWQobmFtZXNwYWNlKSA/IGVuYWJsZWQgOiBkaXNhYmxlZDtcblxuICBmbi5uYW1lc3BhY2UgPSBuYW1lc3BhY2U7XG5cbiAgcmV0dXJuIGZuO1xufVxuXG4vKipcbiAqIEVuYWJsZXMgYSBkZWJ1ZyBtb2RlIGJ5IG5hbWVzcGFjZXMuIFRoaXMgY2FuIGluY2x1ZGUgbW9kZXNcbiAqIHNlcGFyYXRlZCBieSBhIGNvbG9uIGFuZCB3aWxkY2FyZHMuXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IG5hbWVzcGFjZXNcbiAqIEBhcGkgcHVibGljXG4gKi9cblxuZnVuY3Rpb24gZW5hYmxlKG5hbWVzcGFjZXMpIHtcbiAgZXhwb3J0cy5zYXZlKG5hbWVzcGFjZXMpO1xuXG4gIHZhciBzcGxpdCA9IChuYW1lc3BhY2VzIHx8ICcnKS5zcGxpdCgvW1xccyxdKy8pO1xuICB2YXIgbGVuID0gc3BsaXQubGVuZ3RoO1xuXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuOyBpKyspIHtcbiAgICBpZiAoIXNwbGl0W2ldKSBjb250aW51ZTsgLy8gaWdub3JlIGVtcHR5IHN0cmluZ3NcbiAgICBuYW1lc3BhY2VzID0gc3BsaXRbaV0ucmVwbGFjZSgvXFwqL2csICcuKj8nKTtcbiAgICBpZiAobmFtZXNwYWNlc1swXSA9PT0gJy0nKSB7XG4gICAgICBleHBvcnRzLnNraXBzLnB1c2gobmV3IFJlZ0V4cCgnXicgKyBuYW1lc3BhY2VzLnN1YnN0cigxKSArICckJykpO1xuICAgIH0gZWxzZSB7XG4gICAgICBleHBvcnRzLm5hbWVzLnB1c2gobmV3IFJlZ0V4cCgnXicgKyBuYW1lc3BhY2VzICsgJyQnKSk7XG4gICAgfVxuICB9XG59XG5cbi8qKlxuICogRGlzYWJsZSBkZWJ1ZyBvdXRwdXQuXG4gKlxuICogQGFwaSBwdWJsaWNcbiAqL1xuXG5mdW5jdGlvbiBkaXNhYmxlKCkge1xuICBleHBvcnRzLmVuYWJsZSgnJyk7XG59XG5cbi8qKlxuICogUmV0dXJucyB0cnVlIGlmIHRoZSBnaXZlbiBtb2RlIG5hbWUgaXMgZW5hYmxlZCwgZmFsc2Ugb3RoZXJ3aXNlLlxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSBuYW1lXG4gKiBAcmV0dXJuIHtCb29sZWFufVxuICogQGFwaSBwdWJsaWNcbiAqL1xuXG5mdW5jdGlvbiBlbmFibGVkKG5hbWUpIHtcbiAgdmFyIGksIGxlbjtcbiAgZm9yIChpID0gMCwgbGVuID0gZXhwb3J0cy5za2lwcy5sZW5ndGg7IGkgPCBsZW47IGkrKykge1xuICAgIGlmIChleHBvcnRzLnNraXBzW2ldLnRlc3QobmFtZSkpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cbiAgZm9yIChpID0gMCwgbGVuID0gZXhwb3J0cy5uYW1lcy5sZW5ndGg7IGkgPCBsZW47IGkrKykge1xuICAgIGlmIChleHBvcnRzLm5hbWVzW2ldLnRlc3QobmFtZSkpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKlxuICogQ29lcmNlIGB2YWxgLlxuICpcbiAqIEBwYXJhbSB7TWl4ZWR9IHZhbFxuICogQHJldHVybiB7TWl4ZWR9XG4gKiBAYXBpIHByaXZhdGVcbiAqL1xuXG5mdW5jdGlvbiBjb2VyY2UodmFsKSB7XG4gIGlmICh2YWwgaW5zdGFuY2VvZiBFcnJvcikgcmV0dXJuIHZhbC5zdGFjayB8fCB2YWwubWVzc2FnZTtcbiAgcmV0dXJuIHZhbDtcbn1cbiIsIi8vIG9yaWdpbmFsbHkgcHVsbGVkIG91dCBvZiBzaW1wbGUtcGVlclxuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIGdldEJyb3dzZXJSVEMgKCkge1xuICBpZiAodHlwZW9mIHdpbmRvdyA9PT0gJ3VuZGVmaW5lZCcpIHJldHVybiBudWxsXG4gIHZhciB3cnRjID0ge1xuICAgIFJUQ1BlZXJDb25uZWN0aW9uOiB3aW5kb3cuUlRDUGVlckNvbm5lY3Rpb24gfHwgd2luZG93Lm1velJUQ1BlZXJDb25uZWN0aW9uIHx8XG4gICAgICB3aW5kb3cud2Via2l0UlRDUGVlckNvbm5lY3Rpb24sXG4gICAgUlRDU2Vzc2lvbkRlc2NyaXB0aW9uOiB3aW5kb3cuUlRDU2Vzc2lvbkRlc2NyaXB0aW9uIHx8XG4gICAgICB3aW5kb3cubW96UlRDU2Vzc2lvbkRlc2NyaXB0aW9uIHx8IHdpbmRvdy53ZWJraXRSVENTZXNzaW9uRGVzY3JpcHRpb24sXG4gICAgUlRDSWNlQ2FuZGlkYXRlOiB3aW5kb3cuUlRDSWNlQ2FuZGlkYXRlIHx8IHdpbmRvdy5tb3pSVENJY2VDYW5kaWRhdGUgfHxcbiAgICAgIHdpbmRvdy53ZWJraXRSVENJY2VDYW5kaWRhdGVcbiAgfVxuICBpZiAoIXdydGMuUlRDUGVlckNvbm5lY3Rpb24pIHJldHVybiBudWxsXG4gIHJldHVybiB3cnRjXG59XG4iLCJ2YXIgaGF0ID0gbW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoYml0cywgYmFzZSkge1xuICAgIGlmICghYmFzZSkgYmFzZSA9IDE2O1xuICAgIGlmIChiaXRzID09PSB1bmRlZmluZWQpIGJpdHMgPSAxMjg7XG4gICAgaWYgKGJpdHMgPD0gMCkgcmV0dXJuICcwJztcbiAgICBcbiAgICB2YXIgZGlnaXRzID0gTWF0aC5sb2coTWF0aC5wb3coMiwgYml0cykpIC8gTWF0aC5sb2coYmFzZSk7XG4gICAgZm9yICh2YXIgaSA9IDI7IGRpZ2l0cyA9PT0gSW5maW5pdHk7IGkgKj0gMikge1xuICAgICAgICBkaWdpdHMgPSBNYXRoLmxvZyhNYXRoLnBvdygyLCBiaXRzIC8gaSkpIC8gTWF0aC5sb2coYmFzZSkgKiBpO1xuICAgIH1cbiAgICBcbiAgICB2YXIgcmVtID0gZGlnaXRzIC0gTWF0aC5mbG9vcihkaWdpdHMpO1xuICAgIFxuICAgIHZhciByZXMgPSAnJztcbiAgICBcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IE1hdGguZmxvb3IoZGlnaXRzKTsgaSsrKSB7XG4gICAgICAgIHZhciB4ID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogYmFzZSkudG9TdHJpbmcoYmFzZSk7XG4gICAgICAgIHJlcyA9IHggKyByZXM7XG4gICAgfVxuICAgIFxuICAgIGlmIChyZW0pIHtcbiAgICAgICAgdmFyIGIgPSBNYXRoLnBvdyhiYXNlLCByZW0pO1xuICAgICAgICB2YXIgeCA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIGIpLnRvU3RyaW5nKGJhc2UpO1xuICAgICAgICByZXMgPSB4ICsgcmVzO1xuICAgIH1cbiAgICBcbiAgICB2YXIgcGFyc2VkID0gcGFyc2VJbnQocmVzLCBiYXNlKTtcbiAgICBpZiAocGFyc2VkICE9PSBJbmZpbml0eSAmJiBwYXJzZWQgPj0gTWF0aC5wb3coMiwgYml0cykpIHtcbiAgICAgICAgcmV0dXJuIGhhdChiaXRzLCBiYXNlKVxuICAgIH1cbiAgICBlbHNlIHJldHVybiByZXM7XG59O1xuXG5oYXQucmFjayA9IGZ1bmN0aW9uIChiaXRzLCBiYXNlLCBleHBhbmRCeSkge1xuICAgIHZhciBmbiA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gICAgICAgIHZhciBpdGVycyA9IDA7XG4gICAgICAgIGRvIHtcbiAgICAgICAgICAgIGlmIChpdGVycyArKyA+IDEwKSB7XG4gICAgICAgICAgICAgICAgaWYgKGV4cGFuZEJ5KSBiaXRzICs9IGV4cGFuZEJ5O1xuICAgICAgICAgICAgICAgIGVsc2UgdGhyb3cgbmV3IEVycm9yKCd0b28gbWFueSBJRCBjb2xsaXNpb25zLCB1c2UgbW9yZSBiaXRzJylcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgdmFyIGlkID0gaGF0KGJpdHMsIGJhc2UpO1xuICAgICAgICB9IHdoaWxlIChPYmplY3QuaGFzT3duUHJvcGVydHkuY2FsbChoYXRzLCBpZCkpO1xuICAgICAgICBcbiAgICAgICAgaGF0c1tpZF0gPSBkYXRhO1xuICAgICAgICByZXR1cm4gaWQ7XG4gICAgfTtcbiAgICB2YXIgaGF0cyA9IGZuLmhhdHMgPSB7fTtcbiAgICBcbiAgICBmbi5nZXQgPSBmdW5jdGlvbiAoaWQpIHtcbiAgICAgICAgcmV0dXJuIGZuLmhhdHNbaWRdO1xuICAgIH07XG4gICAgXG4gICAgZm4uc2V0ID0gZnVuY3Rpb24gKGlkLCB2YWx1ZSkge1xuICAgICAgICBmbi5oYXRzW2lkXSA9IHZhbHVlO1xuICAgICAgICByZXR1cm4gZm47XG4gICAgfTtcbiAgICBcbiAgICBmbi5iaXRzID0gYml0cyB8fCAxMjg7XG4gICAgZm4uYmFzZSA9IGJhc2UgfHwgMTY7XG4gICAgcmV0dXJuIGZuO1xufTtcbiIsImlmICh0eXBlb2YgT2JqZWN0LmNyZWF0ZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAvLyBpbXBsZW1lbnRhdGlvbiBmcm9tIHN0YW5kYXJkIG5vZGUuanMgJ3V0aWwnIG1vZHVsZVxuICBtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIGluaGVyaXRzKGN0b3IsIHN1cGVyQ3Rvcikge1xuICAgIGN0b3Iuc3VwZXJfID0gc3VwZXJDdG9yXG4gICAgY3Rvci5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKHN1cGVyQ3Rvci5wcm90b3R5cGUsIHtcbiAgICAgIGNvbnN0cnVjdG9yOiB7XG4gICAgICAgIHZhbHVlOiBjdG9yLFxuICAgICAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICAgICAgd3JpdGFibGU6IHRydWUsXG4gICAgICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZVxuICAgICAgfVxuICAgIH0pO1xuICB9O1xufSBlbHNlIHtcbiAgLy8gb2xkIHNjaG9vbCBzaGltIGZvciBvbGQgYnJvd3NlcnNcbiAgbW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBpbmhlcml0cyhjdG9yLCBzdXBlckN0b3IpIHtcbiAgICBjdG9yLnN1cGVyXyA9IHN1cGVyQ3RvclxuICAgIHZhciBUZW1wQ3RvciA9IGZ1bmN0aW9uICgpIHt9XG4gICAgVGVtcEN0b3IucHJvdG90eXBlID0gc3VwZXJDdG9yLnByb3RvdHlwZVxuICAgIGN0b3IucHJvdG90eXBlID0gbmV3IFRlbXBDdG9yKClcbiAgICBjdG9yLnByb3RvdHlwZS5jb25zdHJ1Y3RvciA9IGN0b3JcbiAgfVxufVxuIiwibW9kdWxlLmV4cG9ydHMgPSBBcnJheS5pc0FycmF5IHx8IGZ1bmN0aW9uIChhcnIpIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChhcnIpID09ICdbb2JqZWN0IEFycmF5XSc7XG59O1xuIiwiLyoqXG4gKiBIZWxwZXJzLlxuICovXG5cbnZhciBzID0gMTAwMDtcbnZhciBtID0gcyAqIDYwO1xudmFyIGggPSBtICogNjA7XG52YXIgZCA9IGggKiAyNDtcbnZhciB5ID0gZCAqIDM2NS4yNTtcblxuLyoqXG4gKiBQYXJzZSBvciBmb3JtYXQgdGhlIGdpdmVuIGB2YWxgLlxuICpcbiAqIE9wdGlvbnM6XG4gKlxuICogIC0gYGxvbmdgIHZlcmJvc2UgZm9ybWF0dGluZyBbZmFsc2VdXG4gKlxuICogQHBhcmFtIHtTdHJpbmd8TnVtYmVyfSB2YWxcbiAqIEBwYXJhbSB7T2JqZWN0fSBvcHRpb25zXG4gKiBAcmV0dXJuIHtTdHJpbmd8TnVtYmVyfVxuICogQGFwaSBwdWJsaWNcbiAqL1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHZhbCwgb3B0aW9ucyl7XG4gIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuICBpZiAoJ3N0cmluZycgPT0gdHlwZW9mIHZhbCkgcmV0dXJuIHBhcnNlKHZhbCk7XG4gIHJldHVybiBvcHRpb25zLmxvbmdcbiAgICA/IGxvbmcodmFsKVxuICAgIDogc2hvcnQodmFsKTtcbn07XG5cbi8qKlxuICogUGFyc2UgdGhlIGdpdmVuIGBzdHJgIGFuZCByZXR1cm4gbWlsbGlzZWNvbmRzLlxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSBzdHJcbiAqIEByZXR1cm4ge051bWJlcn1cbiAqIEBhcGkgcHJpdmF0ZVxuICovXG5cbmZ1bmN0aW9uIHBhcnNlKHN0cikge1xuICBzdHIgPSAnJyArIHN0cjtcbiAgaWYgKHN0ci5sZW5ndGggPiAxMDAwMCkgcmV0dXJuO1xuICB2YXIgbWF0Y2ggPSAvXigoPzpcXGQrKT9cXC4/XFxkKykgKihtaWxsaXNlY29uZHM/fG1zZWNzP3xtc3xzZWNvbmRzP3xzZWNzP3xzfG1pbnV0ZXM/fG1pbnM/fG18aG91cnM/fGhycz98aHxkYXlzP3xkfHllYXJzP3x5cnM/fHkpPyQvaS5leGVjKHN0cik7XG4gIGlmICghbWF0Y2gpIHJldHVybjtcbiAgdmFyIG4gPSBwYXJzZUZsb2F0KG1hdGNoWzFdKTtcbiAgdmFyIHR5cGUgPSAobWF0Y2hbMl0gfHwgJ21zJykudG9Mb3dlckNhc2UoKTtcbiAgc3dpdGNoICh0eXBlKSB7XG4gICAgY2FzZSAneWVhcnMnOlxuICAgIGNhc2UgJ3llYXInOlxuICAgIGNhc2UgJ3lycyc6XG4gICAgY2FzZSAneXInOlxuICAgIGNhc2UgJ3knOlxuICAgICAgcmV0dXJuIG4gKiB5O1xuICAgIGNhc2UgJ2RheXMnOlxuICAgIGNhc2UgJ2RheSc6XG4gICAgY2FzZSAnZCc6XG4gICAgICByZXR1cm4gbiAqIGQ7XG4gICAgY2FzZSAnaG91cnMnOlxuICAgIGNhc2UgJ2hvdXInOlxuICAgIGNhc2UgJ2hycyc6XG4gICAgY2FzZSAnaHInOlxuICAgIGNhc2UgJ2gnOlxuICAgICAgcmV0dXJuIG4gKiBoO1xuICAgIGNhc2UgJ21pbnV0ZXMnOlxuICAgIGNhc2UgJ21pbnV0ZSc6XG4gICAgY2FzZSAnbWlucyc6XG4gICAgY2FzZSAnbWluJzpcbiAgICBjYXNlICdtJzpcbiAgICAgIHJldHVybiBuICogbTtcbiAgICBjYXNlICdzZWNvbmRzJzpcbiAgICBjYXNlICdzZWNvbmQnOlxuICAgIGNhc2UgJ3NlY3MnOlxuICAgIGNhc2UgJ3NlYyc6XG4gICAgY2FzZSAncyc6XG4gICAgICByZXR1cm4gbiAqIHM7XG4gICAgY2FzZSAnbWlsbGlzZWNvbmRzJzpcbiAgICBjYXNlICdtaWxsaXNlY29uZCc6XG4gICAgY2FzZSAnbXNlY3MnOlxuICAgIGNhc2UgJ21zZWMnOlxuICAgIGNhc2UgJ21zJzpcbiAgICAgIHJldHVybiBuO1xuICB9XG59XG5cbi8qKlxuICogU2hvcnQgZm9ybWF0IGZvciBgbXNgLlxuICpcbiAqIEBwYXJhbSB7TnVtYmVyfSBtc1xuICogQHJldHVybiB7U3RyaW5nfVxuICogQGFwaSBwcml2YXRlXG4gKi9cblxuZnVuY3Rpb24gc2hvcnQobXMpIHtcbiAgaWYgKG1zID49IGQpIHJldHVybiBNYXRoLnJvdW5kKG1zIC8gZCkgKyAnZCc7XG4gIGlmIChtcyA+PSBoKSByZXR1cm4gTWF0aC5yb3VuZChtcyAvIGgpICsgJ2gnO1xuICBpZiAobXMgPj0gbSkgcmV0dXJuIE1hdGgucm91bmQobXMgLyBtKSArICdtJztcbiAgaWYgKG1zID49IHMpIHJldHVybiBNYXRoLnJvdW5kKG1zIC8gcykgKyAncyc7XG4gIHJldHVybiBtcyArICdtcyc7XG59XG5cbi8qKlxuICogTG9uZyBmb3JtYXQgZm9yIGBtc2AuXG4gKlxuICogQHBhcmFtIHtOdW1iZXJ9IG1zXG4gKiBAcmV0dXJuIHtTdHJpbmd9XG4gKiBAYXBpIHByaXZhdGVcbiAqL1xuXG5mdW5jdGlvbiBsb25nKG1zKSB7XG4gIHJldHVybiBwbHVyYWwobXMsIGQsICdkYXknKVxuICAgIHx8IHBsdXJhbChtcywgaCwgJ2hvdXInKVxuICAgIHx8IHBsdXJhbChtcywgbSwgJ21pbnV0ZScpXG4gICAgfHwgcGx1cmFsKG1zLCBzLCAnc2Vjb25kJylcbiAgICB8fCBtcyArICcgbXMnO1xufVxuXG4vKipcbiAqIFBsdXJhbGl6YXRpb24gaGVscGVyLlxuICovXG5cbmZ1bmN0aW9uIHBsdXJhbChtcywgbiwgbmFtZSkge1xuICBpZiAobXMgPCBuKSByZXR1cm47XG4gIGlmIChtcyA8IG4gKiAxLjUpIHJldHVybiBNYXRoLmZsb29yKG1zIC8gbikgKyAnICcgKyBuYW1lO1xuICByZXR1cm4gTWF0aC5jZWlsKG1zIC8gbikgKyAnICcgKyBuYW1lICsgJ3MnO1xufVxuIiwidmFyIHdyYXBweSA9IHJlcXVpcmUoJ3dyYXBweScpXG5tb2R1bGUuZXhwb3J0cyA9IHdyYXBweShvbmNlKVxuXG5vbmNlLnByb3RvID0gb25jZShmdW5jdGlvbiAoKSB7XG4gIE9iamVjdC5kZWZpbmVQcm9wZXJ0eShGdW5jdGlvbi5wcm90b3R5cGUsICdvbmNlJywge1xuICAgIHZhbHVlOiBmdW5jdGlvbiAoKSB7XG4gICAgICByZXR1cm4gb25jZSh0aGlzKVxuICAgIH0sXG4gICAgY29uZmlndXJhYmxlOiB0cnVlXG4gIH0pXG59KVxuXG5mdW5jdGlvbiBvbmNlIChmbikge1xuICB2YXIgZiA9IGZ1bmN0aW9uICgpIHtcbiAgICBpZiAoZi5jYWxsZWQpIHJldHVybiBmLnZhbHVlXG4gICAgZi5jYWxsZWQgPSB0cnVlXG4gICAgcmV0dXJuIGYudmFsdWUgPSBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpXG4gIH1cbiAgZi5jYWxsZWQgPSBmYWxzZVxuICByZXR1cm4gZlxufVxuIiwiKGZ1bmN0aW9uIChwcm9jZXNzKXtcbid1c2Ugc3RyaWN0JztcblxuaWYgKCFwcm9jZXNzLnZlcnNpb24gfHxcbiAgICBwcm9jZXNzLnZlcnNpb24uaW5kZXhPZigndjAuJykgPT09IDAgfHxcbiAgICBwcm9jZXNzLnZlcnNpb24uaW5kZXhPZigndjEuJykgPT09IDAgJiYgcHJvY2Vzcy52ZXJzaW9uLmluZGV4T2YoJ3YxLjguJykgIT09IDApIHtcbiAgbW9kdWxlLmV4cG9ydHMgPSBuZXh0VGljaztcbn0gZWxzZSB7XG4gIG1vZHVsZS5leHBvcnRzID0gcHJvY2Vzcy5uZXh0VGljaztcbn1cblxuZnVuY3Rpb24gbmV4dFRpY2soZm4pIHtcbiAgdmFyIGFyZ3MgPSBuZXcgQXJyYXkoYXJndW1lbnRzLmxlbmd0aCAtIDEpO1xuICB2YXIgaSA9IDA7XG4gIHdoaWxlIChpIDwgYXJncy5sZW5ndGgpIHtcbiAgICBhcmdzW2krK10gPSBhcmd1bWVudHNbaV07XG4gIH1cbiAgcHJvY2Vzcy5uZXh0VGljayhmdW5jdGlvbiBhZnRlclRpY2soKSB7XG4gICAgZm4uYXBwbHkobnVsbCwgYXJncyk7XG4gIH0pO1xufVxuXG59KS5jYWxsKHRoaXMscmVxdWlyZSgnX3Byb2Nlc3MnKSkiLCIvLyBhIGR1cGxleCBzdHJlYW0gaXMganVzdCBhIHN0cmVhbSB0aGF0IGlzIGJvdGggcmVhZGFibGUgYW5kIHdyaXRhYmxlLlxuLy8gU2luY2UgSlMgZG9lc24ndCBoYXZlIG11bHRpcGxlIHByb3RvdHlwYWwgaW5oZXJpdGFuY2UsIHRoaXMgY2xhc3Ncbi8vIHByb3RvdHlwYWxseSBpbmhlcml0cyBmcm9tIFJlYWRhYmxlLCBhbmQgdGhlbiBwYXJhc2l0aWNhbGx5IGZyb21cbi8vIFdyaXRhYmxlLlxuXG4ndXNlIHN0cmljdCc7XG5cbi8qPHJlcGxhY2VtZW50PiovXG52YXIgb2JqZWN0S2V5cyA9IE9iamVjdC5rZXlzIHx8IGZ1bmN0aW9uIChvYmopIHtcbiAgdmFyIGtleXMgPSBbXTtcbiAgZm9yICh2YXIga2V5IGluIG9iaikga2V5cy5wdXNoKGtleSk7XG4gIHJldHVybiBrZXlzO1xufVxuLyo8L3JlcGxhY2VtZW50PiovXG5cblxubW9kdWxlLmV4cG9ydHMgPSBEdXBsZXg7XG5cbi8qPHJlcGxhY2VtZW50PiovXG52YXIgcHJvY2Vzc05leHRUaWNrID0gcmVxdWlyZSgncHJvY2Vzcy1uZXh0aWNrLWFyZ3MnKTtcbi8qPC9yZXBsYWNlbWVudD4qL1xuXG5cblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciB1dGlsID0gcmVxdWlyZSgnY29yZS11dGlsLWlzJyk7XG51dGlsLmluaGVyaXRzID0gcmVxdWlyZSgnaW5oZXJpdHMnKTtcbi8qPC9yZXBsYWNlbWVudD4qL1xuXG52YXIgUmVhZGFibGUgPSByZXF1aXJlKCcuL19zdHJlYW1fcmVhZGFibGUnKTtcbnZhciBXcml0YWJsZSA9IHJlcXVpcmUoJy4vX3N0cmVhbV93cml0YWJsZScpO1xuXG51dGlsLmluaGVyaXRzKER1cGxleCwgUmVhZGFibGUpO1xuXG52YXIga2V5cyA9IG9iamVjdEtleXMoV3JpdGFibGUucHJvdG90eXBlKTtcbmZvciAodmFyIHYgPSAwOyB2IDwga2V5cy5sZW5ndGg7IHYrKykge1xuICB2YXIgbWV0aG9kID0ga2V5c1t2XTtcbiAgaWYgKCFEdXBsZXgucHJvdG90eXBlW21ldGhvZF0pXG4gICAgRHVwbGV4LnByb3RvdHlwZVttZXRob2RdID0gV3JpdGFibGUucHJvdG90eXBlW21ldGhvZF07XG59XG5cbmZ1bmN0aW9uIER1cGxleChvcHRpb25zKSB7XG4gIGlmICghKHRoaXMgaW5zdGFuY2VvZiBEdXBsZXgpKVxuICAgIHJldHVybiBuZXcgRHVwbGV4KG9wdGlvbnMpO1xuXG4gIFJlYWRhYmxlLmNhbGwodGhpcywgb3B0aW9ucyk7XG4gIFdyaXRhYmxlLmNhbGwodGhpcywgb3B0aW9ucyk7XG5cbiAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yZWFkYWJsZSA9PT0gZmFsc2UpXG4gICAgdGhpcy5yZWFkYWJsZSA9IGZhbHNlO1xuXG4gIGlmIChvcHRpb25zICYmIG9wdGlvbnMud3JpdGFibGUgPT09IGZhbHNlKVxuICAgIHRoaXMud3JpdGFibGUgPSBmYWxzZTtcblxuICB0aGlzLmFsbG93SGFsZk9wZW4gPSB0cnVlO1xuICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLmFsbG93SGFsZk9wZW4gPT09IGZhbHNlKVxuICAgIHRoaXMuYWxsb3dIYWxmT3BlbiA9IGZhbHNlO1xuXG4gIHRoaXMub25jZSgnZW5kJywgb25lbmQpO1xufVxuXG4vLyB0aGUgbm8taGFsZi1vcGVuIGVuZm9yY2VyXG5mdW5jdGlvbiBvbmVuZCgpIHtcbiAgLy8gaWYgd2UgYWxsb3cgaGFsZi1vcGVuIHN0YXRlLCBvciBpZiB0aGUgd3JpdGFibGUgc2lkZSBlbmRlZCxcbiAgLy8gdGhlbiB3ZSdyZSBvay5cbiAgaWYgKHRoaXMuYWxsb3dIYWxmT3BlbiB8fCB0aGlzLl93cml0YWJsZVN0YXRlLmVuZGVkKVxuICAgIHJldHVybjtcblxuICAvLyBubyBtb3JlIGRhdGEgY2FuIGJlIHdyaXR0ZW4uXG4gIC8vIEJ1dCBhbGxvdyBtb3JlIHdyaXRlcyB0byBoYXBwZW4gaW4gdGhpcyB0aWNrLlxuICBwcm9jZXNzTmV4dFRpY2sob25FbmROVCwgdGhpcyk7XG59XG5cbmZ1bmN0aW9uIG9uRW5kTlQoc2VsZikge1xuICBzZWxmLmVuZCgpO1xufVxuXG5mdW5jdGlvbiBmb3JFYWNoICh4cywgZikge1xuICBmb3IgKHZhciBpID0gMCwgbCA9IHhzLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgIGYoeHNbaV0sIGkpO1xuICB9XG59XG4iLCIvLyBhIHBhc3N0aHJvdWdoIHN0cmVhbS5cbi8vIGJhc2ljYWxseSBqdXN0IHRoZSBtb3N0IG1pbmltYWwgc29ydCBvZiBUcmFuc2Zvcm0gc3RyZWFtLlxuLy8gRXZlcnkgd3JpdHRlbiBjaHVuayBnZXRzIG91dHB1dCBhcy1pcy5cblxuJ3VzZSBzdHJpY3QnO1xuXG5tb2R1bGUuZXhwb3J0cyA9IFBhc3NUaHJvdWdoO1xuXG52YXIgVHJhbnNmb3JtID0gcmVxdWlyZSgnLi9fc3RyZWFtX3RyYW5zZm9ybScpO1xuXG4vKjxyZXBsYWNlbWVudD4qL1xudmFyIHV0aWwgPSByZXF1aXJlKCdjb3JlLXV0aWwtaXMnKTtcbnV0aWwuaW5oZXJpdHMgPSByZXF1aXJlKCdpbmhlcml0cycpO1xuLyo8L3JlcGxhY2VtZW50PiovXG5cbnV0aWwuaW5oZXJpdHMoUGFzc1Rocm91Z2gsIFRyYW5zZm9ybSk7XG5cbmZ1bmN0aW9uIFBhc3NUaHJvdWdoKG9wdGlvbnMpIHtcbiAgaWYgKCEodGhpcyBpbnN0YW5jZW9mIFBhc3NUaHJvdWdoKSlcbiAgICByZXR1cm4gbmV3IFBhc3NUaHJvdWdoKG9wdGlvbnMpO1xuXG4gIFRyYW5zZm9ybS5jYWxsKHRoaXMsIG9wdGlvbnMpO1xufVxuXG5QYXNzVGhyb3VnaC5wcm90b3R5cGUuX3RyYW5zZm9ybSA9IGZ1bmN0aW9uKGNodW5rLCBlbmNvZGluZywgY2IpIHtcbiAgY2IobnVsbCwgY2h1bmspO1xufTtcbiIsIihmdW5jdGlvbiAocHJvY2Vzcyl7XG4ndXNlIHN0cmljdCc7XG5cbm1vZHVsZS5leHBvcnRzID0gUmVhZGFibGU7XG5cbi8qPHJlcGxhY2VtZW50PiovXG52YXIgcHJvY2Vzc05leHRUaWNrID0gcmVxdWlyZSgncHJvY2Vzcy1uZXh0aWNrLWFyZ3MnKTtcbi8qPC9yZXBsYWNlbWVudD4qL1xuXG5cbi8qPHJlcGxhY2VtZW50PiovXG52YXIgaXNBcnJheSA9IHJlcXVpcmUoJ2lzYXJyYXknKTtcbi8qPC9yZXBsYWNlbWVudD4qL1xuXG5cbi8qPHJlcGxhY2VtZW50PiovXG52YXIgQnVmZmVyID0gcmVxdWlyZSgnYnVmZmVyJykuQnVmZmVyO1xuLyo8L3JlcGxhY2VtZW50PiovXG5cblJlYWRhYmxlLlJlYWRhYmxlU3RhdGUgPSBSZWFkYWJsZVN0YXRlO1xuXG52YXIgRUUgPSByZXF1aXJlKCdldmVudHMnKTtcblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciBFRWxpc3RlbmVyQ291bnQgPSBmdW5jdGlvbihlbWl0dGVyLCB0eXBlKSB7XG4gIHJldHVybiBlbWl0dGVyLmxpc3RlbmVycyh0eXBlKS5sZW5ndGg7XG59O1xuLyo8L3JlcGxhY2VtZW50PiovXG5cblxuXG4vKjxyZXBsYWNlbWVudD4qL1xudmFyIFN0cmVhbTtcbihmdW5jdGlvbiAoKXt0cnl7XG4gIFN0cmVhbSA9IHJlcXVpcmUoJ3N0JyArICdyZWFtJyk7XG59Y2F0Y2goXyl7fWZpbmFsbHl7XG4gIGlmICghU3RyZWFtKVxuICAgIFN0cmVhbSA9IHJlcXVpcmUoJ2V2ZW50cycpLkV2ZW50RW1pdHRlcjtcbn19KCkpXG4vKjwvcmVwbGFjZW1lbnQ+Ki9cblxudmFyIEJ1ZmZlciA9IHJlcXVpcmUoJ2J1ZmZlcicpLkJ1ZmZlcjtcblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciB1dGlsID0gcmVxdWlyZSgnY29yZS11dGlsLWlzJyk7XG51dGlsLmluaGVyaXRzID0gcmVxdWlyZSgnaW5oZXJpdHMnKTtcbi8qPC9yZXBsYWNlbWVudD4qL1xuXG5cblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciBkZWJ1Z1V0aWwgPSByZXF1aXJlKCd1dGlsJyk7XG52YXIgZGVidWc7XG5pZiAoZGVidWdVdGlsICYmIGRlYnVnVXRpbC5kZWJ1Z2xvZykge1xuICBkZWJ1ZyA9IGRlYnVnVXRpbC5kZWJ1Z2xvZygnc3RyZWFtJyk7XG59IGVsc2Uge1xuICBkZWJ1ZyA9IGZ1bmN0aW9uICgpIHt9O1xufVxuLyo8L3JlcGxhY2VtZW50PiovXG5cbnZhciBTdHJpbmdEZWNvZGVyO1xuXG51dGlsLmluaGVyaXRzKFJlYWRhYmxlLCBTdHJlYW0pO1xuXG52YXIgRHVwbGV4O1xuZnVuY3Rpb24gUmVhZGFibGVTdGF0ZShvcHRpb25zLCBzdHJlYW0pIHtcbiAgRHVwbGV4ID0gRHVwbGV4IHx8IHJlcXVpcmUoJy4vX3N0cmVhbV9kdXBsZXgnKTtcblxuICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcblxuICAvLyBvYmplY3Qgc3RyZWFtIGZsYWcuIFVzZWQgdG8gbWFrZSByZWFkKG4pIGlnbm9yZSBuIGFuZCB0b1xuICAvLyBtYWtlIGFsbCB0aGUgYnVmZmVyIG1lcmdpbmcgYW5kIGxlbmd0aCBjaGVja3MgZ28gYXdheVxuICB0aGlzLm9iamVjdE1vZGUgPSAhIW9wdGlvbnMub2JqZWN0TW9kZTtcblxuICBpZiAoc3RyZWFtIGluc3RhbmNlb2YgRHVwbGV4KVxuICAgIHRoaXMub2JqZWN0TW9kZSA9IHRoaXMub2JqZWN0TW9kZSB8fCAhIW9wdGlvbnMucmVhZGFibGVPYmplY3RNb2RlO1xuXG4gIC8vIHRoZSBwb2ludCBhdCB3aGljaCBpdCBzdG9wcyBjYWxsaW5nIF9yZWFkKCkgdG8gZmlsbCB0aGUgYnVmZmVyXG4gIC8vIE5vdGU6IDAgaXMgYSB2YWxpZCB2YWx1ZSwgbWVhbnMgXCJkb24ndCBjYWxsIF9yZWFkIHByZWVtcHRpdmVseSBldmVyXCJcbiAgdmFyIGh3bSA9IG9wdGlvbnMuaGlnaFdhdGVyTWFyaztcbiAgdmFyIGRlZmF1bHRId20gPSB0aGlzLm9iamVjdE1vZGUgPyAxNiA6IDE2ICogMTAyNDtcbiAgdGhpcy5oaWdoV2F0ZXJNYXJrID0gKGh3bSB8fCBod20gPT09IDApID8gaHdtIDogZGVmYXVsdEh3bTtcblxuICAvLyBjYXN0IHRvIGludHMuXG4gIHRoaXMuaGlnaFdhdGVyTWFyayA9IH5+dGhpcy5oaWdoV2F0ZXJNYXJrO1xuXG4gIHRoaXMuYnVmZmVyID0gW107XG4gIHRoaXMubGVuZ3RoID0gMDtcbiAgdGhpcy5waXBlcyA9IG51bGw7XG4gIHRoaXMucGlwZXNDb3VudCA9IDA7XG4gIHRoaXMuZmxvd2luZyA9IG51bGw7XG4gIHRoaXMuZW5kZWQgPSBmYWxzZTtcbiAgdGhpcy5lbmRFbWl0dGVkID0gZmFsc2U7XG4gIHRoaXMucmVhZGluZyA9IGZhbHNlO1xuXG4gIC8vIGEgZmxhZyB0byBiZSBhYmxlIHRvIHRlbGwgaWYgdGhlIG9ud3JpdGUgY2IgaXMgY2FsbGVkIGltbWVkaWF0ZWx5LFxuICAvLyBvciBvbiBhIGxhdGVyIHRpY2suICBXZSBzZXQgdGhpcyB0byB0cnVlIGF0IGZpcnN0LCBiZWNhdXNlIGFueVxuICAvLyBhY3Rpb25zIHRoYXQgc2hvdWxkbid0IGhhcHBlbiB1bnRpbCBcImxhdGVyXCIgc2hvdWxkIGdlbmVyYWxseSBhbHNvXG4gIC8vIG5vdCBoYXBwZW4gYmVmb3JlIHRoZSBmaXJzdCB3cml0ZSBjYWxsLlxuICB0aGlzLnN5bmMgPSB0cnVlO1xuXG4gIC8vIHdoZW5ldmVyIHdlIHJldHVybiBudWxsLCB0aGVuIHdlIHNldCBhIGZsYWcgdG8gc2F5XG4gIC8vIHRoYXQgd2UncmUgYXdhaXRpbmcgYSAncmVhZGFibGUnIGV2ZW50IGVtaXNzaW9uLlxuICB0aGlzLm5lZWRSZWFkYWJsZSA9IGZhbHNlO1xuICB0aGlzLmVtaXR0ZWRSZWFkYWJsZSA9IGZhbHNlO1xuICB0aGlzLnJlYWRhYmxlTGlzdGVuaW5nID0gZmFsc2U7XG5cbiAgLy8gQ3J5cHRvIGlzIGtpbmQgb2Ygb2xkIGFuZCBjcnVzdHkuICBIaXN0b3JpY2FsbHksIGl0cyBkZWZhdWx0IHN0cmluZ1xuICAvLyBlbmNvZGluZyBpcyAnYmluYXJ5JyBzbyB3ZSBoYXZlIHRvIG1ha2UgdGhpcyBjb25maWd1cmFibGUuXG4gIC8vIEV2ZXJ5dGhpbmcgZWxzZSBpbiB0aGUgdW5pdmVyc2UgdXNlcyAndXRmOCcsIHRob3VnaC5cbiAgdGhpcy5kZWZhdWx0RW5jb2RpbmcgPSBvcHRpb25zLmRlZmF1bHRFbmNvZGluZyB8fCAndXRmOCc7XG5cbiAgLy8gd2hlbiBwaXBpbmcsIHdlIG9ubHkgY2FyZSBhYm91dCAncmVhZGFibGUnIGV2ZW50cyB0aGF0IGhhcHBlblxuICAvLyBhZnRlciByZWFkKClpbmcgYWxsIHRoZSBieXRlcyBhbmQgbm90IGdldHRpbmcgYW55IHB1c2hiYWNrLlxuICB0aGlzLnJhbk91dCA9IGZhbHNlO1xuXG4gIC8vIHRoZSBudW1iZXIgb2Ygd3JpdGVycyB0aGF0IGFyZSBhd2FpdGluZyBhIGRyYWluIGV2ZW50IGluIC5waXBlKClzXG4gIHRoaXMuYXdhaXREcmFpbiA9IDA7XG5cbiAgLy8gaWYgdHJ1ZSwgYSBtYXliZVJlYWRNb3JlIGhhcyBiZWVuIHNjaGVkdWxlZFxuICB0aGlzLnJlYWRpbmdNb3JlID0gZmFsc2U7XG5cbiAgdGhpcy5kZWNvZGVyID0gbnVsbDtcbiAgdGhpcy5lbmNvZGluZyA9IG51bGw7XG4gIGlmIChvcHRpb25zLmVuY29kaW5nKSB7XG4gICAgaWYgKCFTdHJpbmdEZWNvZGVyKVxuICAgICAgU3RyaW5nRGVjb2RlciA9IHJlcXVpcmUoJ3N0cmluZ19kZWNvZGVyLycpLlN0cmluZ0RlY29kZXI7XG4gICAgdGhpcy5kZWNvZGVyID0gbmV3IFN0cmluZ0RlY29kZXIob3B0aW9ucy5lbmNvZGluZyk7XG4gICAgdGhpcy5lbmNvZGluZyA9IG9wdGlvbnMuZW5jb2Rpbmc7XG4gIH1cbn1cblxudmFyIER1cGxleDtcbmZ1bmN0aW9uIFJlYWRhYmxlKG9wdGlvbnMpIHtcbiAgRHVwbGV4ID0gRHVwbGV4IHx8IHJlcXVpcmUoJy4vX3N0cmVhbV9kdXBsZXgnKTtcblxuICBpZiAoISh0aGlzIGluc3RhbmNlb2YgUmVhZGFibGUpKVxuICAgIHJldHVybiBuZXcgUmVhZGFibGUob3B0aW9ucyk7XG5cbiAgdGhpcy5fcmVhZGFibGVTdGF0ZSA9IG5ldyBSZWFkYWJsZVN0YXRlKG9wdGlvbnMsIHRoaXMpO1xuXG4gIC8vIGxlZ2FjeVxuICB0aGlzLnJlYWRhYmxlID0gdHJ1ZTtcblxuICBpZiAob3B0aW9ucyAmJiB0eXBlb2Ygb3B0aW9ucy5yZWFkID09PSAnZnVuY3Rpb24nKVxuICAgIHRoaXMuX3JlYWQgPSBvcHRpb25zLnJlYWQ7XG5cbiAgU3RyZWFtLmNhbGwodGhpcyk7XG59XG5cbi8vIE1hbnVhbGx5IHNob3ZlIHNvbWV0aGluZyBpbnRvIHRoZSByZWFkKCkgYnVmZmVyLlxuLy8gVGhpcyByZXR1cm5zIHRydWUgaWYgdGhlIGhpZ2hXYXRlck1hcmsgaGFzIG5vdCBiZWVuIGhpdCB5ZXQsXG4vLyBzaW1pbGFyIHRvIGhvdyBXcml0YWJsZS53cml0ZSgpIHJldHVybnMgdHJ1ZSBpZiB5b3Ugc2hvdWxkXG4vLyB3cml0ZSgpIHNvbWUgbW9yZS5cblJlYWRhYmxlLnByb3RvdHlwZS5wdXNoID0gZnVuY3Rpb24oY2h1bmssIGVuY29kaW5nKSB7XG4gIHZhciBzdGF0ZSA9IHRoaXMuX3JlYWRhYmxlU3RhdGU7XG5cbiAgaWYgKCFzdGF0ZS5vYmplY3RNb2RlICYmIHR5cGVvZiBjaHVuayA9PT0gJ3N0cmluZycpIHtcbiAgICBlbmNvZGluZyA9IGVuY29kaW5nIHx8IHN0YXRlLmRlZmF1bHRFbmNvZGluZztcbiAgICBpZiAoZW5jb2RpbmcgIT09IHN0YXRlLmVuY29kaW5nKSB7XG4gICAgICBjaHVuayA9IG5ldyBCdWZmZXIoY2h1bmssIGVuY29kaW5nKTtcbiAgICAgIGVuY29kaW5nID0gJyc7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlYWRhYmxlQWRkQ2h1bmsodGhpcywgc3RhdGUsIGNodW5rLCBlbmNvZGluZywgZmFsc2UpO1xufTtcblxuLy8gVW5zaGlmdCBzaG91bGQgKmFsd2F5cyogYmUgc29tZXRoaW5nIGRpcmVjdGx5IG91dCBvZiByZWFkKClcblJlYWRhYmxlLnByb3RvdHlwZS51bnNoaWZ0ID0gZnVuY3Rpb24oY2h1bmspIHtcbiAgdmFyIHN0YXRlID0gdGhpcy5fcmVhZGFibGVTdGF0ZTtcbiAgcmV0dXJuIHJlYWRhYmxlQWRkQ2h1bmsodGhpcywgc3RhdGUsIGNodW5rLCAnJywgdHJ1ZSk7XG59O1xuXG5SZWFkYWJsZS5wcm90b3R5cGUuaXNQYXVzZWQgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuX3JlYWRhYmxlU3RhdGUuZmxvd2luZyA9PT0gZmFsc2U7XG59O1xuXG5mdW5jdGlvbiByZWFkYWJsZUFkZENodW5rKHN0cmVhbSwgc3RhdGUsIGNodW5rLCBlbmNvZGluZywgYWRkVG9Gcm9udCkge1xuICB2YXIgZXIgPSBjaHVua0ludmFsaWQoc3RhdGUsIGNodW5rKTtcbiAgaWYgKGVyKSB7XG4gICAgc3RyZWFtLmVtaXQoJ2Vycm9yJywgZXIpO1xuICB9IGVsc2UgaWYgKGNodW5rID09PSBudWxsKSB7XG4gICAgc3RhdGUucmVhZGluZyA9IGZhbHNlO1xuICAgIG9uRW9mQ2h1bmsoc3RyZWFtLCBzdGF0ZSk7XG4gIH0gZWxzZSBpZiAoc3RhdGUub2JqZWN0TW9kZSB8fCBjaHVuayAmJiBjaHVuay5sZW5ndGggPiAwKSB7XG4gICAgaWYgKHN0YXRlLmVuZGVkICYmICFhZGRUb0Zyb250KSB7XG4gICAgICB2YXIgZSA9IG5ldyBFcnJvcignc3RyZWFtLnB1c2goKSBhZnRlciBFT0YnKTtcbiAgICAgIHN0cmVhbS5lbWl0KCdlcnJvcicsIGUpO1xuICAgIH0gZWxzZSBpZiAoc3RhdGUuZW5kRW1pdHRlZCAmJiBhZGRUb0Zyb250KSB7XG4gICAgICB2YXIgZSA9IG5ldyBFcnJvcignc3RyZWFtLnVuc2hpZnQoKSBhZnRlciBlbmQgZXZlbnQnKTtcbiAgICAgIHN0cmVhbS5lbWl0KCdlcnJvcicsIGUpO1xuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoc3RhdGUuZGVjb2RlciAmJiAhYWRkVG9Gcm9udCAmJiAhZW5jb2RpbmcpXG4gICAgICAgIGNodW5rID0gc3RhdGUuZGVjb2Rlci53cml0ZShjaHVuayk7XG5cbiAgICAgIGlmICghYWRkVG9Gcm9udClcbiAgICAgICAgc3RhdGUucmVhZGluZyA9IGZhbHNlO1xuXG4gICAgICAvLyBpZiB3ZSB3YW50IHRoZSBkYXRhIG5vdywganVzdCBlbWl0IGl0LlxuICAgICAgaWYgKHN0YXRlLmZsb3dpbmcgJiYgc3RhdGUubGVuZ3RoID09PSAwICYmICFzdGF0ZS5zeW5jKSB7XG4gICAgICAgIHN0cmVhbS5lbWl0KCdkYXRhJywgY2h1bmspO1xuICAgICAgICBzdHJlYW0ucmVhZCgwKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIHVwZGF0ZSB0aGUgYnVmZmVyIGluZm8uXG4gICAgICAgIHN0YXRlLmxlbmd0aCArPSBzdGF0ZS5vYmplY3RNb2RlID8gMSA6IGNodW5rLmxlbmd0aDtcbiAgICAgICAgaWYgKGFkZFRvRnJvbnQpXG4gICAgICAgICAgc3RhdGUuYnVmZmVyLnVuc2hpZnQoY2h1bmspO1xuICAgICAgICBlbHNlXG4gICAgICAgICAgc3RhdGUuYnVmZmVyLnB1c2goY2h1bmspO1xuXG4gICAgICAgIGlmIChzdGF0ZS5uZWVkUmVhZGFibGUpXG4gICAgICAgICAgZW1pdFJlYWRhYmxlKHN0cmVhbSk7XG4gICAgICB9XG5cbiAgICAgIG1heWJlUmVhZE1vcmUoc3RyZWFtLCBzdGF0ZSk7XG4gICAgfVxuICB9IGVsc2UgaWYgKCFhZGRUb0Zyb250KSB7XG4gICAgc3RhdGUucmVhZGluZyA9IGZhbHNlO1xuICB9XG5cbiAgcmV0dXJuIG5lZWRNb3JlRGF0YShzdGF0ZSk7XG59XG5cblxuLy8gaWYgaXQncyBwYXN0IHRoZSBoaWdoIHdhdGVyIG1hcmssIHdlIGNhbiBwdXNoIGluIHNvbWUgbW9yZS5cbi8vIEFsc28sIGlmIHdlIGhhdmUgbm8gZGF0YSB5ZXQsIHdlIGNhbiBzdGFuZCBzb21lXG4vLyBtb3JlIGJ5dGVzLiAgVGhpcyBpcyB0byB3b3JrIGFyb3VuZCBjYXNlcyB3aGVyZSBod209MCxcbi8vIHN1Y2ggYXMgdGhlIHJlcGwuICBBbHNvLCBpZiB0aGUgcHVzaCgpIHRyaWdnZXJlZCBhXG4vLyByZWFkYWJsZSBldmVudCwgYW5kIHRoZSB1c2VyIGNhbGxlZCByZWFkKGxhcmdlTnVtYmVyKSBzdWNoIHRoYXRcbi8vIG5lZWRSZWFkYWJsZSB3YXMgc2V0LCB0aGVuIHdlIG91Z2h0IHRvIHB1c2ggbW9yZSwgc28gdGhhdCBhbm90aGVyXG4vLyAncmVhZGFibGUnIGV2ZW50IHdpbGwgYmUgdHJpZ2dlcmVkLlxuZnVuY3Rpb24gbmVlZE1vcmVEYXRhKHN0YXRlKSB7XG4gIHJldHVybiAhc3RhdGUuZW5kZWQgJiZcbiAgICAgICAgIChzdGF0ZS5uZWVkUmVhZGFibGUgfHxcbiAgICAgICAgICBzdGF0ZS5sZW5ndGggPCBzdGF0ZS5oaWdoV2F0ZXJNYXJrIHx8XG4gICAgICAgICAgc3RhdGUubGVuZ3RoID09PSAwKTtcbn1cblxuLy8gYmFja3dhcmRzIGNvbXBhdGliaWxpdHkuXG5SZWFkYWJsZS5wcm90b3R5cGUuc2V0RW5jb2RpbmcgPSBmdW5jdGlvbihlbmMpIHtcbiAgaWYgKCFTdHJpbmdEZWNvZGVyKVxuICAgIFN0cmluZ0RlY29kZXIgPSByZXF1aXJlKCdzdHJpbmdfZGVjb2Rlci8nKS5TdHJpbmdEZWNvZGVyO1xuICB0aGlzLl9yZWFkYWJsZVN0YXRlLmRlY29kZXIgPSBuZXcgU3RyaW5nRGVjb2RlcihlbmMpO1xuICB0aGlzLl9yZWFkYWJsZVN0YXRlLmVuY29kaW5nID0gZW5jO1xuICByZXR1cm4gdGhpcztcbn07XG5cbi8vIERvbid0IHJhaXNlIHRoZSBod20gPiA4TUJcbnZhciBNQVhfSFdNID0gMHg4MDAwMDA7XG5mdW5jdGlvbiBjb21wdXRlTmV3SGlnaFdhdGVyTWFyayhuKSB7XG4gIGlmIChuID49IE1BWF9IV00pIHtcbiAgICBuID0gTUFYX0hXTTtcbiAgfSBlbHNlIHtcbiAgICAvLyBHZXQgdGhlIG5leHQgaGlnaGVzdCBwb3dlciBvZiAyXG4gICAgbi0tO1xuICAgIG4gfD0gbiA+Pj4gMTtcbiAgICBuIHw9IG4gPj4+IDI7XG4gICAgbiB8PSBuID4+PiA0O1xuICAgIG4gfD0gbiA+Pj4gODtcbiAgICBuIHw9IG4gPj4+IDE2O1xuICAgIG4rKztcbiAgfVxuICByZXR1cm4gbjtcbn1cblxuZnVuY3Rpb24gaG93TXVjaFRvUmVhZChuLCBzdGF0ZSkge1xuICBpZiAoc3RhdGUubGVuZ3RoID09PSAwICYmIHN0YXRlLmVuZGVkKVxuICAgIHJldHVybiAwO1xuXG4gIGlmIChzdGF0ZS5vYmplY3RNb2RlKVxuICAgIHJldHVybiBuID09PSAwID8gMCA6IDE7XG5cbiAgaWYgKG4gPT09IG51bGwgfHwgaXNOYU4obikpIHtcbiAgICAvLyBvbmx5IGZsb3cgb25lIGJ1ZmZlciBhdCBhIHRpbWVcbiAgICBpZiAoc3RhdGUuZmxvd2luZyAmJiBzdGF0ZS5idWZmZXIubGVuZ3RoKVxuICAgICAgcmV0dXJuIHN0YXRlLmJ1ZmZlclswXS5sZW5ndGg7XG4gICAgZWxzZVxuICAgICAgcmV0dXJuIHN0YXRlLmxlbmd0aDtcbiAgfVxuXG4gIGlmIChuIDw9IDApXG4gICAgcmV0dXJuIDA7XG5cbiAgLy8gSWYgd2UncmUgYXNraW5nIGZvciBtb3JlIHRoYW4gdGhlIHRhcmdldCBidWZmZXIgbGV2ZWwsXG4gIC8vIHRoZW4gcmFpc2UgdGhlIHdhdGVyIG1hcmsuICBCdW1wIHVwIHRvIHRoZSBuZXh0IGhpZ2hlc3RcbiAgLy8gcG93ZXIgb2YgMiwgdG8gcHJldmVudCBpbmNyZWFzaW5nIGl0IGV4Y2Vzc2l2ZWx5IGluIHRpbnlcbiAgLy8gYW1vdW50cy5cbiAgaWYgKG4gPiBzdGF0ZS5oaWdoV2F0ZXJNYXJrKVxuICAgIHN0YXRlLmhpZ2hXYXRlck1hcmsgPSBjb21wdXRlTmV3SGlnaFdhdGVyTWFyayhuKTtcblxuICAvLyBkb24ndCBoYXZlIHRoYXQgbXVjaC4gIHJldHVybiBudWxsLCB1bmxlc3Mgd2UndmUgZW5kZWQuXG4gIGlmIChuID4gc3RhdGUubGVuZ3RoKSB7XG4gICAgaWYgKCFzdGF0ZS5lbmRlZCkge1xuICAgICAgc3RhdGUubmVlZFJlYWRhYmxlID0gdHJ1ZTtcbiAgICAgIHJldHVybiAwO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gc3RhdGUubGVuZ3RoO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBuO1xufVxuXG4vLyB5b3UgY2FuIG92ZXJyaWRlIGVpdGhlciB0aGlzIG1ldGhvZCwgb3IgdGhlIGFzeW5jIF9yZWFkKG4pIGJlbG93LlxuUmVhZGFibGUucHJvdG90eXBlLnJlYWQgPSBmdW5jdGlvbihuKSB7XG4gIGRlYnVnKCdyZWFkJywgbik7XG4gIHZhciBzdGF0ZSA9IHRoaXMuX3JlYWRhYmxlU3RhdGU7XG4gIHZhciBuT3JpZyA9IG47XG5cbiAgaWYgKHR5cGVvZiBuICE9PSAnbnVtYmVyJyB8fCBuID4gMClcbiAgICBzdGF0ZS5lbWl0dGVkUmVhZGFibGUgPSBmYWxzZTtcblxuICAvLyBpZiB3ZSdyZSBkb2luZyByZWFkKDApIHRvIHRyaWdnZXIgYSByZWFkYWJsZSBldmVudCwgYnV0IHdlXG4gIC8vIGFscmVhZHkgaGF2ZSBhIGJ1bmNoIG9mIGRhdGEgaW4gdGhlIGJ1ZmZlciwgdGhlbiBqdXN0IHRyaWdnZXJcbiAgLy8gdGhlICdyZWFkYWJsZScgZXZlbnQgYW5kIG1vdmUgb24uXG4gIGlmIChuID09PSAwICYmXG4gICAgICBzdGF0ZS5uZWVkUmVhZGFibGUgJiZcbiAgICAgIChzdGF0ZS5sZW5ndGggPj0gc3RhdGUuaGlnaFdhdGVyTWFyayB8fCBzdGF0ZS5lbmRlZCkpIHtcbiAgICBkZWJ1ZygncmVhZDogZW1pdFJlYWRhYmxlJywgc3RhdGUubGVuZ3RoLCBzdGF0ZS5lbmRlZCk7XG4gICAgaWYgKHN0YXRlLmxlbmd0aCA9PT0gMCAmJiBzdGF0ZS5lbmRlZClcbiAgICAgIGVuZFJlYWRhYmxlKHRoaXMpO1xuICAgIGVsc2VcbiAgICAgIGVtaXRSZWFkYWJsZSh0aGlzKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIG4gPSBob3dNdWNoVG9SZWFkKG4sIHN0YXRlKTtcblxuICAvLyBpZiB3ZSd2ZSBlbmRlZCwgYW5kIHdlJ3JlIG5vdyBjbGVhciwgdGhlbiBmaW5pc2ggaXQgdXAuXG4gIGlmIChuID09PSAwICYmIHN0YXRlLmVuZGVkKSB7XG4gICAgaWYgKHN0YXRlLmxlbmd0aCA9PT0gMClcbiAgICAgIGVuZFJlYWRhYmxlKHRoaXMpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgLy8gQWxsIHRoZSBhY3R1YWwgY2h1bmsgZ2VuZXJhdGlvbiBsb2dpYyBuZWVkcyB0byBiZVxuICAvLyAqYmVsb3cqIHRoZSBjYWxsIHRvIF9yZWFkLiAgVGhlIHJlYXNvbiBpcyB0aGF0IGluIGNlcnRhaW5cbiAgLy8gc3ludGhldGljIHN0cmVhbSBjYXNlcywgc3VjaCBhcyBwYXNzdGhyb3VnaCBzdHJlYW1zLCBfcmVhZFxuICAvLyBtYXkgYmUgYSBjb21wbGV0ZWx5IHN5bmNocm9ub3VzIG9wZXJhdGlvbiB3aGljaCBtYXkgY2hhbmdlXG4gIC8vIHRoZSBzdGF0ZSBvZiB0aGUgcmVhZCBidWZmZXIsIHByb3ZpZGluZyBlbm91Z2ggZGF0YSB3aGVuXG4gIC8vIGJlZm9yZSB0aGVyZSB3YXMgKm5vdCogZW5vdWdoLlxuICAvL1xuICAvLyBTbywgdGhlIHN0ZXBzIGFyZTpcbiAgLy8gMS4gRmlndXJlIG91dCB3aGF0IHRoZSBzdGF0ZSBvZiB0aGluZ3Mgd2lsbCBiZSBhZnRlciB3ZSBkb1xuICAvLyBhIHJlYWQgZnJvbSB0aGUgYnVmZmVyLlxuICAvL1xuICAvLyAyLiBJZiB0aGF0IHJlc3VsdGluZyBzdGF0ZSB3aWxsIHRyaWdnZXIgYSBfcmVhZCwgdGhlbiBjYWxsIF9yZWFkLlxuICAvLyBOb3RlIHRoYXQgdGhpcyBtYXkgYmUgYXN5bmNocm9ub3VzLCBvciBzeW5jaHJvbm91cy4gIFllcywgaXQgaXNcbiAgLy8gZGVlcGx5IHVnbHkgdG8gd3JpdGUgQVBJcyB0aGlzIHdheSwgYnV0IHRoYXQgc3RpbGwgZG9lc24ndCBtZWFuXG4gIC8vIHRoYXQgdGhlIFJlYWRhYmxlIGNsYXNzIHNob3VsZCBiZWhhdmUgaW1wcm9wZXJseSwgYXMgc3RyZWFtcyBhcmVcbiAgLy8gZGVzaWduZWQgdG8gYmUgc3luYy9hc3luYyBhZ25vc3RpYy5cbiAgLy8gVGFrZSBub3RlIGlmIHRoZSBfcmVhZCBjYWxsIGlzIHN5bmMgb3IgYXN5bmMgKGllLCBpZiB0aGUgcmVhZCBjYWxsXG4gIC8vIGhhcyByZXR1cm5lZCB5ZXQpLCBzbyB0aGF0IHdlIGtub3cgd2hldGhlciBvciBub3QgaXQncyBzYWZlIHRvIGVtaXRcbiAgLy8gJ3JlYWRhYmxlJyBldGMuXG4gIC8vXG4gIC8vIDMuIEFjdHVhbGx5IHB1bGwgdGhlIHJlcXVlc3RlZCBjaHVua3Mgb3V0IG9mIHRoZSBidWZmZXIgYW5kIHJldHVybi5cblxuICAvLyBpZiB3ZSBuZWVkIGEgcmVhZGFibGUgZXZlbnQsIHRoZW4gd2UgbmVlZCB0byBkbyBzb21lIHJlYWRpbmcuXG4gIHZhciBkb1JlYWQgPSBzdGF0ZS5uZWVkUmVhZGFibGU7XG4gIGRlYnVnKCduZWVkIHJlYWRhYmxlJywgZG9SZWFkKTtcblxuICAvLyBpZiB3ZSBjdXJyZW50bHkgaGF2ZSBsZXNzIHRoYW4gdGhlIGhpZ2hXYXRlck1hcmssIHRoZW4gYWxzbyByZWFkIHNvbWVcbiAgaWYgKHN0YXRlLmxlbmd0aCA9PT0gMCB8fCBzdGF0ZS5sZW5ndGggLSBuIDwgc3RhdGUuaGlnaFdhdGVyTWFyaykge1xuICAgIGRvUmVhZCA9IHRydWU7XG4gICAgZGVidWcoJ2xlbmd0aCBsZXNzIHRoYW4gd2F0ZXJtYXJrJywgZG9SZWFkKTtcbiAgfVxuXG4gIC8vIGhvd2V2ZXIsIGlmIHdlJ3ZlIGVuZGVkLCB0aGVuIHRoZXJlJ3Mgbm8gcG9pbnQsIGFuZCBpZiB3ZSdyZSBhbHJlYWR5XG4gIC8vIHJlYWRpbmcsIHRoZW4gaXQncyB1bm5lY2Vzc2FyeS5cbiAgaWYgKHN0YXRlLmVuZGVkIHx8IHN0YXRlLnJlYWRpbmcpIHtcbiAgICBkb1JlYWQgPSBmYWxzZTtcbiAgICBkZWJ1ZygncmVhZGluZyBvciBlbmRlZCcsIGRvUmVhZCk7XG4gIH1cblxuICBpZiAoZG9SZWFkKSB7XG4gICAgZGVidWcoJ2RvIHJlYWQnKTtcbiAgICBzdGF0ZS5yZWFkaW5nID0gdHJ1ZTtcbiAgICBzdGF0ZS5zeW5jID0gdHJ1ZTtcbiAgICAvLyBpZiB0aGUgbGVuZ3RoIGlzIGN1cnJlbnRseSB6ZXJvLCB0aGVuIHdlICpuZWVkKiBhIHJlYWRhYmxlIGV2ZW50LlxuICAgIGlmIChzdGF0ZS5sZW5ndGggPT09IDApXG4gICAgICBzdGF0ZS5uZWVkUmVhZGFibGUgPSB0cnVlO1xuICAgIC8vIGNhbGwgaW50ZXJuYWwgcmVhZCBtZXRob2RcbiAgICB0aGlzLl9yZWFkKHN0YXRlLmhpZ2hXYXRlck1hcmspO1xuICAgIHN0YXRlLnN5bmMgPSBmYWxzZTtcbiAgfVxuXG4gIC8vIElmIF9yZWFkIHB1c2hlZCBkYXRhIHN5bmNocm9ub3VzbHksIHRoZW4gYHJlYWRpbmdgIHdpbGwgYmUgZmFsc2UsXG4gIC8vIGFuZCB3ZSBuZWVkIHRvIHJlLWV2YWx1YXRlIGhvdyBtdWNoIGRhdGEgd2UgY2FuIHJldHVybiB0byB0aGUgdXNlci5cbiAgaWYgKGRvUmVhZCAmJiAhc3RhdGUucmVhZGluZylcbiAgICBuID0gaG93TXVjaFRvUmVhZChuT3JpZywgc3RhdGUpO1xuXG4gIHZhciByZXQ7XG4gIGlmIChuID4gMClcbiAgICByZXQgPSBmcm9tTGlzdChuLCBzdGF0ZSk7XG4gIGVsc2VcbiAgICByZXQgPSBudWxsO1xuXG4gIGlmIChyZXQgPT09IG51bGwpIHtcbiAgICBzdGF0ZS5uZWVkUmVhZGFibGUgPSB0cnVlO1xuICAgIG4gPSAwO1xuICB9XG5cbiAgc3RhdGUubGVuZ3RoIC09IG47XG5cbiAgLy8gSWYgd2UgaGF2ZSBub3RoaW5nIGluIHRoZSBidWZmZXIsIHRoZW4gd2Ugd2FudCB0byBrbm93XG4gIC8vIGFzIHNvb24gYXMgd2UgKmRvKiBnZXQgc29tZXRoaW5nIGludG8gdGhlIGJ1ZmZlci5cbiAgaWYgKHN0YXRlLmxlbmd0aCA9PT0gMCAmJiAhc3RhdGUuZW5kZWQpXG4gICAgc3RhdGUubmVlZFJlYWRhYmxlID0gdHJ1ZTtcblxuICAvLyBJZiB3ZSB0cmllZCB0byByZWFkKCkgcGFzdCB0aGUgRU9GLCB0aGVuIGVtaXQgZW5kIG9uIHRoZSBuZXh0IHRpY2suXG4gIGlmIChuT3JpZyAhPT0gbiAmJiBzdGF0ZS5lbmRlZCAmJiBzdGF0ZS5sZW5ndGggPT09IDApXG4gICAgZW5kUmVhZGFibGUodGhpcyk7XG5cbiAgaWYgKHJldCAhPT0gbnVsbClcbiAgICB0aGlzLmVtaXQoJ2RhdGEnLCByZXQpO1xuXG4gIHJldHVybiByZXQ7XG59O1xuXG5mdW5jdGlvbiBjaHVua0ludmFsaWQoc3RhdGUsIGNodW5rKSB7XG4gIHZhciBlciA9IG51bGw7XG4gIGlmICghKEJ1ZmZlci5pc0J1ZmZlcihjaHVuaykpICYmXG4gICAgICB0eXBlb2YgY2h1bmsgIT09ICdzdHJpbmcnICYmXG4gICAgICBjaHVuayAhPT0gbnVsbCAmJlxuICAgICAgY2h1bmsgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgIXN0YXRlLm9iamVjdE1vZGUpIHtcbiAgICBlciA9IG5ldyBUeXBlRXJyb3IoJ0ludmFsaWQgbm9uLXN0cmluZy9idWZmZXIgY2h1bmsnKTtcbiAgfVxuICByZXR1cm4gZXI7XG59XG5cblxuZnVuY3Rpb24gb25Fb2ZDaHVuayhzdHJlYW0sIHN0YXRlKSB7XG4gIGlmIChzdGF0ZS5lbmRlZCkgcmV0dXJuO1xuICBpZiAoc3RhdGUuZGVjb2Rlcikge1xuICAgIHZhciBjaHVuayA9IHN0YXRlLmRlY29kZXIuZW5kKCk7XG4gICAgaWYgKGNodW5rICYmIGNodW5rLmxlbmd0aCkge1xuICAgICAgc3RhdGUuYnVmZmVyLnB1c2goY2h1bmspO1xuICAgICAgc3RhdGUubGVuZ3RoICs9IHN0YXRlLm9iamVjdE1vZGUgPyAxIDogY2h1bmsubGVuZ3RoO1xuICAgIH1cbiAgfVxuICBzdGF0ZS5lbmRlZCA9IHRydWU7XG5cbiAgLy8gZW1pdCAncmVhZGFibGUnIG5vdyB0byBtYWtlIHN1cmUgaXQgZ2V0cyBwaWNrZWQgdXAuXG4gIGVtaXRSZWFkYWJsZShzdHJlYW0pO1xufVxuXG4vLyBEb24ndCBlbWl0IHJlYWRhYmxlIHJpZ2h0IGF3YXkgaW4gc3luYyBtb2RlLCBiZWNhdXNlIHRoaXMgY2FuIHRyaWdnZXJcbi8vIGFub3RoZXIgcmVhZCgpIGNhbGwgPT4gc3RhY2sgb3ZlcmZsb3cuICBUaGlzIHdheSwgaXQgbWlnaHQgdHJpZ2dlclxuLy8gYSBuZXh0VGljayByZWN1cnNpb24gd2FybmluZywgYnV0IHRoYXQncyBub3Qgc28gYmFkLlxuZnVuY3Rpb24gZW1pdFJlYWRhYmxlKHN0cmVhbSkge1xuICB2YXIgc3RhdGUgPSBzdHJlYW0uX3JlYWRhYmxlU3RhdGU7XG4gIHN0YXRlLm5lZWRSZWFkYWJsZSA9IGZhbHNlO1xuICBpZiAoIXN0YXRlLmVtaXR0ZWRSZWFkYWJsZSkge1xuICAgIGRlYnVnKCdlbWl0UmVhZGFibGUnLCBzdGF0ZS5mbG93aW5nKTtcbiAgICBzdGF0ZS5lbWl0dGVkUmVhZGFibGUgPSB0cnVlO1xuICAgIGlmIChzdGF0ZS5zeW5jKVxuICAgICAgcHJvY2Vzc05leHRUaWNrKGVtaXRSZWFkYWJsZV8sIHN0cmVhbSk7XG4gICAgZWxzZVxuICAgICAgZW1pdFJlYWRhYmxlXyhzdHJlYW0pO1xuICB9XG59XG5cbmZ1bmN0aW9uIGVtaXRSZWFkYWJsZV8oc3RyZWFtKSB7XG4gIGRlYnVnKCdlbWl0IHJlYWRhYmxlJyk7XG4gIHN0cmVhbS5lbWl0KCdyZWFkYWJsZScpO1xuICBmbG93KHN0cmVhbSk7XG59XG5cblxuLy8gYXQgdGhpcyBwb2ludCwgdGhlIHVzZXIgaGFzIHByZXN1bWFibHkgc2VlbiB0aGUgJ3JlYWRhYmxlJyBldmVudCxcbi8vIGFuZCBjYWxsZWQgcmVhZCgpIHRvIGNvbnN1bWUgc29tZSBkYXRhLiAgdGhhdCBtYXkgaGF2ZSB0cmlnZ2VyZWRcbi8vIGluIHR1cm4gYW5vdGhlciBfcmVhZChuKSBjYWxsLCBpbiB3aGljaCBjYXNlIHJlYWRpbmcgPSB0cnVlIGlmXG4vLyBpdCdzIGluIHByb2dyZXNzLlxuLy8gSG93ZXZlciwgaWYgd2UncmUgbm90IGVuZGVkLCBvciByZWFkaW5nLCBhbmQgdGhlIGxlbmd0aCA8IGh3bSxcbi8vIHRoZW4gZ28gYWhlYWQgYW5kIHRyeSB0byByZWFkIHNvbWUgbW9yZSBwcmVlbXB0aXZlbHkuXG5mdW5jdGlvbiBtYXliZVJlYWRNb3JlKHN0cmVhbSwgc3RhdGUpIHtcbiAgaWYgKCFzdGF0ZS5yZWFkaW5nTW9yZSkge1xuICAgIHN0YXRlLnJlYWRpbmdNb3JlID0gdHJ1ZTtcbiAgICBwcm9jZXNzTmV4dFRpY2sobWF5YmVSZWFkTW9yZV8sIHN0cmVhbSwgc3RhdGUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIG1heWJlUmVhZE1vcmVfKHN0cmVhbSwgc3RhdGUpIHtcbiAgdmFyIGxlbiA9IHN0YXRlLmxlbmd0aDtcbiAgd2hpbGUgKCFzdGF0ZS5yZWFkaW5nICYmICFzdGF0ZS5mbG93aW5nICYmICFzdGF0ZS5lbmRlZCAmJlxuICAgICAgICAgc3RhdGUubGVuZ3RoIDwgc3RhdGUuaGlnaFdhdGVyTWFyaykge1xuICAgIGRlYnVnKCdtYXliZVJlYWRNb3JlIHJlYWQgMCcpO1xuICAgIHN0cmVhbS5yZWFkKDApO1xuICAgIGlmIChsZW4gPT09IHN0YXRlLmxlbmd0aClcbiAgICAgIC8vIGRpZG4ndCBnZXQgYW55IGRhdGEsIHN0b3Agc3Bpbm5pbmcuXG4gICAgICBicmVhaztcbiAgICBlbHNlXG4gICAgICBsZW4gPSBzdGF0ZS5sZW5ndGg7XG4gIH1cbiAgc3RhdGUucmVhZGluZ01vcmUgPSBmYWxzZTtcbn1cblxuLy8gYWJzdHJhY3QgbWV0aG9kLiAgdG8gYmUgb3ZlcnJpZGRlbiBpbiBzcGVjaWZpYyBpbXBsZW1lbnRhdGlvbiBjbGFzc2VzLlxuLy8gY2FsbCBjYihlciwgZGF0YSkgd2hlcmUgZGF0YSBpcyA8PSBuIGluIGxlbmd0aC5cbi8vIGZvciB2aXJ0dWFsIChub24tc3RyaW5nLCBub24tYnVmZmVyKSBzdHJlYW1zLCBcImxlbmd0aFwiIGlzIHNvbWV3aGF0XG4vLyBhcmJpdHJhcnksIGFuZCBwZXJoYXBzIG5vdCB2ZXJ5IG1lYW5pbmdmdWwuXG5SZWFkYWJsZS5wcm90b3R5cGUuX3JlYWQgPSBmdW5jdGlvbihuKSB7XG4gIHRoaXMuZW1pdCgnZXJyb3InLCBuZXcgRXJyb3IoJ25vdCBpbXBsZW1lbnRlZCcpKTtcbn07XG5cblJlYWRhYmxlLnByb3RvdHlwZS5waXBlID0gZnVuY3Rpb24oZGVzdCwgcGlwZU9wdHMpIHtcbiAgdmFyIHNyYyA9IHRoaXM7XG4gIHZhciBzdGF0ZSA9IHRoaXMuX3JlYWRhYmxlU3RhdGU7XG5cbiAgc3dpdGNoIChzdGF0ZS5waXBlc0NvdW50KSB7XG4gICAgY2FzZSAwOlxuICAgICAgc3RhdGUucGlwZXMgPSBkZXN0O1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAxOlxuICAgICAgc3RhdGUucGlwZXMgPSBbc3RhdGUucGlwZXMsIGRlc3RdO1xuICAgICAgYnJlYWs7XG4gICAgZGVmYXVsdDpcbiAgICAgIHN0YXRlLnBpcGVzLnB1c2goZGVzdCk7XG4gICAgICBicmVhaztcbiAgfVxuICBzdGF0ZS5waXBlc0NvdW50ICs9IDE7XG4gIGRlYnVnKCdwaXBlIGNvdW50PSVkIG9wdHM9JWonLCBzdGF0ZS5waXBlc0NvdW50LCBwaXBlT3B0cyk7XG5cbiAgdmFyIGRvRW5kID0gKCFwaXBlT3B0cyB8fCBwaXBlT3B0cy5lbmQgIT09IGZhbHNlKSAmJlxuICAgICAgICAgICAgICBkZXN0ICE9PSBwcm9jZXNzLnN0ZG91dCAmJlxuICAgICAgICAgICAgICBkZXN0ICE9PSBwcm9jZXNzLnN0ZGVycjtcblxuICB2YXIgZW5kRm4gPSBkb0VuZCA/IG9uZW5kIDogY2xlYW51cDtcbiAgaWYgKHN0YXRlLmVuZEVtaXR0ZWQpXG4gICAgcHJvY2Vzc05leHRUaWNrKGVuZEZuKTtcbiAgZWxzZVxuICAgIHNyYy5vbmNlKCdlbmQnLCBlbmRGbik7XG5cbiAgZGVzdC5vbigndW5waXBlJywgb251bnBpcGUpO1xuICBmdW5jdGlvbiBvbnVucGlwZShyZWFkYWJsZSkge1xuICAgIGRlYnVnKCdvbnVucGlwZScpO1xuICAgIGlmIChyZWFkYWJsZSA9PT0gc3JjKSB7XG4gICAgICBjbGVhbnVwKCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gb25lbmQoKSB7XG4gICAgZGVidWcoJ29uZW5kJyk7XG4gICAgZGVzdC5lbmQoKTtcbiAgfVxuXG4gIC8vIHdoZW4gdGhlIGRlc3QgZHJhaW5zLCBpdCByZWR1Y2VzIHRoZSBhd2FpdERyYWluIGNvdW50ZXJcbiAgLy8gb24gdGhlIHNvdXJjZS4gIFRoaXMgd291bGQgYmUgbW9yZSBlbGVnYW50IHdpdGggYSAub25jZSgpXG4gIC8vIGhhbmRsZXIgaW4gZmxvdygpLCBidXQgYWRkaW5nIGFuZCByZW1vdmluZyByZXBlYXRlZGx5IGlzXG4gIC8vIHRvbyBzbG93LlxuICB2YXIgb25kcmFpbiA9IHBpcGVPbkRyYWluKHNyYyk7XG4gIGRlc3Qub24oJ2RyYWluJywgb25kcmFpbik7XG5cbiAgdmFyIGNsZWFuZWRVcCA9IGZhbHNlO1xuICBmdW5jdGlvbiBjbGVhbnVwKCkge1xuICAgIGRlYnVnKCdjbGVhbnVwJyk7XG4gICAgLy8gY2xlYW51cCBldmVudCBoYW5kbGVycyBvbmNlIHRoZSBwaXBlIGlzIGJyb2tlblxuICAgIGRlc3QucmVtb3ZlTGlzdGVuZXIoJ2Nsb3NlJywgb25jbG9zZSk7XG4gICAgZGVzdC5yZW1vdmVMaXN0ZW5lcignZmluaXNoJywgb25maW5pc2gpO1xuICAgIGRlc3QucmVtb3ZlTGlzdGVuZXIoJ2RyYWluJywgb25kcmFpbik7XG4gICAgZGVzdC5yZW1vdmVMaXN0ZW5lcignZXJyb3InLCBvbmVycm9yKTtcbiAgICBkZXN0LnJlbW92ZUxpc3RlbmVyKCd1bnBpcGUnLCBvbnVucGlwZSk7XG4gICAgc3JjLnJlbW92ZUxpc3RlbmVyKCdlbmQnLCBvbmVuZCk7XG4gICAgc3JjLnJlbW92ZUxpc3RlbmVyKCdlbmQnLCBjbGVhbnVwKTtcbiAgICBzcmMucmVtb3ZlTGlzdGVuZXIoJ2RhdGEnLCBvbmRhdGEpO1xuXG4gICAgY2xlYW5lZFVwID0gdHJ1ZTtcblxuICAgIC8vIGlmIHRoZSByZWFkZXIgaXMgd2FpdGluZyBmb3IgYSBkcmFpbiBldmVudCBmcm9tIHRoaXNcbiAgICAvLyBzcGVjaWZpYyB3cml0ZXIsIHRoZW4gaXQgd291bGQgY2F1c2UgaXQgdG8gbmV2ZXIgc3RhcnRcbiAgICAvLyBmbG93aW5nIGFnYWluLlxuICAgIC8vIFNvLCBpZiB0aGlzIGlzIGF3YWl0aW5nIGEgZHJhaW4sIHRoZW4gd2UganVzdCBjYWxsIGl0IG5vdy5cbiAgICAvLyBJZiB3ZSBkb24ndCBrbm93LCB0aGVuIGFzc3VtZSB0aGF0IHdlIGFyZSB3YWl0aW5nIGZvciBvbmUuXG4gICAgaWYgKHN0YXRlLmF3YWl0RHJhaW4gJiZcbiAgICAgICAgKCFkZXN0Ll93cml0YWJsZVN0YXRlIHx8IGRlc3QuX3dyaXRhYmxlU3RhdGUubmVlZERyYWluKSlcbiAgICAgIG9uZHJhaW4oKTtcbiAgfVxuXG4gIHNyYy5vbignZGF0YScsIG9uZGF0YSk7XG4gIGZ1bmN0aW9uIG9uZGF0YShjaHVuaykge1xuICAgIGRlYnVnKCdvbmRhdGEnKTtcbiAgICB2YXIgcmV0ID0gZGVzdC53cml0ZShjaHVuayk7XG4gICAgaWYgKGZhbHNlID09PSByZXQpIHtcbiAgICAgIC8vIElmIHRoZSB1c2VyIHVucGlwZWQgZHVyaW5nIGBkZXN0LndyaXRlKClgLCBpdCBpcyBwb3NzaWJsZVxuICAgICAgLy8gdG8gZ2V0IHN0dWNrIGluIGEgcGVybWFuZW50bHkgcGF1c2VkIHN0YXRlIGlmIHRoYXQgd3JpdGVcbiAgICAgIC8vIGFsc28gcmV0dXJuZWQgZmFsc2UuXG4gICAgICBpZiAoc3RhdGUucGlwZXNDb3VudCA9PT0gMSAmJlxuICAgICAgICAgIHN0YXRlLnBpcGVzWzBdID09PSBkZXN0ICYmXG4gICAgICAgICAgc3JjLmxpc3RlbmVyQ291bnQoJ2RhdGEnKSA9PT0gMSAmJlxuICAgICAgICAgICFjbGVhbmVkVXApIHtcbiAgICAgICAgZGVidWcoJ2ZhbHNlIHdyaXRlIHJlc3BvbnNlLCBwYXVzZScsIHNyYy5fcmVhZGFibGVTdGF0ZS5hd2FpdERyYWluKTtcbiAgICAgICAgc3JjLl9yZWFkYWJsZVN0YXRlLmF3YWl0RHJhaW4rKztcbiAgICAgIH1cbiAgICAgIHNyYy5wYXVzZSgpO1xuICAgIH1cbiAgfVxuXG4gIC8vIGlmIHRoZSBkZXN0IGhhcyBhbiBlcnJvciwgdGhlbiBzdG9wIHBpcGluZyBpbnRvIGl0LlxuICAvLyBob3dldmVyLCBkb24ndCBzdXBwcmVzcyB0aGUgdGhyb3dpbmcgYmVoYXZpb3IgZm9yIHRoaXMuXG4gIGZ1bmN0aW9uIG9uZXJyb3IoZXIpIHtcbiAgICBkZWJ1Zygnb25lcnJvcicsIGVyKTtcbiAgICB1bnBpcGUoKTtcbiAgICBkZXN0LnJlbW92ZUxpc3RlbmVyKCdlcnJvcicsIG9uZXJyb3IpO1xuICAgIGlmIChFRWxpc3RlbmVyQ291bnQoZGVzdCwgJ2Vycm9yJykgPT09IDApXG4gICAgICBkZXN0LmVtaXQoJ2Vycm9yJywgZXIpO1xuICB9XG4gIC8vIFRoaXMgaXMgYSBicnV0YWxseSB1Z2x5IGhhY2sgdG8gbWFrZSBzdXJlIHRoYXQgb3VyIGVycm9yIGhhbmRsZXJcbiAgLy8gaXMgYXR0YWNoZWQgYmVmb3JlIGFueSB1c2VybGFuZCBvbmVzLiAgTkVWRVIgRE8gVEhJUy5cbiAgaWYgKCFkZXN0Ll9ldmVudHMgfHwgIWRlc3QuX2V2ZW50cy5lcnJvcilcbiAgICBkZXN0Lm9uKCdlcnJvcicsIG9uZXJyb3IpO1xuICBlbHNlIGlmIChpc0FycmF5KGRlc3QuX2V2ZW50cy5lcnJvcikpXG4gICAgZGVzdC5fZXZlbnRzLmVycm9yLnVuc2hpZnQob25lcnJvcik7XG4gIGVsc2VcbiAgICBkZXN0Ll9ldmVudHMuZXJyb3IgPSBbb25lcnJvciwgZGVzdC5fZXZlbnRzLmVycm9yXTtcblxuXG4gIC8vIEJvdGggY2xvc2UgYW5kIGZpbmlzaCBzaG91bGQgdHJpZ2dlciB1bnBpcGUsIGJ1dCBvbmx5IG9uY2UuXG4gIGZ1bmN0aW9uIG9uY2xvc2UoKSB7XG4gICAgZGVzdC5yZW1vdmVMaXN0ZW5lcignZmluaXNoJywgb25maW5pc2gpO1xuICAgIHVucGlwZSgpO1xuICB9XG4gIGRlc3Qub25jZSgnY2xvc2UnLCBvbmNsb3NlKTtcbiAgZnVuY3Rpb24gb25maW5pc2goKSB7XG4gICAgZGVidWcoJ29uZmluaXNoJyk7XG4gICAgZGVzdC5yZW1vdmVMaXN0ZW5lcignY2xvc2UnLCBvbmNsb3NlKTtcbiAgICB1bnBpcGUoKTtcbiAgfVxuICBkZXN0Lm9uY2UoJ2ZpbmlzaCcsIG9uZmluaXNoKTtcblxuICBmdW5jdGlvbiB1bnBpcGUoKSB7XG4gICAgZGVidWcoJ3VucGlwZScpO1xuICAgIHNyYy51bnBpcGUoZGVzdCk7XG4gIH1cblxuICAvLyB0ZWxsIHRoZSBkZXN0IHRoYXQgaXQncyBiZWluZyBwaXBlZCB0b1xuICBkZXN0LmVtaXQoJ3BpcGUnLCBzcmMpO1xuXG4gIC8vIHN0YXJ0IHRoZSBmbG93IGlmIGl0IGhhc24ndCBiZWVuIHN0YXJ0ZWQgYWxyZWFkeS5cbiAgaWYgKCFzdGF0ZS5mbG93aW5nKSB7XG4gICAgZGVidWcoJ3BpcGUgcmVzdW1lJyk7XG4gICAgc3JjLnJlc3VtZSgpO1xuICB9XG5cbiAgcmV0dXJuIGRlc3Q7XG59O1xuXG5mdW5jdGlvbiBwaXBlT25EcmFpbihzcmMpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgIHZhciBzdGF0ZSA9IHNyYy5fcmVhZGFibGVTdGF0ZTtcbiAgICBkZWJ1ZygncGlwZU9uRHJhaW4nLCBzdGF0ZS5hd2FpdERyYWluKTtcbiAgICBpZiAoc3RhdGUuYXdhaXREcmFpbilcbiAgICAgIHN0YXRlLmF3YWl0RHJhaW4tLTtcbiAgICBpZiAoc3RhdGUuYXdhaXREcmFpbiA9PT0gMCAmJiBFRWxpc3RlbmVyQ291bnQoc3JjLCAnZGF0YScpKSB7XG4gICAgICBzdGF0ZS5mbG93aW5nID0gdHJ1ZTtcbiAgICAgIGZsb3coc3JjKTtcbiAgICB9XG4gIH07XG59XG5cblxuUmVhZGFibGUucHJvdG90eXBlLnVucGlwZSA9IGZ1bmN0aW9uKGRlc3QpIHtcbiAgdmFyIHN0YXRlID0gdGhpcy5fcmVhZGFibGVTdGF0ZTtcblxuICAvLyBpZiB3ZSdyZSBub3QgcGlwaW5nIGFueXdoZXJlLCB0aGVuIGRvIG5vdGhpbmcuXG4gIGlmIChzdGF0ZS5waXBlc0NvdW50ID09PSAwKVxuICAgIHJldHVybiB0aGlzO1xuXG4gIC8vIGp1c3Qgb25lIGRlc3RpbmF0aW9uLiAgbW9zdCBjb21tb24gY2FzZS5cbiAgaWYgKHN0YXRlLnBpcGVzQ291bnQgPT09IDEpIHtcbiAgICAvLyBwYXNzZWQgaW4gb25lLCBidXQgaXQncyBub3QgdGhlIHJpZ2h0IG9uZS5cbiAgICBpZiAoZGVzdCAmJiBkZXN0ICE9PSBzdGF0ZS5waXBlcylcbiAgICAgIHJldHVybiB0aGlzO1xuXG4gICAgaWYgKCFkZXN0KVxuICAgICAgZGVzdCA9IHN0YXRlLnBpcGVzO1xuXG4gICAgLy8gZ290IGEgbWF0Y2guXG4gICAgc3RhdGUucGlwZXMgPSBudWxsO1xuICAgIHN0YXRlLnBpcGVzQ291bnQgPSAwO1xuICAgIHN0YXRlLmZsb3dpbmcgPSBmYWxzZTtcbiAgICBpZiAoZGVzdClcbiAgICAgIGRlc3QuZW1pdCgndW5waXBlJywgdGhpcyk7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvLyBzbG93IGNhc2UuIG11bHRpcGxlIHBpcGUgZGVzdGluYXRpb25zLlxuXG4gIGlmICghZGVzdCkge1xuICAgIC8vIHJlbW92ZSBhbGwuXG4gICAgdmFyIGRlc3RzID0gc3RhdGUucGlwZXM7XG4gICAgdmFyIGxlbiA9IHN0YXRlLnBpcGVzQ291bnQ7XG4gICAgc3RhdGUucGlwZXMgPSBudWxsO1xuICAgIHN0YXRlLnBpcGVzQ291bnQgPSAwO1xuICAgIHN0YXRlLmZsb3dpbmcgPSBmYWxzZTtcblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuOyBpKyspXG4gICAgICBkZXN0c1tpXS5lbWl0KCd1bnBpcGUnLCB0aGlzKTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8vIHRyeSB0byBmaW5kIHRoZSByaWdodCBvbmUuXG4gIHZhciBpID0gaW5kZXhPZihzdGF0ZS5waXBlcywgZGVzdCk7XG4gIGlmIChpID09PSAtMSlcbiAgICByZXR1cm4gdGhpcztcblxuICBzdGF0ZS5waXBlcy5zcGxpY2UoaSwgMSk7XG4gIHN0YXRlLnBpcGVzQ291bnQgLT0gMTtcbiAgaWYgKHN0YXRlLnBpcGVzQ291bnQgPT09IDEpXG4gICAgc3RhdGUucGlwZXMgPSBzdGF0ZS5waXBlc1swXTtcblxuICBkZXN0LmVtaXQoJ3VucGlwZScsIHRoaXMpO1xuXG4gIHJldHVybiB0aGlzO1xufTtcblxuLy8gc2V0IHVwIGRhdGEgZXZlbnRzIGlmIHRoZXkgYXJlIGFza2VkIGZvclxuLy8gRW5zdXJlIHJlYWRhYmxlIGxpc3RlbmVycyBldmVudHVhbGx5IGdldCBzb21ldGhpbmdcblJlYWRhYmxlLnByb3RvdHlwZS5vbiA9IGZ1bmN0aW9uKGV2LCBmbikge1xuICB2YXIgcmVzID0gU3RyZWFtLnByb3RvdHlwZS5vbi5jYWxsKHRoaXMsIGV2LCBmbik7XG5cbiAgLy8gSWYgbGlzdGVuaW5nIHRvIGRhdGEsIGFuZCBpdCBoYXMgbm90IGV4cGxpY2l0bHkgYmVlbiBwYXVzZWQsXG4gIC8vIHRoZW4gY2FsbCByZXN1bWUgdG8gc3RhcnQgdGhlIGZsb3cgb2YgZGF0YSBvbiB0aGUgbmV4dCB0aWNrLlxuICBpZiAoZXYgPT09ICdkYXRhJyAmJiBmYWxzZSAhPT0gdGhpcy5fcmVhZGFibGVTdGF0ZS5mbG93aW5nKSB7XG4gICAgdGhpcy5yZXN1bWUoKTtcbiAgfVxuXG4gIGlmIChldiA9PT0gJ3JlYWRhYmxlJyAmJiB0aGlzLnJlYWRhYmxlKSB7XG4gICAgdmFyIHN0YXRlID0gdGhpcy5fcmVhZGFibGVTdGF0ZTtcbiAgICBpZiAoIXN0YXRlLnJlYWRhYmxlTGlzdGVuaW5nKSB7XG4gICAgICBzdGF0ZS5yZWFkYWJsZUxpc3RlbmluZyA9IHRydWU7XG4gICAgICBzdGF0ZS5lbWl0dGVkUmVhZGFibGUgPSBmYWxzZTtcbiAgICAgIHN0YXRlLm5lZWRSZWFkYWJsZSA9IHRydWU7XG4gICAgICBpZiAoIXN0YXRlLnJlYWRpbmcpIHtcbiAgICAgICAgcHJvY2Vzc05leHRUaWNrKG5SZWFkaW5nTmV4dFRpY2ssIHRoaXMpO1xuICAgICAgfSBlbHNlIGlmIChzdGF0ZS5sZW5ndGgpIHtcbiAgICAgICAgZW1pdFJlYWRhYmxlKHRoaXMsIHN0YXRlKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzO1xufTtcblJlYWRhYmxlLnByb3RvdHlwZS5hZGRMaXN0ZW5lciA9IFJlYWRhYmxlLnByb3RvdHlwZS5vbjtcblxuZnVuY3Rpb24gblJlYWRpbmdOZXh0VGljayhzZWxmKSB7XG4gIGRlYnVnKCdyZWFkYWJsZSBuZXh0dGljayByZWFkIDAnKTtcbiAgc2VsZi5yZWFkKDApO1xufVxuXG4vLyBwYXVzZSgpIGFuZCByZXN1bWUoKSBhcmUgcmVtbmFudHMgb2YgdGhlIGxlZ2FjeSByZWFkYWJsZSBzdHJlYW0gQVBJXG4vLyBJZiB0aGUgdXNlciB1c2VzIHRoZW0sIHRoZW4gc3dpdGNoIGludG8gb2xkIG1vZGUuXG5SZWFkYWJsZS5wcm90b3R5cGUucmVzdW1lID0gZnVuY3Rpb24oKSB7XG4gIHZhciBzdGF0ZSA9IHRoaXMuX3JlYWRhYmxlU3RhdGU7XG4gIGlmICghc3RhdGUuZmxvd2luZykge1xuICAgIGRlYnVnKCdyZXN1bWUnKTtcbiAgICBzdGF0ZS5mbG93aW5nID0gdHJ1ZTtcbiAgICByZXN1bWUodGhpcywgc3RhdGUpO1xuICB9XG4gIHJldHVybiB0aGlzO1xufTtcblxuZnVuY3Rpb24gcmVzdW1lKHN0cmVhbSwgc3RhdGUpIHtcbiAgaWYgKCFzdGF0ZS5yZXN1bWVTY2hlZHVsZWQpIHtcbiAgICBzdGF0ZS5yZXN1bWVTY2hlZHVsZWQgPSB0cnVlO1xuICAgIHByb2Nlc3NOZXh0VGljayhyZXN1bWVfLCBzdHJlYW0sIHN0YXRlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXN1bWVfKHN0cmVhbSwgc3RhdGUpIHtcbiAgaWYgKCFzdGF0ZS5yZWFkaW5nKSB7XG4gICAgZGVidWcoJ3Jlc3VtZSByZWFkIDAnKTtcbiAgICBzdHJlYW0ucmVhZCgwKTtcbiAgfVxuXG4gIHN0YXRlLnJlc3VtZVNjaGVkdWxlZCA9IGZhbHNlO1xuICBzdHJlYW0uZW1pdCgncmVzdW1lJyk7XG4gIGZsb3coc3RyZWFtKTtcbiAgaWYgKHN0YXRlLmZsb3dpbmcgJiYgIXN0YXRlLnJlYWRpbmcpXG4gICAgc3RyZWFtLnJlYWQoMCk7XG59XG5cblJlYWRhYmxlLnByb3RvdHlwZS5wYXVzZSA9IGZ1bmN0aW9uKCkge1xuICBkZWJ1ZygnY2FsbCBwYXVzZSBmbG93aW5nPSVqJywgdGhpcy5fcmVhZGFibGVTdGF0ZS5mbG93aW5nKTtcbiAgaWYgKGZhbHNlICE9PSB0aGlzLl9yZWFkYWJsZVN0YXRlLmZsb3dpbmcpIHtcbiAgICBkZWJ1ZygncGF1c2UnKTtcbiAgICB0aGlzLl9yZWFkYWJsZVN0YXRlLmZsb3dpbmcgPSBmYWxzZTtcbiAgICB0aGlzLmVtaXQoJ3BhdXNlJyk7XG4gIH1cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5mdW5jdGlvbiBmbG93KHN0cmVhbSkge1xuICB2YXIgc3RhdGUgPSBzdHJlYW0uX3JlYWRhYmxlU3RhdGU7XG4gIGRlYnVnKCdmbG93Jywgc3RhdGUuZmxvd2luZyk7XG4gIGlmIChzdGF0ZS5mbG93aW5nKSB7XG4gICAgZG8ge1xuICAgICAgdmFyIGNodW5rID0gc3RyZWFtLnJlYWQoKTtcbiAgICB9IHdoaWxlIChudWxsICE9PSBjaHVuayAmJiBzdGF0ZS5mbG93aW5nKTtcbiAgfVxufVxuXG4vLyB3cmFwIGFuIG9sZC1zdHlsZSBzdHJlYW0gYXMgdGhlIGFzeW5jIGRhdGEgc291cmNlLlxuLy8gVGhpcyBpcyAqbm90KiBwYXJ0IG9mIHRoZSByZWFkYWJsZSBzdHJlYW0gaW50ZXJmYWNlLlxuLy8gSXQgaXMgYW4gdWdseSB1bmZvcnR1bmF0ZSBtZXNzIG9mIGhpc3RvcnkuXG5SZWFkYWJsZS5wcm90b3R5cGUud3JhcCA9IGZ1bmN0aW9uKHN0cmVhbSkge1xuICB2YXIgc3RhdGUgPSB0aGlzLl9yZWFkYWJsZVN0YXRlO1xuICB2YXIgcGF1c2VkID0gZmFsc2U7XG5cbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBzdHJlYW0ub24oJ2VuZCcsIGZ1bmN0aW9uKCkge1xuICAgIGRlYnVnKCd3cmFwcGVkIGVuZCcpO1xuICAgIGlmIChzdGF0ZS5kZWNvZGVyICYmICFzdGF0ZS5lbmRlZCkge1xuICAgICAgdmFyIGNodW5rID0gc3RhdGUuZGVjb2Rlci5lbmQoKTtcbiAgICAgIGlmIChjaHVuayAmJiBjaHVuay5sZW5ndGgpXG4gICAgICAgIHNlbGYucHVzaChjaHVuayk7XG4gICAgfVxuXG4gICAgc2VsZi5wdXNoKG51bGwpO1xuICB9KTtcblxuICBzdHJlYW0ub24oJ2RhdGEnLCBmdW5jdGlvbihjaHVuaykge1xuICAgIGRlYnVnKCd3cmFwcGVkIGRhdGEnKTtcbiAgICBpZiAoc3RhdGUuZGVjb2RlcilcbiAgICAgIGNodW5rID0gc3RhdGUuZGVjb2Rlci53cml0ZShjaHVuayk7XG5cbiAgICAvLyBkb24ndCBza2lwIG92ZXIgZmFsc3kgdmFsdWVzIGluIG9iamVjdE1vZGVcbiAgICBpZiAoc3RhdGUub2JqZWN0TW9kZSAmJiAoY2h1bmsgPT09IG51bGwgfHwgY2h1bmsgPT09IHVuZGVmaW5lZCkpXG4gICAgICByZXR1cm47XG4gICAgZWxzZSBpZiAoIXN0YXRlLm9iamVjdE1vZGUgJiYgKCFjaHVuayB8fCAhY2h1bmsubGVuZ3RoKSlcbiAgICAgIHJldHVybjtcblxuICAgIHZhciByZXQgPSBzZWxmLnB1c2goY2h1bmspO1xuICAgIGlmICghcmV0KSB7XG4gICAgICBwYXVzZWQgPSB0cnVlO1xuICAgICAgc3RyZWFtLnBhdXNlKCk7XG4gICAgfVxuICB9KTtcblxuICAvLyBwcm94eSBhbGwgdGhlIG90aGVyIG1ldGhvZHMuXG4gIC8vIGltcG9ydGFudCB3aGVuIHdyYXBwaW5nIGZpbHRlcnMgYW5kIGR1cGxleGVzLlxuICBmb3IgKHZhciBpIGluIHN0cmVhbSkge1xuICAgIGlmICh0aGlzW2ldID09PSB1bmRlZmluZWQgJiYgdHlwZW9mIHN0cmVhbVtpXSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgdGhpc1tpXSA9IGZ1bmN0aW9uKG1ldGhvZCkgeyByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICAgIHJldHVybiBzdHJlYW1bbWV0aG9kXS5hcHBseShzdHJlYW0sIGFyZ3VtZW50cyk7XG4gICAgICB9OyB9KGkpO1xuICAgIH1cbiAgfVxuXG4gIC8vIHByb3h5IGNlcnRhaW4gaW1wb3J0YW50IGV2ZW50cy5cbiAgdmFyIGV2ZW50cyA9IFsnZXJyb3InLCAnY2xvc2UnLCAnZGVzdHJveScsICdwYXVzZScsICdyZXN1bWUnXTtcbiAgZm9yRWFjaChldmVudHMsIGZ1bmN0aW9uKGV2KSB7XG4gICAgc3RyZWFtLm9uKGV2LCBzZWxmLmVtaXQuYmluZChzZWxmLCBldikpO1xuICB9KTtcblxuICAvLyB3aGVuIHdlIHRyeSB0byBjb25zdW1lIHNvbWUgbW9yZSBieXRlcywgc2ltcGx5IHVucGF1c2UgdGhlXG4gIC8vIHVuZGVybHlpbmcgc3RyZWFtLlxuICBzZWxmLl9yZWFkID0gZnVuY3Rpb24obikge1xuICAgIGRlYnVnKCd3cmFwcGVkIF9yZWFkJywgbik7XG4gICAgaWYgKHBhdXNlZCkge1xuICAgICAgcGF1c2VkID0gZmFsc2U7XG4gICAgICBzdHJlYW0ucmVzdW1lKCk7XG4gICAgfVxuICB9O1xuXG4gIHJldHVybiBzZWxmO1xufTtcblxuXG4vLyBleHBvc2VkIGZvciB0ZXN0aW5nIHB1cnBvc2VzIG9ubHkuXG5SZWFkYWJsZS5fZnJvbUxpc3QgPSBmcm9tTGlzdDtcblxuLy8gUGx1Y2sgb2ZmIG4gYnl0ZXMgZnJvbSBhbiBhcnJheSBvZiBidWZmZXJzLlxuLy8gTGVuZ3RoIGlzIHRoZSBjb21iaW5lZCBsZW5ndGhzIG9mIGFsbCB0aGUgYnVmZmVycyBpbiB0aGUgbGlzdC5cbmZ1bmN0aW9uIGZyb21MaXN0KG4sIHN0YXRlKSB7XG4gIHZhciBsaXN0ID0gc3RhdGUuYnVmZmVyO1xuICB2YXIgbGVuZ3RoID0gc3RhdGUubGVuZ3RoO1xuICB2YXIgc3RyaW5nTW9kZSA9ICEhc3RhdGUuZGVjb2RlcjtcbiAgdmFyIG9iamVjdE1vZGUgPSAhIXN0YXRlLm9iamVjdE1vZGU7XG4gIHZhciByZXQ7XG5cbiAgLy8gbm90aGluZyBpbiB0aGUgbGlzdCwgZGVmaW5pdGVseSBlbXB0eS5cbiAgaWYgKGxpc3QubGVuZ3RoID09PSAwKVxuICAgIHJldHVybiBudWxsO1xuXG4gIGlmIChsZW5ndGggPT09IDApXG4gICAgcmV0ID0gbnVsbDtcbiAgZWxzZSBpZiAob2JqZWN0TW9kZSlcbiAgICByZXQgPSBsaXN0LnNoaWZ0KCk7XG4gIGVsc2UgaWYgKCFuIHx8IG4gPj0gbGVuZ3RoKSB7XG4gICAgLy8gcmVhZCBpdCBhbGwsIHRydW5jYXRlIHRoZSBhcnJheS5cbiAgICBpZiAoc3RyaW5nTW9kZSlcbiAgICAgIHJldCA9IGxpc3Quam9pbignJyk7XG4gICAgZWxzZSBpZiAobGlzdC5sZW5ndGggPT09IDEpXG4gICAgICByZXQgPSBsaXN0WzBdO1xuICAgIGVsc2VcbiAgICAgIHJldCA9IEJ1ZmZlci5jb25jYXQobGlzdCwgbGVuZ3RoKTtcbiAgICBsaXN0Lmxlbmd0aCA9IDA7XG4gIH0gZWxzZSB7XG4gICAgLy8gcmVhZCBqdXN0IHNvbWUgb2YgaXQuXG4gICAgaWYgKG4gPCBsaXN0WzBdLmxlbmd0aCkge1xuICAgICAgLy8ganVzdCB0YWtlIGEgcGFydCBvZiB0aGUgZmlyc3QgbGlzdCBpdGVtLlxuICAgICAgLy8gc2xpY2UgaXMgdGhlIHNhbWUgZm9yIGJ1ZmZlcnMgYW5kIHN0cmluZ3MuXG4gICAgICB2YXIgYnVmID0gbGlzdFswXTtcbiAgICAgIHJldCA9IGJ1Zi5zbGljZSgwLCBuKTtcbiAgICAgIGxpc3RbMF0gPSBidWYuc2xpY2Uobik7XG4gICAgfSBlbHNlIGlmIChuID09PSBsaXN0WzBdLmxlbmd0aCkge1xuICAgICAgLy8gZmlyc3QgbGlzdCBpcyBhIHBlcmZlY3QgbWF0Y2hcbiAgICAgIHJldCA9IGxpc3Quc2hpZnQoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gY29tcGxleCBjYXNlLlxuICAgICAgLy8gd2UgaGF2ZSBlbm91Z2ggdG8gY292ZXIgaXQsIGJ1dCBpdCBzcGFucyBwYXN0IHRoZSBmaXJzdCBidWZmZXIuXG4gICAgICBpZiAoc3RyaW5nTW9kZSlcbiAgICAgICAgcmV0ID0gJyc7XG4gICAgICBlbHNlXG4gICAgICAgIHJldCA9IG5ldyBCdWZmZXIobik7XG5cbiAgICAgIHZhciBjID0gMDtcbiAgICAgIGZvciAodmFyIGkgPSAwLCBsID0gbGlzdC5sZW5ndGg7IGkgPCBsICYmIGMgPCBuOyBpKyspIHtcbiAgICAgICAgdmFyIGJ1ZiA9IGxpc3RbMF07XG4gICAgICAgIHZhciBjcHkgPSBNYXRoLm1pbihuIC0gYywgYnVmLmxlbmd0aCk7XG5cbiAgICAgICAgaWYgKHN0cmluZ01vZGUpXG4gICAgICAgICAgcmV0ICs9IGJ1Zi5zbGljZSgwLCBjcHkpO1xuICAgICAgICBlbHNlXG4gICAgICAgICAgYnVmLmNvcHkocmV0LCBjLCAwLCBjcHkpO1xuXG4gICAgICAgIGlmIChjcHkgPCBidWYubGVuZ3RoKVxuICAgICAgICAgIGxpc3RbMF0gPSBidWYuc2xpY2UoY3B5KTtcbiAgICAgICAgZWxzZVxuICAgICAgICAgIGxpc3Quc2hpZnQoKTtcblxuICAgICAgICBjICs9IGNweTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmV0O1xufVxuXG5mdW5jdGlvbiBlbmRSZWFkYWJsZShzdHJlYW0pIHtcbiAgdmFyIHN0YXRlID0gc3RyZWFtLl9yZWFkYWJsZVN0YXRlO1xuXG4gIC8vIElmIHdlIGdldCBoZXJlIGJlZm9yZSBjb25zdW1pbmcgYWxsIHRoZSBieXRlcywgdGhlbiB0aGF0IGlzIGFcbiAgLy8gYnVnIGluIG5vZGUuICBTaG91bGQgbmV2ZXIgaGFwcGVuLlxuICBpZiAoc3RhdGUubGVuZ3RoID4gMClcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ2VuZFJlYWRhYmxlIGNhbGxlZCBvbiBub24tZW1wdHkgc3RyZWFtJyk7XG5cbiAgaWYgKCFzdGF0ZS5lbmRFbWl0dGVkKSB7XG4gICAgc3RhdGUuZW5kZWQgPSB0cnVlO1xuICAgIHByb2Nlc3NOZXh0VGljayhlbmRSZWFkYWJsZU5ULCBzdGF0ZSwgc3RyZWFtKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBlbmRSZWFkYWJsZU5UKHN0YXRlLCBzdHJlYW0pIHtcbiAgLy8gQ2hlY2sgdGhhdCB3ZSBkaWRuJ3QgZ2V0IG9uZSBsYXN0IHVuc2hpZnQuXG4gIGlmICghc3RhdGUuZW5kRW1pdHRlZCAmJiBzdGF0ZS5sZW5ndGggPT09IDApIHtcbiAgICBzdGF0ZS5lbmRFbWl0dGVkID0gdHJ1ZTtcbiAgICBzdHJlYW0ucmVhZGFibGUgPSBmYWxzZTtcbiAgICBzdHJlYW0uZW1pdCgnZW5kJyk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZm9yRWFjaCAoeHMsIGYpIHtcbiAgZm9yICh2YXIgaSA9IDAsIGwgPSB4cy5sZW5ndGg7IGkgPCBsOyBpKyspIHtcbiAgICBmKHhzW2ldLCBpKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBpbmRleE9mICh4cywgeCkge1xuICBmb3IgKHZhciBpID0gMCwgbCA9IHhzLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgIGlmICh4c1tpXSA9PT0geCkgcmV0dXJuIGk7XG4gIH1cbiAgcmV0dXJuIC0xO1xufVxuXG59KS5jYWxsKHRoaXMscmVxdWlyZSgnX3Byb2Nlc3MnKSkiLCIvLyBhIHRyYW5zZm9ybSBzdHJlYW0gaXMgYSByZWFkYWJsZS93cml0YWJsZSBzdHJlYW0gd2hlcmUgeW91IGRvXG4vLyBzb21ldGhpbmcgd2l0aCB0aGUgZGF0YS4gIFNvbWV0aW1lcyBpdCdzIGNhbGxlZCBhIFwiZmlsdGVyXCIsXG4vLyBidXQgdGhhdCdzIG5vdCBhIGdyZWF0IG5hbWUgZm9yIGl0LCBzaW5jZSB0aGF0IGltcGxpZXMgYSB0aGluZyB3aGVyZVxuLy8gc29tZSBiaXRzIHBhc3MgdGhyb3VnaCwgYW5kIG90aGVycyBhcmUgc2ltcGx5IGlnbm9yZWQuICAoVGhhdCB3b3VsZFxuLy8gYmUgYSB2YWxpZCBleGFtcGxlIG9mIGEgdHJhbnNmb3JtLCBvZiBjb3Vyc2UuKVxuLy9cbi8vIFdoaWxlIHRoZSBvdXRwdXQgaXMgY2F1c2FsbHkgcmVsYXRlZCB0byB0aGUgaW5wdXQsIGl0J3Mgbm90IGFcbi8vIG5lY2Vzc2FyaWx5IHN5bW1ldHJpYyBvciBzeW5jaHJvbm91cyB0cmFuc2Zvcm1hdGlvbi4gIEZvciBleGFtcGxlLFxuLy8gYSB6bGliIHN0cmVhbSBtaWdodCB0YWtlIG11bHRpcGxlIHBsYWluLXRleHQgd3JpdGVzKCksIGFuZCB0aGVuXG4vLyBlbWl0IGEgc2luZ2xlIGNvbXByZXNzZWQgY2h1bmsgc29tZSB0aW1lIGluIHRoZSBmdXR1cmUuXG4vL1xuLy8gSGVyZSdzIGhvdyB0aGlzIHdvcmtzOlxuLy9cbi8vIFRoZSBUcmFuc2Zvcm0gc3RyZWFtIGhhcyBhbGwgdGhlIGFzcGVjdHMgb2YgdGhlIHJlYWRhYmxlIGFuZCB3cml0YWJsZVxuLy8gc3RyZWFtIGNsYXNzZXMuICBXaGVuIHlvdSB3cml0ZShjaHVuayksIHRoYXQgY2FsbHMgX3dyaXRlKGNodW5rLGNiKVxuLy8gaW50ZXJuYWxseSwgYW5kIHJldHVybnMgZmFsc2UgaWYgdGhlcmUncyBhIGxvdCBvZiBwZW5kaW5nIHdyaXRlc1xuLy8gYnVmZmVyZWQgdXAuICBXaGVuIHlvdSBjYWxsIHJlYWQoKSwgdGhhdCBjYWxscyBfcmVhZChuKSB1bnRpbFxuLy8gdGhlcmUncyBlbm91Z2ggcGVuZGluZyByZWFkYWJsZSBkYXRhIGJ1ZmZlcmVkIHVwLlxuLy9cbi8vIEluIGEgdHJhbnNmb3JtIHN0cmVhbSwgdGhlIHdyaXR0ZW4gZGF0YSBpcyBwbGFjZWQgaW4gYSBidWZmZXIuICBXaGVuXG4vLyBfcmVhZChuKSBpcyBjYWxsZWQsIGl0IHRyYW5zZm9ybXMgdGhlIHF1ZXVlZCB1cCBkYXRhLCBjYWxsaW5nIHRoZVxuLy8gYnVmZmVyZWQgX3dyaXRlIGNiJ3MgYXMgaXQgY29uc3VtZXMgY2h1bmtzLiAgSWYgY29uc3VtaW5nIGEgc2luZ2xlXG4vLyB3cml0dGVuIGNodW5rIHdvdWxkIHJlc3VsdCBpbiBtdWx0aXBsZSBvdXRwdXQgY2h1bmtzLCB0aGVuIHRoZSBmaXJzdFxuLy8gb3V0cHV0dGVkIGJpdCBjYWxscyB0aGUgcmVhZGNiLCBhbmQgc3Vic2VxdWVudCBjaHVua3MganVzdCBnbyBpbnRvXG4vLyB0aGUgcmVhZCBidWZmZXIsIGFuZCB3aWxsIGNhdXNlIGl0IHRvIGVtaXQgJ3JlYWRhYmxlJyBpZiBuZWNlc3NhcnkuXG4vL1xuLy8gVGhpcyB3YXksIGJhY2stcHJlc3N1cmUgaXMgYWN0dWFsbHkgZGV0ZXJtaW5lZCBieSB0aGUgcmVhZGluZyBzaWRlLFxuLy8gc2luY2UgX3JlYWQgaGFzIHRvIGJlIGNhbGxlZCB0byBzdGFydCBwcm9jZXNzaW5nIGEgbmV3IGNodW5rLiAgSG93ZXZlcixcbi8vIGEgcGF0aG9sb2dpY2FsIGluZmxhdGUgdHlwZSBvZiB0cmFuc2Zvcm0gY2FuIGNhdXNlIGV4Y2Vzc2l2ZSBidWZmZXJpbmdcbi8vIGhlcmUuICBGb3IgZXhhbXBsZSwgaW1hZ2luZSBhIHN0cmVhbSB3aGVyZSBldmVyeSBieXRlIG9mIGlucHV0IGlzXG4vLyBpbnRlcnByZXRlZCBhcyBhbiBpbnRlZ2VyIGZyb20gMC0yNTUsIGFuZCB0aGVuIHJlc3VsdHMgaW4gdGhhdCBtYW55XG4vLyBieXRlcyBvZiBvdXRwdXQuICBXcml0aW5nIHRoZSA0IGJ5dGVzIHtmZixmZixmZixmZn0gd291bGQgcmVzdWx0IGluXG4vLyAxa2Igb2YgZGF0YSBiZWluZyBvdXRwdXQuICBJbiB0aGlzIGNhc2UsIHlvdSBjb3VsZCB3cml0ZSBhIHZlcnkgc21hbGxcbi8vIGFtb3VudCBvZiBpbnB1dCwgYW5kIGVuZCB1cCB3aXRoIGEgdmVyeSBsYXJnZSBhbW91bnQgb2Ygb3V0cHV0LiAgSW5cbi8vIHN1Y2ggYSBwYXRob2xvZ2ljYWwgaW5mbGF0aW5nIG1lY2hhbmlzbSwgdGhlcmUnZCBiZSBubyB3YXkgdG8gdGVsbFxuLy8gdGhlIHN5c3RlbSB0byBzdG9wIGRvaW5nIHRoZSB0cmFuc2Zvcm0uICBBIHNpbmdsZSA0TUIgd3JpdGUgY291bGRcbi8vIGNhdXNlIHRoZSBzeXN0ZW0gdG8gcnVuIG91dCBvZiBtZW1vcnkuXG4vL1xuLy8gSG93ZXZlciwgZXZlbiBpbiBzdWNoIGEgcGF0aG9sb2dpY2FsIGNhc2UsIG9ubHkgYSBzaW5nbGUgd3JpdHRlbiBjaHVua1xuLy8gd291bGQgYmUgY29uc3VtZWQsIGFuZCB0aGVuIHRoZSByZXN0IHdvdWxkIHdhaXQgKHVuLXRyYW5zZm9ybWVkKSB1bnRpbFxuLy8gdGhlIHJlc3VsdHMgb2YgdGhlIHByZXZpb3VzIHRyYW5zZm9ybWVkIGNodW5rIHdlcmUgY29uc3VtZWQuXG5cbid1c2Ugc3RyaWN0JztcblxubW9kdWxlLmV4cG9ydHMgPSBUcmFuc2Zvcm07XG5cbnZhciBEdXBsZXggPSByZXF1aXJlKCcuL19zdHJlYW1fZHVwbGV4Jyk7XG5cbi8qPHJlcGxhY2VtZW50PiovXG52YXIgdXRpbCA9IHJlcXVpcmUoJ2NvcmUtdXRpbC1pcycpO1xudXRpbC5pbmhlcml0cyA9IHJlcXVpcmUoJ2luaGVyaXRzJyk7XG4vKjwvcmVwbGFjZW1lbnQ+Ki9cblxudXRpbC5pbmhlcml0cyhUcmFuc2Zvcm0sIER1cGxleCk7XG5cblxuZnVuY3Rpb24gVHJhbnNmb3JtU3RhdGUoc3RyZWFtKSB7XG4gIHRoaXMuYWZ0ZXJUcmFuc2Zvcm0gPSBmdW5jdGlvbihlciwgZGF0YSkge1xuICAgIHJldHVybiBhZnRlclRyYW5zZm9ybShzdHJlYW0sIGVyLCBkYXRhKTtcbiAgfTtcblxuICB0aGlzLm5lZWRUcmFuc2Zvcm0gPSBmYWxzZTtcbiAgdGhpcy50cmFuc2Zvcm1pbmcgPSBmYWxzZTtcbiAgdGhpcy53cml0ZWNiID0gbnVsbDtcbiAgdGhpcy53cml0ZWNodW5rID0gbnVsbDtcbn1cblxuZnVuY3Rpb24gYWZ0ZXJUcmFuc2Zvcm0oc3RyZWFtLCBlciwgZGF0YSkge1xuICB2YXIgdHMgPSBzdHJlYW0uX3RyYW5zZm9ybVN0YXRlO1xuICB0cy50cmFuc2Zvcm1pbmcgPSBmYWxzZTtcblxuICB2YXIgY2IgPSB0cy53cml0ZWNiO1xuXG4gIGlmICghY2IpXG4gICAgcmV0dXJuIHN0cmVhbS5lbWl0KCdlcnJvcicsIG5ldyBFcnJvcignbm8gd3JpdGVjYiBpbiBUcmFuc2Zvcm0gY2xhc3MnKSk7XG5cbiAgdHMud3JpdGVjaHVuayA9IG51bGw7XG4gIHRzLndyaXRlY2IgPSBudWxsO1xuXG4gIGlmIChkYXRhICE9PSBudWxsICYmIGRhdGEgIT09IHVuZGVmaW5lZClcbiAgICBzdHJlYW0ucHVzaChkYXRhKTtcblxuICBpZiAoY2IpXG4gICAgY2IoZXIpO1xuXG4gIHZhciBycyA9IHN0cmVhbS5fcmVhZGFibGVTdGF0ZTtcbiAgcnMucmVhZGluZyA9IGZhbHNlO1xuICBpZiAocnMubmVlZFJlYWRhYmxlIHx8IHJzLmxlbmd0aCA8IHJzLmhpZ2hXYXRlck1hcmspIHtcbiAgICBzdHJlYW0uX3JlYWQocnMuaGlnaFdhdGVyTWFyayk7XG4gIH1cbn1cblxuXG5mdW5jdGlvbiBUcmFuc2Zvcm0ob3B0aW9ucykge1xuICBpZiAoISh0aGlzIGluc3RhbmNlb2YgVHJhbnNmb3JtKSlcbiAgICByZXR1cm4gbmV3IFRyYW5zZm9ybShvcHRpb25zKTtcblxuICBEdXBsZXguY2FsbCh0aGlzLCBvcHRpb25zKTtcblxuICB0aGlzLl90cmFuc2Zvcm1TdGF0ZSA9IG5ldyBUcmFuc2Zvcm1TdGF0ZSh0aGlzKTtcblxuICAvLyB3aGVuIHRoZSB3cml0YWJsZSBzaWRlIGZpbmlzaGVzLCB0aGVuIGZsdXNoIG91dCBhbnl0aGluZyByZW1haW5pbmcuXG4gIHZhciBzdHJlYW0gPSB0aGlzO1xuXG4gIC8vIHN0YXJ0IG91dCBhc2tpbmcgZm9yIGEgcmVhZGFibGUgZXZlbnQgb25jZSBkYXRhIGlzIHRyYW5zZm9ybWVkLlxuICB0aGlzLl9yZWFkYWJsZVN0YXRlLm5lZWRSZWFkYWJsZSA9IHRydWU7XG5cbiAgLy8gd2UgaGF2ZSBpbXBsZW1lbnRlZCB0aGUgX3JlYWQgbWV0aG9kLCBhbmQgZG9uZSB0aGUgb3RoZXIgdGhpbmdzXG4gIC8vIHRoYXQgUmVhZGFibGUgd2FudHMgYmVmb3JlIHRoZSBmaXJzdCBfcmVhZCBjYWxsLCBzbyB1bnNldCB0aGVcbiAgLy8gc3luYyBndWFyZCBmbGFnLlxuICB0aGlzLl9yZWFkYWJsZVN0YXRlLnN5bmMgPSBmYWxzZTtcblxuICBpZiAob3B0aW9ucykge1xuICAgIGlmICh0eXBlb2Ygb3B0aW9ucy50cmFuc2Zvcm0gPT09ICdmdW5jdGlvbicpXG4gICAgICB0aGlzLl90cmFuc2Zvcm0gPSBvcHRpb25zLnRyYW5zZm9ybTtcblxuICAgIGlmICh0eXBlb2Ygb3B0aW9ucy5mbHVzaCA9PT0gJ2Z1bmN0aW9uJylcbiAgICAgIHRoaXMuX2ZsdXNoID0gb3B0aW9ucy5mbHVzaDtcbiAgfVxuXG4gIHRoaXMub25jZSgncHJlZmluaXNoJywgZnVuY3Rpb24oKSB7XG4gICAgaWYgKHR5cGVvZiB0aGlzLl9mbHVzaCA9PT0gJ2Z1bmN0aW9uJylcbiAgICAgIHRoaXMuX2ZsdXNoKGZ1bmN0aW9uKGVyKSB7XG4gICAgICAgIGRvbmUoc3RyZWFtLCBlcik7XG4gICAgICB9KTtcbiAgICBlbHNlXG4gICAgICBkb25lKHN0cmVhbSk7XG4gIH0pO1xufVxuXG5UcmFuc2Zvcm0ucHJvdG90eXBlLnB1c2ggPSBmdW5jdGlvbihjaHVuaywgZW5jb2RpbmcpIHtcbiAgdGhpcy5fdHJhbnNmb3JtU3RhdGUubmVlZFRyYW5zZm9ybSA9IGZhbHNlO1xuICByZXR1cm4gRHVwbGV4LnByb3RvdHlwZS5wdXNoLmNhbGwodGhpcywgY2h1bmssIGVuY29kaW5nKTtcbn07XG5cbi8vIFRoaXMgaXMgdGhlIHBhcnQgd2hlcmUgeW91IGRvIHN0dWZmIVxuLy8gb3ZlcnJpZGUgdGhpcyBmdW5jdGlvbiBpbiBpbXBsZW1lbnRhdGlvbiBjbGFzc2VzLlxuLy8gJ2NodW5rJyBpcyBhbiBpbnB1dCBjaHVuay5cbi8vXG4vLyBDYWxsIGBwdXNoKG5ld0NodW5rKWAgdG8gcGFzcyBhbG9uZyB0cmFuc2Zvcm1lZCBvdXRwdXRcbi8vIHRvIHRoZSByZWFkYWJsZSBzaWRlLiAgWW91IG1heSBjYWxsICdwdXNoJyB6ZXJvIG9yIG1vcmUgdGltZXMuXG4vL1xuLy8gQ2FsbCBgY2IoZXJyKWAgd2hlbiB5b3UgYXJlIGRvbmUgd2l0aCB0aGlzIGNodW5rLiAgSWYgeW91IHBhc3Ncbi8vIGFuIGVycm9yLCB0aGVuIHRoYXQnbGwgcHV0IHRoZSBodXJ0IG9uIHRoZSB3aG9sZSBvcGVyYXRpb24uICBJZiB5b3Vcbi8vIG5ldmVyIGNhbGwgY2IoKSwgdGhlbiB5b3UnbGwgbmV2ZXIgZ2V0IGFub3RoZXIgY2h1bmsuXG5UcmFuc2Zvcm0ucHJvdG90eXBlLl90cmFuc2Zvcm0gPSBmdW5jdGlvbihjaHVuaywgZW5jb2RpbmcsIGNiKSB7XG4gIHRocm93IG5ldyBFcnJvcignbm90IGltcGxlbWVudGVkJyk7XG59O1xuXG5UcmFuc2Zvcm0ucHJvdG90eXBlLl93cml0ZSA9IGZ1bmN0aW9uKGNodW5rLCBlbmNvZGluZywgY2IpIHtcbiAgdmFyIHRzID0gdGhpcy5fdHJhbnNmb3JtU3RhdGU7XG4gIHRzLndyaXRlY2IgPSBjYjtcbiAgdHMud3JpdGVjaHVuayA9IGNodW5rO1xuICB0cy53cml0ZWVuY29kaW5nID0gZW5jb2Rpbmc7XG4gIGlmICghdHMudHJhbnNmb3JtaW5nKSB7XG4gICAgdmFyIHJzID0gdGhpcy5fcmVhZGFibGVTdGF0ZTtcbiAgICBpZiAodHMubmVlZFRyYW5zZm9ybSB8fFxuICAgICAgICBycy5uZWVkUmVhZGFibGUgfHxcbiAgICAgICAgcnMubGVuZ3RoIDwgcnMuaGlnaFdhdGVyTWFyaylcbiAgICAgIHRoaXMuX3JlYWQocnMuaGlnaFdhdGVyTWFyayk7XG4gIH1cbn07XG5cbi8vIERvZXNuJ3QgbWF0dGVyIHdoYXQgdGhlIGFyZ3MgYXJlIGhlcmUuXG4vLyBfdHJhbnNmb3JtIGRvZXMgYWxsIHRoZSB3b3JrLlxuLy8gVGhhdCB3ZSBnb3QgaGVyZSBtZWFucyB0aGF0IHRoZSByZWFkYWJsZSBzaWRlIHdhbnRzIG1vcmUgZGF0YS5cblRyYW5zZm9ybS5wcm90b3R5cGUuX3JlYWQgPSBmdW5jdGlvbihuKSB7XG4gIHZhciB0cyA9IHRoaXMuX3RyYW5zZm9ybVN0YXRlO1xuXG4gIGlmICh0cy53cml0ZWNodW5rICE9PSBudWxsICYmIHRzLndyaXRlY2IgJiYgIXRzLnRyYW5zZm9ybWluZykge1xuICAgIHRzLnRyYW5zZm9ybWluZyA9IHRydWU7XG4gICAgdGhpcy5fdHJhbnNmb3JtKHRzLndyaXRlY2h1bmssIHRzLndyaXRlZW5jb2RpbmcsIHRzLmFmdGVyVHJhbnNmb3JtKTtcbiAgfSBlbHNlIHtcbiAgICAvLyBtYXJrIHRoYXQgd2UgbmVlZCBhIHRyYW5zZm9ybSwgc28gdGhhdCBhbnkgZGF0YSB0aGF0IGNvbWVzIGluXG4gICAgLy8gd2lsbCBnZXQgcHJvY2Vzc2VkLCBub3cgdGhhdCB3ZSd2ZSBhc2tlZCBmb3IgaXQuXG4gICAgdHMubmVlZFRyYW5zZm9ybSA9IHRydWU7XG4gIH1cbn07XG5cblxuZnVuY3Rpb24gZG9uZShzdHJlYW0sIGVyKSB7XG4gIGlmIChlcilcbiAgICByZXR1cm4gc3RyZWFtLmVtaXQoJ2Vycm9yJywgZXIpO1xuXG4gIC8vIGlmIHRoZXJlJ3Mgbm90aGluZyBpbiB0aGUgd3JpdGUgYnVmZmVyLCB0aGVuIHRoYXQgbWVhbnNcbiAgLy8gdGhhdCBub3RoaW5nIG1vcmUgd2lsbCBldmVyIGJlIHByb3ZpZGVkXG4gIHZhciB3cyA9IHN0cmVhbS5fd3JpdGFibGVTdGF0ZTtcbiAgdmFyIHRzID0gc3RyZWFtLl90cmFuc2Zvcm1TdGF0ZTtcblxuICBpZiAod3MubGVuZ3RoKVxuICAgIHRocm93IG5ldyBFcnJvcignY2FsbGluZyB0cmFuc2Zvcm0gZG9uZSB3aGVuIHdzLmxlbmd0aCAhPSAwJyk7XG5cbiAgaWYgKHRzLnRyYW5zZm9ybWluZylcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ2NhbGxpbmcgdHJhbnNmb3JtIGRvbmUgd2hlbiBzdGlsbCB0cmFuc2Zvcm1pbmcnKTtcblxuICByZXR1cm4gc3RyZWFtLnB1c2gobnVsbCk7XG59XG4iLCIvLyBBIGJpdCBzaW1wbGVyIHRoYW4gcmVhZGFibGUgc3RyZWFtcy5cbi8vIEltcGxlbWVudCBhbiBhc3luYyAuX3dyaXRlKGNodW5rLCBlbmNvZGluZywgY2IpLCBhbmQgaXQnbGwgaGFuZGxlIGFsbFxuLy8gdGhlIGRyYWluIGV2ZW50IGVtaXNzaW9uIGFuZCBidWZmZXJpbmcuXG5cbid1c2Ugc3RyaWN0JztcblxubW9kdWxlLmV4cG9ydHMgPSBXcml0YWJsZTtcblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciBwcm9jZXNzTmV4dFRpY2sgPSByZXF1aXJlKCdwcm9jZXNzLW5leHRpY2stYXJncycpO1xuLyo8L3JlcGxhY2VtZW50PiovXG5cblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciBCdWZmZXIgPSByZXF1aXJlKCdidWZmZXInKS5CdWZmZXI7XG4vKjwvcmVwbGFjZW1lbnQ+Ki9cblxuV3JpdGFibGUuV3JpdGFibGVTdGF0ZSA9IFdyaXRhYmxlU3RhdGU7XG5cblxuLyo8cmVwbGFjZW1lbnQ+Ki9cbnZhciB1dGlsID0gcmVxdWlyZSgnY29yZS11dGlsLWlzJyk7XG51dGlsLmluaGVyaXRzID0gcmVxdWlyZSgnaW5oZXJpdHMnKTtcbi8qPC9yZXBsYWNlbWVudD4qL1xuXG5cbi8qPHJlcGxhY2VtZW50PiovXG52YXIgaW50ZXJuYWxVdGlsID0ge1xuICBkZXByZWNhdGU6IHJlcXVpcmUoJ3V0aWwtZGVwcmVjYXRlJylcbn07XG4vKjwvcmVwbGFjZW1lbnQ+Ki9cblxuXG5cbi8qPHJlcGxhY2VtZW50PiovXG52YXIgU3RyZWFtO1xuKGZ1bmN0aW9uICgpe3RyeXtcbiAgU3RyZWFtID0gcmVxdWlyZSgnc3QnICsgJ3JlYW0nKTtcbn1jYXRjaChfKXt9ZmluYWxseXtcbiAgaWYgKCFTdHJlYW0pXG4gICAgU3RyZWFtID0gcmVxdWlyZSgnZXZlbnRzJykuRXZlbnRFbWl0dGVyO1xufX0oKSlcbi8qPC9yZXBsYWNlbWVudD4qL1xuXG52YXIgQnVmZmVyID0gcmVxdWlyZSgnYnVmZmVyJykuQnVmZmVyO1xuXG51dGlsLmluaGVyaXRzKFdyaXRhYmxlLCBTdHJlYW0pO1xuXG5mdW5jdGlvbiBub3AoKSB7fVxuXG5mdW5jdGlvbiBXcml0ZVJlcShjaHVuaywgZW5jb2RpbmcsIGNiKSB7XG4gIHRoaXMuY2h1bmsgPSBjaHVuaztcbiAgdGhpcy5lbmNvZGluZyA9IGVuY29kaW5nO1xuICB0aGlzLmNhbGxiYWNrID0gY2I7XG4gIHRoaXMubmV4dCA9IG51bGw7XG59XG5cbnZhciBEdXBsZXg7XG5mdW5jdGlvbiBXcml0YWJsZVN0YXRlKG9wdGlvbnMsIHN0cmVhbSkge1xuICBEdXBsZXggPSBEdXBsZXggfHwgcmVxdWlyZSgnLi9fc3RyZWFtX2R1cGxleCcpO1xuXG4gIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuXG4gIC8vIG9iamVjdCBzdHJlYW0gZmxhZyB0byBpbmRpY2F0ZSB3aGV0aGVyIG9yIG5vdCB0aGlzIHN0cmVhbVxuICAvLyBjb250YWlucyBidWZmZXJzIG9yIG9iamVjdHMuXG4gIHRoaXMub2JqZWN0TW9kZSA9ICEhb3B0aW9ucy5vYmplY3RNb2RlO1xuXG4gIGlmIChzdHJlYW0gaW5zdGFuY2VvZiBEdXBsZXgpXG4gICAgdGhpcy5vYmplY3RNb2RlID0gdGhpcy5vYmplY3RNb2RlIHx8ICEhb3B0aW9ucy53cml0YWJsZU9iamVjdE1vZGU7XG5cbiAgLy8gdGhlIHBvaW50IGF0IHdoaWNoIHdyaXRlKCkgc3RhcnRzIHJldHVybmluZyBmYWxzZVxuICAvLyBOb3RlOiAwIGlzIGEgdmFsaWQgdmFsdWUsIG1lYW5zIHRoYXQgd2UgYWx3YXlzIHJldHVybiBmYWxzZSBpZlxuICAvLyB0aGUgZW50aXJlIGJ1ZmZlciBpcyBub3QgZmx1c2hlZCBpbW1lZGlhdGVseSBvbiB3cml0ZSgpXG4gIHZhciBod20gPSBvcHRpb25zLmhpZ2hXYXRlck1hcms7XG4gIHZhciBkZWZhdWx0SHdtID0gdGhpcy5vYmplY3RNb2RlID8gMTYgOiAxNiAqIDEwMjQ7XG4gIHRoaXMuaGlnaFdhdGVyTWFyayA9IChod20gfHwgaHdtID09PSAwKSA/IGh3bSA6IGRlZmF1bHRId207XG5cbiAgLy8gY2FzdCB0byBpbnRzLlxuICB0aGlzLmhpZ2hXYXRlck1hcmsgPSB+fnRoaXMuaGlnaFdhdGVyTWFyaztcblxuICB0aGlzLm5lZWREcmFpbiA9IGZhbHNlO1xuICAvLyBhdCB0aGUgc3RhcnQgb2YgY2FsbGluZyBlbmQoKVxuICB0aGlzLmVuZGluZyA9IGZhbHNlO1xuICAvLyB3aGVuIGVuZCgpIGhhcyBiZWVuIGNhbGxlZCwgYW5kIHJldHVybmVkXG4gIHRoaXMuZW5kZWQgPSBmYWxzZTtcbiAgLy8gd2hlbiAnZmluaXNoJyBpcyBlbWl0dGVkXG4gIHRoaXMuZmluaXNoZWQgPSBmYWxzZTtcblxuICAvLyBzaG91bGQgd2UgZGVjb2RlIHN0cmluZ3MgaW50byBidWZmZXJzIGJlZm9yZSBwYXNzaW5nIHRvIF93cml0ZT9cbiAgLy8gdGhpcyBpcyBoZXJlIHNvIHRoYXQgc29tZSBub2RlLWNvcmUgc3RyZWFtcyBjYW4gb3B0aW1pemUgc3RyaW5nXG4gIC8vIGhhbmRsaW5nIGF0IGEgbG93ZXIgbGV2ZWwuXG4gIHZhciBub0RlY29kZSA9IG9wdGlvbnMuZGVjb2RlU3RyaW5ncyA9PT0gZmFsc2U7XG4gIHRoaXMuZGVjb2RlU3RyaW5ncyA9ICFub0RlY29kZTtcblxuICAvLyBDcnlwdG8gaXMga2luZCBvZiBvbGQgYW5kIGNydXN0eS4gIEhpc3RvcmljYWxseSwgaXRzIGRlZmF1bHQgc3RyaW5nXG4gIC8vIGVuY29kaW5nIGlzICdiaW5hcnknIHNvIHdlIGhhdmUgdG8gbWFrZSB0aGlzIGNvbmZpZ3VyYWJsZS5cbiAgLy8gRXZlcnl0aGluZyBlbHNlIGluIHRoZSB1bml2ZXJzZSB1c2VzICd1dGY4JywgdGhvdWdoLlxuICB0aGlzLmRlZmF1bHRFbmNvZGluZyA9IG9wdGlvbnMuZGVmYXVsdEVuY29kaW5nIHx8ICd1dGY4JztcblxuICAvLyBub3QgYW4gYWN0dWFsIGJ1ZmZlciB3ZSBrZWVwIHRyYWNrIG9mLCBidXQgYSBtZWFzdXJlbWVudFxuICAvLyBvZiBob3cgbXVjaCB3ZSdyZSB3YWl0aW5nIHRvIGdldCBwdXNoZWQgdG8gc29tZSB1bmRlcmx5aW5nXG4gIC8vIHNvY2tldCBvciBmaWxlLlxuICB0aGlzLmxlbmd0aCA9IDA7XG5cbiAgLy8gYSBmbGFnIHRvIHNlZSB3aGVuIHdlJ3JlIGluIHRoZSBtaWRkbGUgb2YgYSB3cml0ZS5cbiAgdGhpcy53cml0aW5nID0gZmFsc2U7XG5cbiAgLy8gd2hlbiB0cnVlIGFsbCB3cml0ZXMgd2lsbCBiZSBidWZmZXJlZCB1bnRpbCAudW5jb3JrKCkgY2FsbFxuICB0aGlzLmNvcmtlZCA9IDA7XG5cbiAgLy8gYSBmbGFnIHRvIGJlIGFibGUgdG8gdGVsbCBpZiB0aGUgb253cml0ZSBjYiBpcyBjYWxsZWQgaW1tZWRpYXRlbHksXG4gIC8vIG9yIG9uIGEgbGF0ZXIgdGljay4gIFdlIHNldCB0aGlzIHRvIHRydWUgYXQgZmlyc3QsIGJlY2F1c2UgYW55XG4gIC8vIGFjdGlvbnMgdGhhdCBzaG91bGRuJ3QgaGFwcGVuIHVudGlsIFwibGF0ZXJcIiBzaG91bGQgZ2VuZXJhbGx5IGFsc29cbiAgLy8gbm90IGhhcHBlbiBiZWZvcmUgdGhlIGZpcnN0IHdyaXRlIGNhbGwuXG4gIHRoaXMuc3luYyA9IHRydWU7XG5cbiAgLy8gYSBmbGFnIHRvIGtub3cgaWYgd2UncmUgcHJvY2Vzc2luZyBwcmV2aW91c2x5IGJ1ZmZlcmVkIGl0ZW1zLCB3aGljaFxuICAvLyBtYXkgY2FsbCB0aGUgX3dyaXRlKCkgY2FsbGJhY2sgaW4gdGhlIHNhbWUgdGljaywgc28gdGhhdCB3ZSBkb24ndFxuICAvLyBlbmQgdXAgaW4gYW4gb3ZlcmxhcHBlZCBvbndyaXRlIHNpdHVhdGlvbi5cbiAgdGhpcy5idWZmZXJQcm9jZXNzaW5nID0gZmFsc2U7XG5cbiAgLy8gdGhlIGNhbGxiYWNrIHRoYXQncyBwYXNzZWQgdG8gX3dyaXRlKGNodW5rLGNiKVxuICB0aGlzLm9ud3JpdGUgPSBmdW5jdGlvbihlcikge1xuICAgIG9ud3JpdGUoc3RyZWFtLCBlcik7XG4gIH07XG5cbiAgLy8gdGhlIGNhbGxiYWNrIHRoYXQgdGhlIHVzZXIgc3VwcGxpZXMgdG8gd3JpdGUoY2h1bmssZW5jb2RpbmcsY2IpXG4gIHRoaXMud3JpdGVjYiA9IG51bGw7XG5cbiAgLy8gdGhlIGFtb3VudCB0aGF0IGlzIGJlaW5nIHdyaXR0ZW4gd2hlbiBfd3JpdGUgaXMgY2FsbGVkLlxuICB0aGlzLndyaXRlbGVuID0gMDtcblxuICB0aGlzLmJ1ZmZlcmVkUmVxdWVzdCA9IG51bGw7XG4gIHRoaXMubGFzdEJ1ZmZlcmVkUmVxdWVzdCA9IG51bGw7XG5cbiAgLy8gbnVtYmVyIG9mIHBlbmRpbmcgdXNlci1zdXBwbGllZCB3cml0ZSBjYWxsYmFja3NcbiAgLy8gdGhpcyBtdXN0IGJlIDAgYmVmb3JlICdmaW5pc2gnIGNhbiBiZSBlbWl0dGVkXG4gIHRoaXMucGVuZGluZ2NiID0gMDtcblxuICAvLyBlbWl0IHByZWZpbmlzaCBpZiB0aGUgb25seSB0aGluZyB3ZSdyZSB3YWl0aW5nIGZvciBpcyBfd3JpdGUgY2JzXG4gIC8vIFRoaXMgaXMgcmVsZXZhbnQgZm9yIHN5bmNocm9ub3VzIFRyYW5zZm9ybSBzdHJlYW1zXG4gIHRoaXMucHJlZmluaXNoZWQgPSBmYWxzZTtcblxuICAvLyBUcnVlIGlmIHRoZSBlcnJvciB3YXMgYWxyZWFkeSBlbWl0dGVkIGFuZCBzaG91bGQgbm90IGJlIHRocm93biBhZ2FpblxuICB0aGlzLmVycm9yRW1pdHRlZCA9IGZhbHNlO1xufVxuXG5Xcml0YWJsZVN0YXRlLnByb3RvdHlwZS5nZXRCdWZmZXIgPSBmdW5jdGlvbiB3cml0YWJsZVN0YXRlR2V0QnVmZmVyKCkge1xuICB2YXIgY3VycmVudCA9IHRoaXMuYnVmZmVyZWRSZXF1ZXN0O1xuICB2YXIgb3V0ID0gW107XG4gIHdoaWxlIChjdXJyZW50KSB7XG4gICAgb3V0LnB1c2goY3VycmVudCk7XG4gICAgY3VycmVudCA9IGN1cnJlbnQubmV4dDtcbiAgfVxuICByZXR1cm4gb3V0O1xufTtcblxuKGZ1bmN0aW9uICgpe3RyeSB7XG5PYmplY3QuZGVmaW5lUHJvcGVydHkoV3JpdGFibGVTdGF0ZS5wcm90b3R5cGUsICdidWZmZXInLCB7XG4gIGdldDogaW50ZXJuYWxVdGlsLmRlcHJlY2F0ZShmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdGhpcy5nZXRCdWZmZXIoKTtcbiAgfSwgJ193cml0YWJsZVN0YXRlLmJ1ZmZlciBpcyBkZXByZWNhdGVkLiBVc2UgX3dyaXRhYmxlU3RhdGUuZ2V0QnVmZmVyICcgK1xuICAgICAnaW5zdGVhZC4nKVxufSk7XG59Y2F0Y2goXyl7fX0oKSk7XG5cblxudmFyIER1cGxleDtcbmZ1bmN0aW9uIFdyaXRhYmxlKG9wdGlvbnMpIHtcbiAgRHVwbGV4ID0gRHVwbGV4IHx8IHJlcXVpcmUoJy4vX3N0cmVhbV9kdXBsZXgnKTtcblxuICAvLyBXcml0YWJsZSBjdG9yIGlzIGFwcGxpZWQgdG8gRHVwbGV4ZXMsIHRob3VnaCB0aGV5J3JlIG5vdFxuICAvLyBpbnN0YW5jZW9mIFdyaXRhYmxlLCB0aGV5J3JlIGluc3RhbmNlb2YgUmVhZGFibGUuXG4gIGlmICghKHRoaXMgaW5zdGFuY2VvZiBXcml0YWJsZSkgJiYgISh0aGlzIGluc3RhbmNlb2YgRHVwbGV4KSlcbiAgICByZXR1cm4gbmV3IFdyaXRhYmxlKG9wdGlvbnMpO1xuXG4gIHRoaXMuX3dyaXRhYmxlU3RhdGUgPSBuZXcgV3JpdGFibGVTdGF0ZShvcHRpb25zLCB0aGlzKTtcblxuICAvLyBsZWdhY3kuXG4gIHRoaXMud3JpdGFibGUgPSB0cnVlO1xuXG4gIGlmIChvcHRpb25zKSB7XG4gICAgaWYgKHR5cGVvZiBvcHRpb25zLndyaXRlID09PSAnZnVuY3Rpb24nKVxuICAgICAgdGhpcy5fd3JpdGUgPSBvcHRpb25zLndyaXRlO1xuXG4gICAgaWYgKHR5cGVvZiBvcHRpb25zLndyaXRldiA9PT0gJ2Z1bmN0aW9uJylcbiAgICAgIHRoaXMuX3dyaXRldiA9IG9wdGlvbnMud3JpdGV2O1xuICB9XG5cbiAgU3RyZWFtLmNhbGwodGhpcyk7XG59XG5cbi8vIE90aGVyd2lzZSBwZW9wbGUgY2FuIHBpcGUgV3JpdGFibGUgc3RyZWFtcywgd2hpY2ggaXMganVzdCB3cm9uZy5cbldyaXRhYmxlLnByb3RvdHlwZS5waXBlID0gZnVuY3Rpb24oKSB7XG4gIHRoaXMuZW1pdCgnZXJyb3InLCBuZXcgRXJyb3IoJ0Nhbm5vdCBwaXBlLiBOb3QgcmVhZGFibGUuJykpO1xufTtcblxuXG5mdW5jdGlvbiB3cml0ZUFmdGVyRW5kKHN0cmVhbSwgY2IpIHtcbiAgdmFyIGVyID0gbmV3IEVycm9yKCd3cml0ZSBhZnRlciBlbmQnKTtcbiAgLy8gVE9ETzogZGVmZXIgZXJyb3IgZXZlbnRzIGNvbnNpc3RlbnRseSBldmVyeXdoZXJlLCBub3QganVzdCB0aGUgY2JcbiAgc3RyZWFtLmVtaXQoJ2Vycm9yJywgZXIpO1xuICBwcm9jZXNzTmV4dFRpY2soY2IsIGVyKTtcbn1cblxuLy8gSWYgd2UgZ2V0IHNvbWV0aGluZyB0aGF0IGlzIG5vdCBhIGJ1ZmZlciwgc3RyaW5nLCBudWxsLCBvciB1bmRlZmluZWQsXG4vLyBhbmQgd2UncmUgbm90IGluIG9iamVjdE1vZGUsIHRoZW4gdGhhdCdzIGFuIGVycm9yLlxuLy8gT3RoZXJ3aXNlIHN0cmVhbSBjaHVua3MgYXJlIGFsbCBjb25zaWRlcmVkIHRvIGJlIG9mIGxlbmd0aD0xLCBhbmQgdGhlXG4vLyB3YXRlcm1hcmtzIGRldGVybWluZSBob3cgbWFueSBvYmplY3RzIHRvIGtlZXAgaW4gdGhlIGJ1ZmZlciwgcmF0aGVyIHRoYW5cbi8vIGhvdyBtYW55IGJ5dGVzIG9yIGNoYXJhY3RlcnMuXG5mdW5jdGlvbiB2YWxpZENodW5rKHN0cmVhbSwgc3RhdGUsIGNodW5rLCBjYikge1xuICB2YXIgdmFsaWQgPSB0cnVlO1xuXG4gIGlmICghKEJ1ZmZlci5pc0J1ZmZlcihjaHVuaykpICYmXG4gICAgICB0eXBlb2YgY2h1bmsgIT09ICdzdHJpbmcnICYmXG4gICAgICBjaHVuayAhPT0gbnVsbCAmJlxuICAgICAgY2h1bmsgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgIXN0YXRlLm9iamVjdE1vZGUpIHtcbiAgICB2YXIgZXIgPSBuZXcgVHlwZUVycm9yKCdJbnZhbGlkIG5vbi1zdHJpbmcvYnVmZmVyIGNodW5rJyk7XG4gICAgc3RyZWFtLmVtaXQoJ2Vycm9yJywgZXIpO1xuICAgIHByb2Nlc3NOZXh0VGljayhjYiwgZXIpO1xuICAgIHZhbGlkID0gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHZhbGlkO1xufVxuXG5Xcml0YWJsZS5wcm90b3R5cGUud3JpdGUgPSBmdW5jdGlvbihjaHVuaywgZW5jb2RpbmcsIGNiKSB7XG4gIHZhciBzdGF0ZSA9IHRoaXMuX3dyaXRhYmxlU3RhdGU7XG4gIHZhciByZXQgPSBmYWxzZTtcblxuICBpZiAodHlwZW9mIGVuY29kaW5nID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2IgPSBlbmNvZGluZztcbiAgICBlbmNvZGluZyA9IG51bGw7XG4gIH1cblxuICBpZiAoQnVmZmVyLmlzQnVmZmVyKGNodW5rKSlcbiAgICBlbmNvZGluZyA9ICdidWZmZXInO1xuICBlbHNlIGlmICghZW5jb2RpbmcpXG4gICAgZW5jb2RpbmcgPSBzdGF0ZS5kZWZhdWx0RW5jb2Rpbmc7XG5cbiAgaWYgKHR5cGVvZiBjYiAhPT0gJ2Z1bmN0aW9uJylcbiAgICBjYiA9IG5vcDtcblxuICBpZiAoc3RhdGUuZW5kZWQpXG4gICAgd3JpdGVBZnRlckVuZCh0aGlzLCBjYik7XG4gIGVsc2UgaWYgKHZhbGlkQ2h1bmsodGhpcywgc3RhdGUsIGNodW5rLCBjYikpIHtcbiAgICBzdGF0ZS5wZW5kaW5nY2IrKztcbiAgICByZXQgPSB3cml0ZU9yQnVmZmVyKHRoaXMsIHN0YXRlLCBjaHVuaywgZW5jb2RpbmcsIGNiKTtcbiAgfVxuXG4gIHJldHVybiByZXQ7XG59O1xuXG5Xcml0YWJsZS5wcm90b3R5cGUuY29yayA9IGZ1bmN0aW9uKCkge1xuICB2YXIgc3RhdGUgPSB0aGlzLl93cml0YWJsZVN0YXRlO1xuXG4gIHN0YXRlLmNvcmtlZCsrO1xufTtcblxuV3JpdGFibGUucHJvdG90eXBlLnVuY29yayA9IGZ1bmN0aW9uKCkge1xuICB2YXIgc3RhdGUgPSB0aGlzLl93cml0YWJsZVN0YXRlO1xuXG4gIGlmIChzdGF0ZS5jb3JrZWQpIHtcbiAgICBzdGF0ZS5jb3JrZWQtLTtcblxuICAgIGlmICghc3RhdGUud3JpdGluZyAmJlxuICAgICAgICAhc3RhdGUuY29ya2VkICYmXG4gICAgICAgICFzdGF0ZS5maW5pc2hlZCAmJlxuICAgICAgICAhc3RhdGUuYnVmZmVyUHJvY2Vzc2luZyAmJlxuICAgICAgICBzdGF0ZS5idWZmZXJlZFJlcXVlc3QpXG4gICAgICBjbGVhckJ1ZmZlcih0aGlzLCBzdGF0ZSk7XG4gIH1cbn07XG5cbldyaXRhYmxlLnByb3RvdHlwZS5zZXREZWZhdWx0RW5jb2RpbmcgPSBmdW5jdGlvbiBzZXREZWZhdWx0RW5jb2RpbmcoZW5jb2RpbmcpIHtcbiAgLy8gbm9kZTo6UGFyc2VFbmNvZGluZygpIHJlcXVpcmVzIGxvd2VyIGNhc2UuXG4gIGlmICh0eXBlb2YgZW5jb2RpbmcgPT09ICdzdHJpbmcnKVxuICAgIGVuY29kaW5nID0gZW5jb2RpbmcudG9Mb3dlckNhc2UoKTtcbiAgaWYgKCEoWydoZXgnLCAndXRmOCcsICd1dGYtOCcsICdhc2NpaScsICdiaW5hcnknLCAnYmFzZTY0Jyxcbid1Y3MyJywgJ3Vjcy0yJywndXRmMTZsZScsICd1dGYtMTZsZScsICdyYXcnXVxuLmluZGV4T2YoKGVuY29kaW5nICsgJycpLnRvTG93ZXJDYXNlKCkpID4gLTEpKVxuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ1Vua25vd24gZW5jb2Rpbmc6ICcgKyBlbmNvZGluZyk7XG4gIHRoaXMuX3dyaXRhYmxlU3RhdGUuZGVmYXVsdEVuY29kaW5nID0gZW5jb2Rpbmc7XG59O1xuXG5mdW5jdGlvbiBkZWNvZGVDaHVuayhzdGF0ZSwgY2h1bmssIGVuY29kaW5nKSB7XG4gIGlmICghc3RhdGUub2JqZWN0TW9kZSAmJlxuICAgICAgc3RhdGUuZGVjb2RlU3RyaW5ncyAhPT0gZmFsc2UgJiZcbiAgICAgIHR5cGVvZiBjaHVuayA9PT0gJ3N0cmluZycpIHtcbiAgICBjaHVuayA9IG5ldyBCdWZmZXIoY2h1bmssIGVuY29kaW5nKTtcbiAgfVxuICByZXR1cm4gY2h1bms7XG59XG5cbi8vIGlmIHdlJ3JlIGFscmVhZHkgd3JpdGluZyBzb21ldGhpbmcsIHRoZW4ganVzdCBwdXQgdGhpc1xuLy8gaW4gdGhlIHF1ZXVlLCBhbmQgd2FpdCBvdXIgdHVybi4gIE90aGVyd2lzZSwgY2FsbCBfd3JpdGVcbi8vIElmIHdlIHJldHVybiBmYWxzZSwgdGhlbiB3ZSBuZWVkIGEgZHJhaW4gZXZlbnQsIHNvIHNldCB0aGF0IGZsYWcuXG5mdW5jdGlvbiB3cml0ZU9yQnVmZmVyKHN0cmVhbSwgc3RhdGUsIGNodW5rLCBlbmNvZGluZywgY2IpIHtcbiAgY2h1bmsgPSBkZWNvZGVDaHVuayhzdGF0ZSwgY2h1bmssIGVuY29kaW5nKTtcblxuICBpZiAoQnVmZmVyLmlzQnVmZmVyKGNodW5rKSlcbiAgICBlbmNvZGluZyA9ICdidWZmZXInO1xuICB2YXIgbGVuID0gc3RhdGUub2JqZWN0TW9kZSA/IDEgOiBjaHVuay5sZW5ndGg7XG5cbiAgc3RhdGUubGVuZ3RoICs9IGxlbjtcblxuICB2YXIgcmV0ID0gc3RhdGUubGVuZ3RoIDwgc3RhdGUuaGlnaFdhdGVyTWFyaztcbiAgLy8gd2UgbXVzdCBlbnN1cmUgdGhhdCBwcmV2aW91cyBuZWVkRHJhaW4gd2lsbCBub3QgYmUgcmVzZXQgdG8gZmFsc2UuXG4gIGlmICghcmV0KVxuICAgIHN0YXRlLm5lZWREcmFpbiA9IHRydWU7XG5cbiAgaWYgKHN0YXRlLndyaXRpbmcgfHwgc3RhdGUuY29ya2VkKSB7XG4gICAgdmFyIGxhc3QgPSBzdGF0ZS5sYXN0QnVmZmVyZWRSZXF1ZXN0O1xuICAgIHN0YXRlLmxhc3RCdWZmZXJlZFJlcXVlc3QgPSBuZXcgV3JpdGVSZXEoY2h1bmssIGVuY29kaW5nLCBjYik7XG4gICAgaWYgKGxhc3QpIHtcbiAgICAgIGxhc3QubmV4dCA9IHN0YXRlLmxhc3RCdWZmZXJlZFJlcXVlc3Q7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0YXRlLmJ1ZmZlcmVkUmVxdWVzdCA9IHN0YXRlLmxhc3RCdWZmZXJlZFJlcXVlc3Q7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGRvV3JpdGUoc3RyZWFtLCBzdGF0ZSwgZmFsc2UsIGxlbiwgY2h1bmssIGVuY29kaW5nLCBjYik7XG4gIH1cblxuICByZXR1cm4gcmV0O1xufVxuXG5mdW5jdGlvbiBkb1dyaXRlKHN0cmVhbSwgc3RhdGUsIHdyaXRldiwgbGVuLCBjaHVuaywgZW5jb2RpbmcsIGNiKSB7XG4gIHN0YXRlLndyaXRlbGVuID0gbGVuO1xuICBzdGF0ZS53cml0ZWNiID0gY2I7XG4gIHN0YXRlLndyaXRpbmcgPSB0cnVlO1xuICBzdGF0ZS5zeW5jID0gdHJ1ZTtcbiAgaWYgKHdyaXRldilcbiAgICBzdHJlYW0uX3dyaXRldihjaHVuaywgc3RhdGUub253cml0ZSk7XG4gIGVsc2VcbiAgICBzdHJlYW0uX3dyaXRlKGNodW5rLCBlbmNvZGluZywgc3RhdGUub253cml0ZSk7XG4gIHN0YXRlLnN5bmMgPSBmYWxzZTtcbn1cblxuZnVuY3Rpb24gb253cml0ZUVycm9yKHN0cmVhbSwgc3RhdGUsIHN5bmMsIGVyLCBjYikge1xuICAtLXN0YXRlLnBlbmRpbmdjYjtcbiAgaWYgKHN5bmMpXG4gICAgcHJvY2Vzc05leHRUaWNrKGNiLCBlcik7XG4gIGVsc2VcbiAgICBjYihlcik7XG5cbiAgc3RyZWFtLl93cml0YWJsZVN0YXRlLmVycm9yRW1pdHRlZCA9IHRydWU7XG4gIHN0cmVhbS5lbWl0KCdlcnJvcicsIGVyKTtcbn1cblxuZnVuY3Rpb24gb253cml0ZVN0YXRlVXBkYXRlKHN0YXRlKSB7XG4gIHN0YXRlLndyaXRpbmcgPSBmYWxzZTtcbiAgc3RhdGUud3JpdGVjYiA9IG51bGw7XG4gIHN0YXRlLmxlbmd0aCAtPSBzdGF0ZS53cml0ZWxlbjtcbiAgc3RhdGUud3JpdGVsZW4gPSAwO1xufVxuXG5mdW5jdGlvbiBvbndyaXRlKHN0cmVhbSwgZXIpIHtcbiAgdmFyIHN0YXRlID0gc3RyZWFtLl93cml0YWJsZVN0YXRlO1xuICB2YXIgc3luYyA9IHN0YXRlLnN5bmM7XG4gIHZhciBjYiA9IHN0YXRlLndyaXRlY2I7XG5cbiAgb253cml0ZVN0YXRlVXBkYXRlKHN0YXRlKTtcblxuICBpZiAoZXIpXG4gICAgb253cml0ZUVycm9yKHN0cmVhbSwgc3RhdGUsIHN5bmMsIGVyLCBjYik7XG4gIGVsc2Uge1xuICAgIC8vIENoZWNrIGlmIHdlJ3JlIGFjdHVhbGx5IHJlYWR5IHRvIGZpbmlzaCwgYnV0IGRvbid0IGVtaXQgeWV0XG4gICAgdmFyIGZpbmlzaGVkID0gbmVlZEZpbmlzaChzdGF0ZSk7XG5cbiAgICBpZiAoIWZpbmlzaGVkICYmXG4gICAgICAgICFzdGF0ZS5jb3JrZWQgJiZcbiAgICAgICAgIXN0YXRlLmJ1ZmZlclByb2Nlc3NpbmcgJiZcbiAgICAgICAgc3RhdGUuYnVmZmVyZWRSZXF1ZXN0KSB7XG4gICAgICBjbGVhckJ1ZmZlcihzdHJlYW0sIHN0YXRlKTtcbiAgICB9XG5cbiAgICBpZiAoc3luYykge1xuICAgICAgcHJvY2Vzc05leHRUaWNrKGFmdGVyV3JpdGUsIHN0cmVhbSwgc3RhdGUsIGZpbmlzaGVkLCBjYik7XG4gICAgfSBlbHNlIHtcbiAgICAgIGFmdGVyV3JpdGUoc3RyZWFtLCBzdGF0ZSwgZmluaXNoZWQsIGNiKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gYWZ0ZXJXcml0ZShzdHJlYW0sIHN0YXRlLCBmaW5pc2hlZCwgY2IpIHtcbiAgaWYgKCFmaW5pc2hlZClcbiAgICBvbndyaXRlRHJhaW4oc3RyZWFtLCBzdGF0ZSk7XG4gIHN0YXRlLnBlbmRpbmdjYi0tO1xuICBjYigpO1xuICBmaW5pc2hNYXliZShzdHJlYW0sIHN0YXRlKTtcbn1cblxuLy8gTXVzdCBmb3JjZSBjYWxsYmFjayB0byBiZSBjYWxsZWQgb24gbmV4dFRpY2ssIHNvIHRoYXQgd2UgZG9uJ3Rcbi8vIGVtaXQgJ2RyYWluJyBiZWZvcmUgdGhlIHdyaXRlKCkgY29uc3VtZXIgZ2V0cyB0aGUgJ2ZhbHNlJyByZXR1cm5cbi8vIHZhbHVlLCBhbmQgaGFzIGEgY2hhbmNlIHRvIGF0dGFjaCBhICdkcmFpbicgbGlzdGVuZXIuXG5mdW5jdGlvbiBvbndyaXRlRHJhaW4oc3RyZWFtLCBzdGF0ZSkge1xuICBpZiAoc3RhdGUubGVuZ3RoID09PSAwICYmIHN0YXRlLm5lZWREcmFpbikge1xuICAgIHN0YXRlLm5lZWREcmFpbiA9IGZhbHNlO1xuICAgIHN0cmVhbS5lbWl0KCdkcmFpbicpO1xuICB9XG59XG5cblxuLy8gaWYgdGhlcmUncyBzb21ldGhpbmcgaW4gdGhlIGJ1ZmZlciB3YWl0aW5nLCB0aGVuIHByb2Nlc3MgaXRcbmZ1bmN0aW9uIGNsZWFyQnVmZmVyKHN0cmVhbSwgc3RhdGUpIHtcbiAgc3RhdGUuYnVmZmVyUHJvY2Vzc2luZyA9IHRydWU7XG4gIHZhciBlbnRyeSA9IHN0YXRlLmJ1ZmZlcmVkUmVxdWVzdDtcblxuICBpZiAoc3RyZWFtLl93cml0ZXYgJiYgZW50cnkgJiYgZW50cnkubmV4dCkge1xuICAgIC8vIEZhc3QgY2FzZSwgd3JpdGUgZXZlcnl0aGluZyB1c2luZyBfd3JpdGV2KClcbiAgICB2YXIgYnVmZmVyID0gW107XG4gICAgdmFyIGNicyA9IFtdO1xuICAgIHdoaWxlIChlbnRyeSkge1xuICAgICAgY2JzLnB1c2goZW50cnkuY2FsbGJhY2spO1xuICAgICAgYnVmZmVyLnB1c2goZW50cnkpO1xuICAgICAgZW50cnkgPSBlbnRyeS5uZXh0O1xuICAgIH1cblxuICAgIC8vIGNvdW50IHRoZSBvbmUgd2UgYXJlIGFkZGluZywgYXMgd2VsbC5cbiAgICAvLyBUT0RPKGlzYWFjcykgY2xlYW4gdGhpcyB1cFxuICAgIHN0YXRlLnBlbmRpbmdjYisrO1xuICAgIHN0YXRlLmxhc3RCdWZmZXJlZFJlcXVlc3QgPSBudWxsO1xuICAgIGRvV3JpdGUoc3RyZWFtLCBzdGF0ZSwgdHJ1ZSwgc3RhdGUubGVuZ3RoLCBidWZmZXIsICcnLCBmdW5jdGlvbihlcnIpIHtcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgY2JzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHN0YXRlLnBlbmRpbmdjYi0tO1xuICAgICAgICBjYnNbaV0oZXJyKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIENsZWFyIGJ1ZmZlclxuICB9IGVsc2Uge1xuICAgIC8vIFNsb3cgY2FzZSwgd3JpdGUgY2h1bmtzIG9uZS1ieS1vbmVcbiAgICB3aGlsZSAoZW50cnkpIHtcbiAgICAgIHZhciBjaHVuayA9IGVudHJ5LmNodW5rO1xuICAgICAgdmFyIGVuY29kaW5nID0gZW50cnkuZW5jb2Rpbmc7XG4gICAgICB2YXIgY2IgPSBlbnRyeS5jYWxsYmFjaztcbiAgICAgIHZhciBsZW4gPSBzdGF0ZS5vYmplY3RNb2RlID8gMSA6IGNodW5rLmxlbmd0aDtcblxuICAgICAgZG9Xcml0ZShzdHJlYW0sIHN0YXRlLCBmYWxzZSwgbGVuLCBjaHVuaywgZW5jb2RpbmcsIGNiKTtcbiAgICAgIGVudHJ5ID0gZW50cnkubmV4dDtcbiAgICAgIC8vIGlmIHdlIGRpZG4ndCBjYWxsIHRoZSBvbndyaXRlIGltbWVkaWF0ZWx5LCB0aGVuXG4gICAgICAvLyBpdCBtZWFucyB0aGF0IHdlIG5lZWQgdG8gd2FpdCB1bnRpbCBpdCBkb2VzLlxuICAgICAgLy8gYWxzbywgdGhhdCBtZWFucyB0aGF0IHRoZSBjaHVuayBhbmQgY2IgYXJlIGN1cnJlbnRseVxuICAgICAgLy8gYmVpbmcgcHJvY2Vzc2VkLCBzbyBtb3ZlIHRoZSBidWZmZXIgY291bnRlciBwYXN0IHRoZW0uXG4gICAgICBpZiAoc3RhdGUud3JpdGluZykge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZW50cnkgPT09IG51bGwpXG4gICAgICBzdGF0ZS5sYXN0QnVmZmVyZWRSZXF1ZXN0ID0gbnVsbDtcbiAgfVxuICBzdGF0ZS5idWZmZXJlZFJlcXVlc3QgPSBlbnRyeTtcbiAgc3RhdGUuYnVmZmVyUHJvY2Vzc2luZyA9IGZhbHNlO1xufVxuXG5Xcml0YWJsZS5wcm90b3R5cGUuX3dyaXRlID0gZnVuY3Rpb24oY2h1bmssIGVuY29kaW5nLCBjYikge1xuICBjYihuZXcgRXJyb3IoJ25vdCBpbXBsZW1lbnRlZCcpKTtcbn07XG5cbldyaXRhYmxlLnByb3RvdHlwZS5fd3JpdGV2ID0gbnVsbDtcblxuV3JpdGFibGUucHJvdG90eXBlLmVuZCA9IGZ1bmN0aW9uKGNodW5rLCBlbmNvZGluZywgY2IpIHtcbiAgdmFyIHN0YXRlID0gdGhpcy5fd3JpdGFibGVTdGF0ZTtcblxuICBpZiAodHlwZW9mIGNodW5rID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2IgPSBjaHVuaztcbiAgICBjaHVuayA9IG51bGw7XG4gICAgZW5jb2RpbmcgPSBudWxsO1xuICB9IGVsc2UgaWYgKHR5cGVvZiBlbmNvZGluZyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNiID0gZW5jb2Rpbmc7XG4gICAgZW5jb2RpbmcgPSBudWxsO1xuICB9XG5cbiAgaWYgKGNodW5rICE9PSBudWxsICYmIGNodW5rICE9PSB1bmRlZmluZWQpXG4gICAgdGhpcy53cml0ZShjaHVuaywgZW5jb2RpbmcpO1xuXG4gIC8vIC5lbmQoKSBmdWxseSB1bmNvcmtzXG4gIGlmIChzdGF0ZS5jb3JrZWQpIHtcbiAgICBzdGF0ZS5jb3JrZWQgPSAxO1xuICAgIHRoaXMudW5jb3JrKCk7XG4gIH1cblxuICAvLyBpZ25vcmUgdW5uZWNlc3NhcnkgZW5kKCkgY2FsbHMuXG4gIGlmICghc3RhdGUuZW5kaW5nICYmICFzdGF0ZS5maW5pc2hlZClcbiAgICBlbmRXcml0YWJsZSh0aGlzLCBzdGF0ZSwgY2IpO1xufTtcblxuXG5mdW5jdGlvbiBuZWVkRmluaXNoKHN0YXRlKSB7XG4gIHJldHVybiAoc3RhdGUuZW5kaW5nICYmXG4gICAgICAgICAgc3RhdGUubGVuZ3RoID09PSAwICYmXG4gICAgICAgICAgc3RhdGUuYnVmZmVyZWRSZXF1ZXN0ID09PSBudWxsICYmXG4gICAgICAgICAgIXN0YXRlLmZpbmlzaGVkICYmXG4gICAgICAgICAgIXN0YXRlLndyaXRpbmcpO1xufVxuXG5mdW5jdGlvbiBwcmVmaW5pc2goc3RyZWFtLCBzdGF0ZSkge1xuICBpZiAoIXN0YXRlLnByZWZpbmlzaGVkKSB7XG4gICAgc3RhdGUucHJlZmluaXNoZWQgPSB0cnVlO1xuICAgIHN0cmVhbS5lbWl0KCdwcmVmaW5pc2gnKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaW5pc2hNYXliZShzdHJlYW0sIHN0YXRlKSB7XG4gIHZhciBuZWVkID0gbmVlZEZpbmlzaChzdGF0ZSk7XG4gIGlmIChuZWVkKSB7XG4gICAgaWYgKHN0YXRlLnBlbmRpbmdjYiA9PT0gMCkge1xuICAgICAgcHJlZmluaXNoKHN0cmVhbSwgc3RhdGUpO1xuICAgICAgc3RhdGUuZmluaXNoZWQgPSB0cnVlO1xuICAgICAgc3RyZWFtLmVtaXQoJ2ZpbmlzaCcpO1xuICAgIH0gZWxzZSB7XG4gICAgICBwcmVmaW5pc2goc3RyZWFtLCBzdGF0ZSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBuZWVkO1xufVxuXG5mdW5jdGlvbiBlbmRXcml0YWJsZShzdHJlYW0sIHN0YXRlLCBjYikge1xuICBzdGF0ZS5lbmRpbmcgPSB0cnVlO1xuICBmaW5pc2hNYXliZShzdHJlYW0sIHN0YXRlKTtcbiAgaWYgKGNiKSB7XG4gICAgaWYgKHN0YXRlLmZpbmlzaGVkKVxuICAgICAgcHJvY2Vzc05leHRUaWNrKGNiKTtcbiAgICBlbHNlXG4gICAgICBzdHJlYW0ub25jZSgnZmluaXNoJywgY2IpO1xuICB9XG4gIHN0YXRlLmVuZGVkID0gdHJ1ZTtcbn1cbiIsInZhciBTdHJlYW0gPSAoZnVuY3Rpb24gKCl7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlcXVpcmUoJ3N0JyArICdyZWFtJyk7IC8vIGhhY2sgdG8gZml4IGEgY2lyY3VsYXIgZGVwZW5kZW5jeSBpc3N1ZSB3aGVuIHVzZWQgd2l0aCBicm93c2VyaWZ5XG4gIH0gY2F0Y2goXyl7fVxufSgpKTtcbmV4cG9ydHMgPSBtb2R1bGUuZXhwb3J0cyA9IHJlcXVpcmUoJy4vbGliL19zdHJlYW1fcmVhZGFibGUuanMnKTtcbmV4cG9ydHMuU3RyZWFtID0gU3RyZWFtIHx8IGV4cG9ydHM7XG5leHBvcnRzLlJlYWRhYmxlID0gZXhwb3J0cztcbmV4cG9ydHMuV3JpdGFibGUgPSByZXF1aXJlKCcuL2xpYi9fc3RyZWFtX3dyaXRhYmxlLmpzJyk7XG5leHBvcnRzLkR1cGxleCA9IHJlcXVpcmUoJy4vbGliL19zdHJlYW1fZHVwbGV4LmpzJyk7XG5leHBvcnRzLlRyYW5zZm9ybSA9IHJlcXVpcmUoJy4vbGliL19zdHJlYW1fdHJhbnNmb3JtLmpzJyk7XG5leHBvcnRzLlBhc3NUaHJvdWdoID0gcmVxdWlyZSgnLi9saWIvX3N0cmVhbV9wYXNzdGhyb3VnaC5qcycpO1xuIiwiKGZ1bmN0aW9uIChCdWZmZXIpe1xubW9kdWxlLmV4cG9ydHMgPSBQZWVyXG5cbnZhciBkZWJ1ZyA9IHJlcXVpcmUoJ2RlYnVnJykoJ3NpbXBsZS1wZWVyJylcbnZhciBnZXRCcm93c2VyUlRDID0gcmVxdWlyZSgnZ2V0LWJyb3dzZXItcnRjJylcbnZhciBoYXQgPSByZXF1aXJlKCdoYXQnKVxudmFyIGluaGVyaXRzID0gcmVxdWlyZSgnaW5oZXJpdHMnKVxudmFyIG9uY2UgPSByZXF1aXJlKCdvbmNlJylcbnZhciBzdHJlYW0gPSByZXF1aXJlKCdyZWFkYWJsZS1zdHJlYW0nKVxuXG5pbmhlcml0cyhQZWVyLCBzdHJlYW0uRHVwbGV4KVxuXG4vKipcbiAqIFdlYlJUQyBwZWVyIGNvbm5lY3Rpb24uIFNhbWUgQVBJIGFzIG5vZGUgY29yZSBgbmV0LlNvY2tldGAsIHBsdXMgYSBmZXcgZXh0cmEgbWV0aG9kcy5cbiAqIER1cGxleCBzdHJlYW0uXG4gKiBAcGFyYW0ge09iamVjdH0gb3B0c1xuICovXG5mdW5jdGlvbiBQZWVyIChvcHRzKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBpZiAoIShzZWxmIGluc3RhbmNlb2YgUGVlcikpIHJldHVybiBuZXcgUGVlcihvcHRzKVxuICBzZWxmLl9kZWJ1ZygnbmV3IHBlZXIgJW8nLCBvcHRzKVxuXG4gIGlmICghb3B0cykgb3B0cyA9IHt9XG4gIG9wdHMuYWxsb3dIYWxmT3BlbiA9IGZhbHNlXG4gIGlmIChvcHRzLmhpZ2hXYXRlck1hcmsgPT0gbnVsbCkgb3B0cy5oaWdoV2F0ZXJNYXJrID0gMTAyNCAqIDEwMjRcblxuICBzdHJlYW0uRHVwbGV4LmNhbGwoc2VsZiwgb3B0cylcblxuICBzZWxmLmluaXRpYXRvciA9IG9wdHMuaW5pdGlhdG9yIHx8IGZhbHNlXG4gIHNlbGYuY2hhbm5lbENvbmZpZyA9IG9wdHMuY2hhbm5lbENvbmZpZyB8fCBQZWVyLmNoYW5uZWxDb25maWdcbiAgc2VsZi5jaGFubmVsTmFtZSA9IG9wdHMuaW5pdGlhdG9yID8gKG9wdHMuY2hhbm5lbE5hbWUgfHwgaGF0KDE2MCkpIDogbnVsbFxuICBzZWxmLmNvbmZpZyA9IG9wdHMuY29uZmlnIHx8IFBlZXIuY29uZmlnXG4gIHNlbGYuY29uc3RyYWludHMgPSBvcHRzLmNvbnN0cmFpbnRzIHx8IFBlZXIuY29uc3RyYWludHNcbiAgc2VsZi5vZmZlckNvbnN0cmFpbnRzID0gb3B0cy5vZmZlckNvbnN0cmFpbnRzXG4gIHNlbGYuYW5zd2VyQ29uc3RyYWludHMgPSBvcHRzLmFuc3dlckNvbnN0cmFpbnRzXG4gIHNlbGYucmVjb25uZWN0VGltZXIgPSBvcHRzLnJlY29ubmVjdFRpbWVyIHx8IGZhbHNlXG4gIHNlbGYuc2RwVHJhbnNmb3JtID0gb3B0cy5zZHBUcmFuc2Zvcm0gfHwgZnVuY3Rpb24gKHNkcCkgeyByZXR1cm4gc2RwIH1cbiAgc2VsZi5zdHJlYW0gPSBvcHRzLnN0cmVhbSB8fCBmYWxzZVxuICBzZWxmLnRyaWNrbGUgPSBvcHRzLnRyaWNrbGUgIT09IHVuZGVmaW5lZCA/IG9wdHMudHJpY2tsZSA6IHRydWVcblxuICBzZWxmLmRlc3Ryb3llZCA9IGZhbHNlXG4gIHNlbGYuY29ubmVjdGVkID0gZmFsc2VcblxuICAvLyBzbyBQZWVyIG9iamVjdCBhbHdheXMgaGFzIHNhbWUgc2hhcGUgKFY4IG9wdGltaXphdGlvbilcbiAgc2VsZi5yZW1vdGVBZGRyZXNzID0gdW5kZWZpbmVkXG4gIHNlbGYucmVtb3RlRmFtaWx5ID0gdW5kZWZpbmVkXG4gIHNlbGYucmVtb3RlUG9ydCA9IHVuZGVmaW5lZFxuICBzZWxmLmxvY2FsQWRkcmVzcyA9IHVuZGVmaW5lZFxuICBzZWxmLmxvY2FsUG9ydCA9IHVuZGVmaW5lZFxuXG4gIHNlbGYuX2lzV3J0YyA9ICEhb3B0cy53cnRjIC8vIEhBQ0s6IHRvIGZpeCBgd3J0Y2AgYnVnLiBTZWUgaXNzdWU6ICM2MFxuICBzZWxmLl93cnRjID0gb3B0cy53cnRjIHx8IGdldEJyb3dzZXJSVEMoKVxuICBpZiAoIXNlbGYuX3dydGMpIHtcbiAgICBpZiAodHlwZW9mIHdpbmRvdyA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignTm8gV2ViUlRDIHN1cHBvcnQ6IFNwZWNpZnkgYG9wdHMud3J0Y2Agb3B0aW9uIGluIHRoaXMgZW52aXJvbm1lbnQnKVxuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vIFdlYlJUQyBzdXBwb3J0OiBOb3QgYSBzdXBwb3J0ZWQgYnJvd3NlcicpXG4gICAgfVxuICB9XG5cbiAgc2VsZi5fbWF4QnVmZmVyZWRBbW91bnQgPSBvcHRzLmhpZ2hXYXRlck1hcmtcbiAgc2VsZi5fcGNSZWFkeSA9IGZhbHNlXG4gIHNlbGYuX2NoYW5uZWxSZWFkeSA9IGZhbHNlXG4gIHNlbGYuX2ljZUNvbXBsZXRlID0gZmFsc2UgLy8gaWNlIGNhbmRpZGF0ZSB0cmlja2xlIGRvbmUgKGdvdCBudWxsIGNhbmRpZGF0ZSlcbiAgc2VsZi5fY2hhbm5lbCA9IG51bGxcbiAgc2VsZi5fcGVuZGluZ0NhbmRpZGF0ZXMgPSBbXVxuXG4gIHNlbGYuX2NodW5rID0gbnVsbFxuICBzZWxmLl9jYiA9IG51bGxcbiAgc2VsZi5faW50ZXJ2YWwgPSBudWxsXG4gIHNlbGYuX3JlY29ubmVjdFRpbWVvdXQgPSBudWxsXG5cbiAgc2VsZi5fcGMgPSBuZXcgKHNlbGYuX3dydGMuUlRDUGVlckNvbm5lY3Rpb24pKHNlbGYuY29uZmlnLCBzZWxmLmNvbnN0cmFpbnRzKVxuICBzZWxmLl9wYy5vbmljZWNvbm5lY3Rpb25zdGF0ZWNoYW5nZSA9IHNlbGYuX29uSWNlQ29ubmVjdGlvblN0YXRlQ2hhbmdlLmJpbmQoc2VsZilcbiAgc2VsZi5fcGMub25zaWduYWxpbmdzdGF0ZWNoYW5nZSA9IHNlbGYuX29uU2lnbmFsaW5nU3RhdGVDaGFuZ2UuYmluZChzZWxmKVxuICBzZWxmLl9wYy5vbmljZWNhbmRpZGF0ZSA9IHNlbGYuX29uSWNlQ2FuZGlkYXRlLmJpbmQoc2VsZilcblxuICBpZiAoc2VsZi5zdHJlYW0pIHNlbGYuX3BjLmFkZFN0cmVhbShzZWxmLnN0cmVhbSlcbiAgc2VsZi5fcGMub25hZGRzdHJlYW0gPSBzZWxmLl9vbkFkZFN0cmVhbS5iaW5kKHNlbGYpXG5cbiAgaWYgKHNlbGYuaW5pdGlhdG9yKSB7XG4gICAgc2VsZi5fc2V0dXBEYXRhKHsgY2hhbm5lbDogc2VsZi5fcGMuY3JlYXRlRGF0YUNoYW5uZWwoc2VsZi5jaGFubmVsTmFtZSwgc2VsZi5jaGFubmVsQ29uZmlnKSB9KVxuICAgIHNlbGYuX3BjLm9ubmVnb3RpYXRpb25uZWVkZWQgPSBvbmNlKHNlbGYuX2NyZWF0ZU9mZmVyLmJpbmQoc2VsZikpXG4gICAgLy8gT25seSBDaHJvbWUgdHJpZ2dlcnMgXCJuZWdvdGlhdGlvbm5lZWRlZFwiOyB0aGlzIGlzIGEgd29ya2Fyb3VuZCBmb3Igb3RoZXJcbiAgICAvLyBpbXBsZW1lbnRhdGlvbnNcbiAgICBpZiAodHlwZW9mIHdpbmRvdyA9PT0gJ3VuZGVmaW5lZCcgfHwgIXdpbmRvdy53ZWJraXRSVENQZWVyQ29ubmVjdGlvbikge1xuICAgICAgc2VsZi5fcGMub25uZWdvdGlhdGlvbm5lZWRlZCgpXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHNlbGYuX3BjLm9uZGF0YWNoYW5uZWwgPSBzZWxmLl9zZXR1cERhdGEuYmluZChzZWxmKVxuICB9XG5cbiAgc2VsZi5vbignZmluaXNoJywgZnVuY3Rpb24gKCkge1xuICAgIGlmIChzZWxmLmNvbm5lY3RlZCkge1xuICAgICAgLy8gV2hlbiBsb2NhbCBwZWVyIGlzIGZpbmlzaGVkIHdyaXRpbmcsIGNsb3NlIGNvbm5lY3Rpb24gdG8gcmVtb3RlIHBlZXIuXG4gICAgICAvLyBIYWxmIG9wZW4gY29ubmVjdGlvbnMgYXJlIGN1cnJlbnRseSBub3Qgc3VwcG9ydGVkLlxuICAgICAgLy8gV2FpdCBhIGJpdCBiZWZvcmUgZGVzdHJveWluZyBzbyB0aGUgZGF0YWNoYW5uZWwgZmx1c2hlcy5cbiAgICAgIC8vIFRPRE86IGlzIHRoZXJlIGEgbW9yZSByZWxpYWJsZSB3YXkgdG8gYWNjb21wbGlzaCB0aGlzP1xuICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgIHNlbGYuX2Rlc3Ryb3koKVxuICAgICAgfSwgMTAwKVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBJZiBkYXRhIGNoYW5uZWwgaXMgbm90IGNvbm5lY3RlZCB3aGVuIGxvY2FsIHBlZXIgaXMgZmluaXNoZWQgd3JpdGluZywgd2FpdCB1bnRpbFxuICAgICAgLy8gZGF0YSBpcyBmbHVzaGVkIHRvIG5ldHdvcmsgYXQgXCJjb25uZWN0XCIgZXZlbnQuXG4gICAgICAvLyBUT0RPOiBpcyB0aGVyZSBhIG1vcmUgcmVsaWFibGUgd2F5IHRvIGFjY29tcGxpc2ggdGhpcz9cbiAgICAgIHNlbGYub25jZSgnY29ubmVjdCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgc2VsZi5fZGVzdHJveSgpXG4gICAgICAgIH0sIDEwMClcbiAgICAgIH0pXG4gICAgfVxuICB9KVxufVxuXG5QZWVyLldFQlJUQ19TVVBQT1JUID0gISFnZXRCcm93c2VyUlRDKClcblxuLyoqXG4gKiBFeHBvc2UgY29uZmlnLCBjb25zdHJhaW50cywgYW5kIGRhdGEgY2hhbm5lbCBjb25maWcgZm9yIG92ZXJyaWRpbmcgYWxsIFBlZXJcbiAqIGluc3RhbmNlcy4gT3RoZXJ3aXNlLCBqdXN0IHNldCBvcHRzLmNvbmZpZywgb3B0cy5jb25zdHJhaW50cywgb3Igb3B0cy5jaGFubmVsQ29uZmlnXG4gKiB3aGVuIGNvbnN0cnVjdGluZyBhIFBlZXIuXG4gKi9cblBlZXIuY29uZmlnID0ge1xuICBpY2VTZXJ2ZXJzOiBbXG4gICAge1xuICAgICAgdXJsOiAnc3R1bjoyMy4yMS4xNTAuMTIxJywgLy8gZGVwcmVjYXRlZCwgcmVwbGFjZWQgYnkgYHVybHNgXG4gICAgICB1cmxzOiAnc3R1bjoyMy4yMS4xNTAuMTIxJ1xuICAgIH1cbiAgXVxufVxuUGVlci5jb25zdHJhaW50cyA9IHt9XG5QZWVyLmNoYW5uZWxDb25maWcgPSB7fVxuXG5PYmplY3QuZGVmaW5lUHJvcGVydHkoUGVlci5wcm90b3R5cGUsICdidWZmZXJTaXplJywge1xuICBnZXQ6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXNcbiAgICByZXR1cm4gKHNlbGYuX2NoYW5uZWwgJiYgc2VsZi5fY2hhbm5lbC5idWZmZXJlZEFtb3VudCkgfHwgMFxuICB9XG59KVxuXG5QZWVyLnByb3RvdHlwZS5hZGRyZXNzID0gZnVuY3Rpb24gKCkge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgcmV0dXJuIHsgcG9ydDogc2VsZi5sb2NhbFBvcnQsIGZhbWlseTogJ0lQdjQnLCBhZGRyZXNzOiBzZWxmLmxvY2FsQWRkcmVzcyB9XG59XG5cblBlZXIucHJvdG90eXBlLnNpZ25hbCA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBpZiAoc2VsZi5kZXN0cm95ZWQpIHRocm93IG5ldyBFcnJvcignY2Fubm90IHNpZ25hbCBhZnRlciBwZWVyIGlzIGRlc3Ryb3llZCcpXG4gIGlmICh0eXBlb2YgZGF0YSA9PT0gJ3N0cmluZycpIHtcbiAgICB0cnkge1xuICAgICAgZGF0YSA9IEpTT04ucGFyc2UoZGF0YSlcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGRhdGEgPSB7fVxuICAgIH1cbiAgfVxuICBzZWxmLl9kZWJ1Zygnc2lnbmFsKCknKVxuXG4gIGZ1bmN0aW9uIGFkZEljZUNhbmRpZGF0ZSAoY2FuZGlkYXRlKSB7XG4gICAgdHJ5IHtcbiAgICAgIHNlbGYuX3BjLmFkZEljZUNhbmRpZGF0ZShcbiAgICAgICAgbmV3IHNlbGYuX3dydGMuUlRDSWNlQ2FuZGlkYXRlKGNhbmRpZGF0ZSksIG5vb3AsIHNlbGYuX29uRXJyb3IuYmluZChzZWxmKVxuICAgICAgKVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgc2VsZi5fZGVzdHJveShuZXcgRXJyb3IoJ2Vycm9yIGFkZGluZyBjYW5kaWRhdGU6ICcgKyBlcnIubWVzc2FnZSkpXG4gICAgfVxuICB9XG5cbiAgaWYgKGRhdGEuc2RwKSB7XG4gICAgc2VsZi5fcGMuc2V0UmVtb3RlRGVzY3JpcHRpb24obmV3IChzZWxmLl93cnRjLlJUQ1Nlc3Npb25EZXNjcmlwdGlvbikoZGF0YSksIGZ1bmN0aW9uICgpIHtcbiAgICAgIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG4gICAgICBpZiAoc2VsZi5fcGMucmVtb3RlRGVzY3JpcHRpb24udHlwZSA9PT0gJ29mZmVyJykgc2VsZi5fY3JlYXRlQW5zd2VyKClcblxuICAgICAgc2VsZi5fcGVuZGluZ0NhbmRpZGF0ZXMuZm9yRWFjaChhZGRJY2VDYW5kaWRhdGUpXG4gICAgICBzZWxmLl9wZW5kaW5nQ2FuZGlkYXRlcyA9IFtdXG4gICAgfSwgc2VsZi5fb25FcnJvci5iaW5kKHNlbGYpKVxuICB9XG4gIGlmIChkYXRhLmNhbmRpZGF0ZSkge1xuICAgIGlmIChzZWxmLl9wYy5yZW1vdGVEZXNjcmlwdGlvbikgYWRkSWNlQ2FuZGlkYXRlKGRhdGEuY2FuZGlkYXRlKVxuICAgIGVsc2Ugc2VsZi5fcGVuZGluZ0NhbmRpZGF0ZXMucHVzaChkYXRhLmNhbmRpZGF0ZSlcbiAgfVxuICBpZiAoIWRhdGEuc2RwICYmICFkYXRhLmNhbmRpZGF0ZSkge1xuICAgIHNlbGYuX2Rlc3Ryb3kobmV3IEVycm9yKCdzaWduYWwoKSBjYWxsZWQgd2l0aCBpbnZhbGlkIHNpZ25hbCBkYXRhJykpXG4gIH1cbn1cblxuLyoqXG4gKiBTZW5kIHRleHQvYmluYXJ5IGRhdGEgdG8gdGhlIHJlbW90ZSBwZWVyLlxuICogQHBhcmFtIHtUeXBlZEFycmF5Vmlld3xBcnJheUJ1ZmZlcnxCdWZmZXJ8c3RyaW5nfEJsb2J8T2JqZWN0fSBjaHVua1xuICovXG5QZWVyLnByb3RvdHlwZS5zZW5kID0gZnVuY3Rpb24gKGNodW5rKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuXG4gIC8vIEhBQ0s6IGB3cnRjYCBtb2R1bGUgZG9lc24ndCBhY2NlcHQgbm9kZS5qcyBidWZmZXIuIFNlZSBpc3N1ZTogIzYwXG4gIGlmIChCdWZmZXIuaXNCdWZmZXIoY2h1bmspICYmIHNlbGYuX2lzV3J0Yykge1xuICAgIGNodW5rID0gbmV3IFVpbnQ4QXJyYXkoY2h1bmspXG4gIH1cblxuICB2YXIgbGVuID0gY2h1bmsubGVuZ3RoIHx8IGNodW5rLmJ5dGVMZW5ndGggfHwgY2h1bmsuc2l6ZVxuICBzZWxmLl9jaGFubmVsLnNlbmQoY2h1bmspXG4gIHNlbGYuX2RlYnVnKCd3cml0ZTogJWQgYnl0ZXMnLCBsZW4pXG59XG5cblBlZXIucHJvdG90eXBlLmRlc3Ryb3kgPSBmdW5jdGlvbiAob25jbG9zZSkge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgc2VsZi5fZGVzdHJveShudWxsLCBvbmNsb3NlKVxufVxuXG5QZWVyLnByb3RvdHlwZS5fZGVzdHJveSA9IGZ1bmN0aW9uIChlcnIsIG9uY2xvc2UpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG4gIGlmIChvbmNsb3NlKSBzZWxmLm9uY2UoJ2Nsb3NlJywgb25jbG9zZSlcblxuICBzZWxmLl9kZWJ1ZygnZGVzdHJveSAoZXJyb3I6ICVzKScsIGVyciAmJiBlcnIubWVzc2FnZSlcblxuICBzZWxmLnJlYWRhYmxlID0gc2VsZi53cml0YWJsZSA9IGZhbHNlXG5cbiAgaWYgKCFzZWxmLl9yZWFkYWJsZVN0YXRlLmVuZGVkKSBzZWxmLnB1c2gobnVsbClcbiAgaWYgKCFzZWxmLl93cml0YWJsZVN0YXRlLmZpbmlzaGVkKSBzZWxmLmVuZCgpXG5cbiAgc2VsZi5kZXN0cm95ZWQgPSB0cnVlXG4gIHNlbGYuY29ubmVjdGVkID0gZmFsc2VcbiAgc2VsZi5fcGNSZWFkeSA9IGZhbHNlXG4gIHNlbGYuX2NoYW5uZWxSZWFkeSA9IGZhbHNlXG5cbiAgc2VsZi5fY2h1bmsgPSBudWxsXG4gIHNlbGYuX2NiID0gbnVsbFxuICBjbGVhckludGVydmFsKHNlbGYuX2ludGVydmFsKVxuICBjbGVhclRpbWVvdXQoc2VsZi5fcmVjb25uZWN0VGltZW91dClcblxuICBpZiAoc2VsZi5fcGMpIHtcbiAgICB0cnkge1xuICAgICAgc2VsZi5fcGMuY2xvc2UoKVxuICAgIH0gY2F0Y2ggKGVycikge31cblxuICAgIHNlbGYuX3BjLm9uaWNlY29ubmVjdGlvbnN0YXRlY2hhbmdlID0gbnVsbFxuICAgIHNlbGYuX3BjLm9uc2lnbmFsaW5nc3RhdGVjaGFuZ2UgPSBudWxsXG4gICAgc2VsZi5fcGMub25pY2VjYW5kaWRhdGUgPSBudWxsXG4gIH1cblxuICBpZiAoc2VsZi5fY2hhbm5lbCkge1xuICAgIHRyeSB7XG4gICAgICBzZWxmLl9jaGFubmVsLmNsb3NlKClcbiAgICB9IGNhdGNoIChlcnIpIHt9XG5cbiAgICBzZWxmLl9jaGFubmVsLm9ubWVzc2FnZSA9IG51bGxcbiAgICBzZWxmLl9jaGFubmVsLm9ub3BlbiA9IG51bGxcbiAgICBzZWxmLl9jaGFubmVsLm9uY2xvc2UgPSBudWxsXG4gIH1cbiAgc2VsZi5fcGMgPSBudWxsXG4gIHNlbGYuX2NoYW5uZWwgPSBudWxsXG5cbiAgaWYgKGVycikgc2VsZi5lbWl0KCdlcnJvcicsIGVycilcbiAgc2VsZi5lbWl0KCdjbG9zZScpXG59XG5cblBlZXIucHJvdG90eXBlLl9zZXR1cERhdGEgPSBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIHNlbGYuX2NoYW5uZWwgPSBldmVudC5jaGFubmVsXG4gIHNlbGYuY2hhbm5lbE5hbWUgPSBzZWxmLl9jaGFubmVsLmxhYmVsXG5cbiAgc2VsZi5fY2hhbm5lbC5iaW5hcnlUeXBlID0gJ2FycmF5YnVmZmVyJ1xuICBzZWxmLl9jaGFubmVsLm9ubWVzc2FnZSA9IHNlbGYuX29uQ2hhbm5lbE1lc3NhZ2UuYmluZChzZWxmKVxuICBzZWxmLl9jaGFubmVsLm9ub3BlbiA9IHNlbGYuX29uQ2hhbm5lbE9wZW4uYmluZChzZWxmKVxuICBzZWxmLl9jaGFubmVsLm9uY2xvc2UgPSBzZWxmLl9vbkNoYW5uZWxDbG9zZS5iaW5kKHNlbGYpXG59XG5cblBlZXIucHJvdG90eXBlLl9yZWFkID0gZnVuY3Rpb24gKCkge31cblxuUGVlci5wcm90b3R5cGUuX3dyaXRlID0gZnVuY3Rpb24gKGNodW5rLCBlbmNvZGluZywgY2IpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuIGNiKG5ldyBFcnJvcignY2Fubm90IHdyaXRlIGFmdGVyIHBlZXIgaXMgZGVzdHJveWVkJykpXG5cbiAgaWYgKHNlbGYuY29ubmVjdGVkKSB7XG4gICAgdHJ5IHtcbiAgICAgIHNlbGYuc2VuZChjaHVuaylcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiBzZWxmLl9vbkVycm9yKGVycilcbiAgICB9XG4gICAgaWYgKHNlbGYuX2NoYW5uZWwuYnVmZmVyZWRBbW91bnQgPiBzZWxmLl9tYXhCdWZmZXJlZEFtb3VudCkge1xuICAgICAgc2VsZi5fZGVidWcoJ3N0YXJ0IGJhY2twcmVzc3VyZTogYnVmZmVyZWRBbW91bnQgJWQnLCBzZWxmLl9jaGFubmVsLmJ1ZmZlcmVkQW1vdW50KVxuICAgICAgc2VsZi5fY2IgPSBjYlxuICAgIH0gZWxzZSB7XG4gICAgICBjYihudWxsKVxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBzZWxmLl9kZWJ1Zygnd3JpdGUgYmVmb3JlIGNvbm5lY3QnKVxuICAgIHNlbGYuX2NodW5rID0gY2h1bmtcbiAgICBzZWxmLl9jYiA9IGNiXG4gIH1cbn1cblxuUGVlci5wcm90b3R5cGUuX2NyZWF0ZU9mZmVyID0gZnVuY3Rpb24gKCkge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgaWYgKHNlbGYuZGVzdHJveWVkKSByZXR1cm5cblxuICBzZWxmLl9wYy5jcmVhdGVPZmZlcihmdW5jdGlvbiAob2ZmZXIpIHtcbiAgICBpZiAoc2VsZi5kZXN0cm95ZWQpIHJldHVyblxuICAgIG9mZmVyLnNkcCA9IHNlbGYuc2RwVHJhbnNmb3JtKG9mZmVyLnNkcClcbiAgICBzZWxmLl9wYy5zZXRMb2NhbERlc2NyaXB0aW9uKG9mZmVyLCBub29wLCBzZWxmLl9vbkVycm9yLmJpbmQoc2VsZikpXG4gICAgdmFyIHNlbmRPZmZlciA9IGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBzaWduYWwgPSBzZWxmLl9wYy5sb2NhbERlc2NyaXB0aW9uIHx8IG9mZmVyXG4gICAgICBzZWxmLl9kZWJ1Zygnc2lnbmFsJylcbiAgICAgIHNlbGYuZW1pdCgnc2lnbmFsJywge1xuICAgICAgICB0eXBlOiBzaWduYWwudHlwZSxcbiAgICAgICAgc2RwOiBzaWduYWwuc2RwXG4gICAgICB9KVxuICAgIH1cbiAgICBpZiAoc2VsZi50cmlja2xlIHx8IHNlbGYuX2ljZUNvbXBsZXRlKSBzZW5kT2ZmZXIoKVxuICAgIGVsc2Ugc2VsZi5vbmNlKCdfaWNlQ29tcGxldGUnLCBzZW5kT2ZmZXIpIC8vIHdhaXQgZm9yIGNhbmRpZGF0ZXNcbiAgfSwgc2VsZi5fb25FcnJvci5iaW5kKHNlbGYpLCBzZWxmLm9mZmVyQ29uc3RyYWludHMpXG59XG5cblBlZXIucHJvdG90eXBlLl9jcmVhdGVBbnN3ZXIgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBpZiAoc2VsZi5kZXN0cm95ZWQpIHJldHVyblxuXG4gIHNlbGYuX3BjLmNyZWF0ZUFuc3dlcihmdW5jdGlvbiAoYW5zd2VyKSB7XG4gICAgaWYgKHNlbGYuZGVzdHJveWVkKSByZXR1cm5cbiAgICBhbnN3ZXIuc2RwID0gc2VsZi5zZHBUcmFuc2Zvcm0oYW5zd2VyLnNkcClcbiAgICBzZWxmLl9wYy5zZXRMb2NhbERlc2NyaXB0aW9uKGFuc3dlciwgbm9vcCwgc2VsZi5fb25FcnJvci5iaW5kKHNlbGYpKVxuICAgIHZhciBzZW5kQW5zd2VyID0gZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIHNpZ25hbCA9IHNlbGYuX3BjLmxvY2FsRGVzY3JpcHRpb24gfHwgYW5zd2VyXG4gICAgICBzZWxmLl9kZWJ1Zygnc2lnbmFsJylcbiAgICAgIHNlbGYuZW1pdCgnc2lnbmFsJywge1xuICAgICAgICB0eXBlOiBzaWduYWwudHlwZSxcbiAgICAgICAgc2RwOiBzaWduYWwuc2RwXG4gICAgICB9KVxuICAgIH1cbiAgICBpZiAoc2VsZi50cmlja2xlIHx8IHNlbGYuX2ljZUNvbXBsZXRlKSBzZW5kQW5zd2VyKClcbiAgICBlbHNlIHNlbGYub25jZSgnX2ljZUNvbXBsZXRlJywgc2VuZEFuc3dlcilcbiAgfSwgc2VsZi5fb25FcnJvci5iaW5kKHNlbGYpLCBzZWxmLmFuc3dlckNvbnN0cmFpbnRzKVxufVxuXG5QZWVyLnByb3RvdHlwZS5fb25JY2VDb25uZWN0aW9uU3RhdGVDaGFuZ2UgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBpZiAoc2VsZi5kZXN0cm95ZWQpIHJldHVyblxuICB2YXIgaWNlR2F0aGVyaW5nU3RhdGUgPSBzZWxmLl9wYy5pY2VHYXRoZXJpbmdTdGF0ZVxuICB2YXIgaWNlQ29ubmVjdGlvblN0YXRlID0gc2VsZi5fcGMuaWNlQ29ubmVjdGlvblN0YXRlXG4gIHNlbGYuX2RlYnVnKCdpY2VDb25uZWN0aW9uU3RhdGVDaGFuZ2UgJXMgJXMnLCBpY2VHYXRoZXJpbmdTdGF0ZSwgaWNlQ29ubmVjdGlvblN0YXRlKVxuICBzZWxmLmVtaXQoJ2ljZUNvbm5lY3Rpb25TdGF0ZUNoYW5nZScsIGljZUdhdGhlcmluZ1N0YXRlLCBpY2VDb25uZWN0aW9uU3RhdGUpXG4gIGlmIChpY2VDb25uZWN0aW9uU3RhdGUgPT09ICdjb25uZWN0ZWQnIHx8IGljZUNvbm5lY3Rpb25TdGF0ZSA9PT0gJ2NvbXBsZXRlZCcpIHtcbiAgICBjbGVhclRpbWVvdXQoc2VsZi5fcmVjb25uZWN0VGltZW91dClcbiAgICBzZWxmLl9wY1JlYWR5ID0gdHJ1ZVxuICAgIHNlbGYuX21heWJlUmVhZHkoKVxuICB9XG4gIGlmIChpY2VDb25uZWN0aW9uU3RhdGUgPT09ICdkaXNjb25uZWN0ZWQnKSB7XG4gICAgaWYgKHNlbGYucmVjb25uZWN0VGltZXIpIHtcbiAgICAgIC8vIElmIHVzZXIgaGFzIHNldCBgb3B0LnJlY29ubmVjdFRpbWVyYCwgYWxsb3cgdGltZSBmb3IgSUNFIHRvIGF0dGVtcHQgYSByZWNvbm5lY3RcbiAgICAgIGNsZWFyVGltZW91dChzZWxmLl9yZWNvbm5lY3RUaW1lb3V0KVxuICAgICAgc2VsZi5fcmVjb25uZWN0VGltZW91dCA9IHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICBzZWxmLl9kZXN0cm95KClcbiAgICAgIH0sIHNlbGYucmVjb25uZWN0VGltZXIpXG4gICAgfSBlbHNlIHtcbiAgICAgIHNlbGYuX2Rlc3Ryb3koKVxuICAgIH1cbiAgfVxuICBpZiAoaWNlQ29ubmVjdGlvblN0YXRlID09PSAnZmFpbGVkJykge1xuICAgIHNlbGYuX2Rlc3Ryb3koKVxuICB9XG4gIGlmIChpY2VDb25uZWN0aW9uU3RhdGUgPT09ICdjbG9zZWQnKSB7XG4gICAgc2VsZi5fZGVzdHJveSgpXG4gIH1cbn1cblxuUGVlci5wcm90b3R5cGUuZ2V0U3RhdHMgPSBmdW5jdGlvbiAoY2IpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmICghc2VsZi5fcGMuZ2V0U3RhdHMpIHsgLy8gTm8gYWJpbGl0eSB0byBjYWxsIHN0YXRzXG4gICAgY2IoW10pXG4gIH0gZWxzZSBpZiAodHlwZW9mIHdpbmRvdyAhPT0gJ3VuZGVmaW5lZCcgJiYgISF3aW5kb3cubW96UlRDUGVlckNvbm5lY3Rpb24pIHsgLy8gTW96aWxsYVxuICAgIHNlbGYuX3BjLmdldFN0YXRzKG51bGwsIGZ1bmN0aW9uIChyZXMpIHtcbiAgICAgIHZhciBpdGVtcyA9IFtdXG4gICAgICByZXMuZm9yRWFjaChmdW5jdGlvbiAoaXRlbSkge1xuICAgICAgICBpdGVtcy5wdXNoKGl0ZW0pXG4gICAgICB9KVxuICAgICAgY2IoaXRlbXMpXG4gICAgfSwgc2VsZi5fb25FcnJvci5iaW5kKHNlbGYpKVxuICB9IGVsc2Uge1xuICAgIHNlbGYuX3BjLmdldFN0YXRzKGZ1bmN0aW9uIChyZXMpIHsgLy8gQ2hyb21lXG4gICAgICB2YXIgaXRlbXMgPSBbXVxuICAgICAgcmVzLnJlc3VsdCgpLmZvckVhY2goZnVuY3Rpb24gKHJlc3VsdCkge1xuICAgICAgICB2YXIgaXRlbSA9IHt9XG4gICAgICAgIHJlc3VsdC5uYW1lcygpLmZvckVhY2goZnVuY3Rpb24gKG5hbWUpIHtcbiAgICAgICAgICBpdGVtW25hbWVdID0gcmVzdWx0LnN0YXQobmFtZSlcbiAgICAgICAgfSlcbiAgICAgICAgaXRlbS5pZCA9IHJlc3VsdC5pZFxuICAgICAgICBpdGVtLnR5cGUgPSByZXN1bHQudHlwZVxuICAgICAgICBpdGVtLnRpbWVzdGFtcCA9IHJlc3VsdC50aW1lc3RhbXBcbiAgICAgICAgaXRlbXMucHVzaChpdGVtKVxuICAgICAgfSlcbiAgICAgIGNiKGl0ZW1zKVxuICAgIH0pXG4gIH1cbn1cblxuUGVlci5wcm90b3R5cGUuX21heWJlUmVhZHkgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBzZWxmLl9kZWJ1ZygnbWF5YmVSZWFkeSBwYyAlcyBjaGFubmVsICVzJywgc2VsZi5fcGNSZWFkeSwgc2VsZi5fY2hhbm5lbFJlYWR5KVxuICBpZiAoc2VsZi5jb25uZWN0ZWQgfHwgc2VsZi5fY29ubmVjdGluZyB8fCAhc2VsZi5fcGNSZWFkeSB8fCAhc2VsZi5fY2hhbm5lbFJlYWR5KSByZXR1cm5cbiAgc2VsZi5fY29ubmVjdGluZyA9IHRydWVcblxuICBzZWxmLmdldFN0YXRzKGZ1bmN0aW9uIChpdGVtcykge1xuICAgIHNlbGYuX2Nvbm5lY3RpbmcgPSBmYWxzZVxuICAgIHNlbGYuY29ubmVjdGVkID0gdHJ1ZVxuXG4gICAgdmFyIHJlbW90ZUNhbmRpZGF0ZXMgPSB7fVxuICAgIHZhciBsb2NhbENhbmRpZGF0ZXMgPSB7fVxuXG4gICAgZnVuY3Rpb24gc2V0QWN0aXZlQ2FuZGlkYXRlcyAoaXRlbSkge1xuICAgICAgdmFyIGxvY2FsID0gbG9jYWxDYW5kaWRhdGVzW2l0ZW0ubG9jYWxDYW5kaWRhdGVJZF1cbiAgICAgIHZhciByZW1vdGUgPSByZW1vdGVDYW5kaWRhdGVzW2l0ZW0ucmVtb3RlQ2FuZGlkYXRlSWRdXG5cbiAgICAgIGlmIChsb2NhbCkge1xuICAgICAgICBzZWxmLmxvY2FsQWRkcmVzcyA9IGxvY2FsLmlwQWRkcmVzc1xuICAgICAgICBzZWxmLmxvY2FsUG9ydCA9IE51bWJlcihsb2NhbC5wb3J0TnVtYmVyKVxuICAgICAgfSBlbHNlIGlmICh0eXBlb2YgaXRlbS5nb29nTG9jYWxBZGRyZXNzID09PSAnc3RyaW5nJykge1xuICAgICAgICAvLyBTb21ldGltZXMgYGl0ZW0uaWRgIGlzIHVuZGVmaW5lZCBpbiBgd3J0Y2AgYW5kIENocm9tZVxuICAgICAgICAvLyBTZWU6IGh0dHBzOi8vZ2l0aHViLmNvbS9mZXJvc3Mvc2ltcGxlLXBlZXIvaXNzdWVzLzY2XG4gICAgICAgIGxvY2FsID0gaXRlbS5nb29nTG9jYWxBZGRyZXNzLnNwbGl0KCc6JylcbiAgICAgICAgc2VsZi5sb2NhbEFkZHJlc3MgPSBsb2NhbFswXVxuICAgICAgICBzZWxmLmxvY2FsUG9ydCA9IE51bWJlcihsb2NhbFsxXSlcbiAgICAgIH1cbiAgICAgIHNlbGYuX2RlYnVnKCdjb25uZWN0IGxvY2FsOiAlczolcycsIHNlbGYubG9jYWxBZGRyZXNzLCBzZWxmLmxvY2FsUG9ydClcblxuICAgICAgaWYgKHJlbW90ZSkge1xuICAgICAgICBzZWxmLnJlbW90ZUFkZHJlc3MgPSByZW1vdGUuaXBBZGRyZXNzXG4gICAgICAgIHNlbGYucmVtb3RlUG9ydCA9IE51bWJlcihyZW1vdGUucG9ydE51bWJlcilcbiAgICAgICAgc2VsZi5yZW1vdGVGYW1pbHkgPSAnSVB2NCdcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGl0ZW0uZ29vZ1JlbW90ZUFkZHJlc3MgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHJlbW90ZSA9IGl0ZW0uZ29vZ1JlbW90ZUFkZHJlc3Muc3BsaXQoJzonKVxuICAgICAgICBzZWxmLnJlbW90ZUFkZHJlc3MgPSByZW1vdGVbMF1cbiAgICAgICAgc2VsZi5yZW1vdGVQb3J0ID0gTnVtYmVyKHJlbW90ZVsxXSlcbiAgICAgICAgc2VsZi5yZW1vdGVGYW1pbHkgPSAnSVB2NCdcbiAgICAgIH1cbiAgICAgIHNlbGYuX2RlYnVnKCdjb25uZWN0IHJlbW90ZTogJXM6JXMnLCBzZWxmLnJlbW90ZUFkZHJlc3MsIHNlbGYucmVtb3RlUG9ydClcbiAgICB9XG5cbiAgICBpdGVtcy5mb3JFYWNoKGZ1bmN0aW9uIChpdGVtKSB7XG4gICAgICBpZiAoaXRlbS50eXBlID09PSAncmVtb3RlY2FuZGlkYXRlJykgcmVtb3RlQ2FuZGlkYXRlc1tpdGVtLmlkXSA9IGl0ZW1cbiAgICAgIGlmIChpdGVtLnR5cGUgPT09ICdsb2NhbGNhbmRpZGF0ZScpIGxvY2FsQ2FuZGlkYXRlc1tpdGVtLmlkXSA9IGl0ZW1cbiAgICB9KVxuXG4gICAgaXRlbXMuZm9yRWFjaChmdW5jdGlvbiAoaXRlbSkge1xuICAgICAgdmFyIGlzQ2FuZGlkYXRlUGFpciA9IChcbiAgICAgICAgKGl0ZW0udHlwZSA9PT0gJ2dvb2dDYW5kaWRhdGVQYWlyJyAmJiBpdGVtLmdvb2dBY3RpdmVDb25uZWN0aW9uID09PSAndHJ1ZScpIHx8XG4gICAgICAgIChpdGVtLnR5cGUgPT09ICdjYW5kaWRhdGVwYWlyJyAmJiBpdGVtLnNlbGVjdGVkKVxuICAgICAgKVxuICAgICAgaWYgKGlzQ2FuZGlkYXRlUGFpcikgc2V0QWN0aXZlQ2FuZGlkYXRlcyhpdGVtKVxuICAgIH0pXG5cbiAgICBpZiAoc2VsZi5fY2h1bmspIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHNlbGYuc2VuZChzZWxmLl9jaHVuaylcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4gc2VsZi5fb25FcnJvcihlcnIpXG4gICAgICB9XG4gICAgICBzZWxmLl9jaHVuayA9IG51bGxcbiAgICAgIHNlbGYuX2RlYnVnKCdzZW50IGNodW5rIGZyb20gXCJ3cml0ZSBiZWZvcmUgY29ubmVjdFwiJylcblxuICAgICAgdmFyIGNiID0gc2VsZi5fY2JcbiAgICAgIHNlbGYuX2NiID0gbnVsbFxuICAgICAgY2IobnVsbClcbiAgICB9XG5cbiAgICBzZWxmLl9pbnRlcnZhbCA9IHNldEludGVydmFsKGZ1bmN0aW9uICgpIHtcbiAgICAgIGlmICghc2VsZi5fY2IgfHwgIXNlbGYuX2NoYW5uZWwgfHwgc2VsZi5fY2hhbm5lbC5idWZmZXJlZEFtb3VudCA+IHNlbGYuX21heEJ1ZmZlcmVkQW1vdW50KSByZXR1cm5cbiAgICAgIHNlbGYuX2RlYnVnKCdlbmRpbmcgYmFja3ByZXNzdXJlOiBidWZmZXJlZEFtb3VudCAlZCcsIHNlbGYuX2NoYW5uZWwuYnVmZmVyZWRBbW91bnQpXG4gICAgICB2YXIgY2IgPSBzZWxmLl9jYlxuICAgICAgc2VsZi5fY2IgPSBudWxsXG4gICAgICBjYihudWxsKVxuICAgIH0sIDE1MClcbiAgICBpZiAoc2VsZi5faW50ZXJ2YWwudW5yZWYpIHNlbGYuX2ludGVydmFsLnVucmVmKClcblxuICAgIHNlbGYuX2RlYnVnKCdjb25uZWN0JylcbiAgICBzZWxmLmVtaXQoJ2Nvbm5lY3QnKVxuICB9KVxufVxuXG5QZWVyLnByb3RvdHlwZS5fb25TaWduYWxpbmdTdGF0ZUNoYW5nZSA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG4gIHNlbGYuX2RlYnVnKCdzaWduYWxpbmdTdGF0ZUNoYW5nZSAlcycsIHNlbGYuX3BjLnNpZ25hbGluZ1N0YXRlKVxuICBzZWxmLmVtaXQoJ3NpZ25hbGluZ1N0YXRlQ2hhbmdlJywgc2VsZi5fcGMuc2lnbmFsaW5nU3RhdGUpXG59XG5cblBlZXIucHJvdG90eXBlLl9vbkljZUNhbmRpZGF0ZSA9IGZ1bmN0aW9uIChldmVudCkge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgaWYgKHNlbGYuZGVzdHJveWVkKSByZXR1cm5cbiAgaWYgKGV2ZW50LmNhbmRpZGF0ZSAmJiBzZWxmLnRyaWNrbGUpIHtcbiAgICBzZWxmLmVtaXQoJ3NpZ25hbCcsIHtcbiAgICAgIGNhbmRpZGF0ZToge1xuICAgICAgICBjYW5kaWRhdGU6IGV2ZW50LmNhbmRpZGF0ZS5jYW5kaWRhdGUsXG4gICAgICAgIHNkcE1MaW5lSW5kZXg6IGV2ZW50LmNhbmRpZGF0ZS5zZHBNTGluZUluZGV4LFxuICAgICAgICBzZHBNaWQ6IGV2ZW50LmNhbmRpZGF0ZS5zZHBNaWRcbiAgICAgIH1cbiAgICB9KVxuICB9IGVsc2UgaWYgKCFldmVudC5jYW5kaWRhdGUpIHtcbiAgICBzZWxmLl9pY2VDb21wbGV0ZSA9IHRydWVcbiAgICBzZWxmLmVtaXQoJ19pY2VDb21wbGV0ZScpXG4gIH1cbn1cblxuUGVlci5wcm90b3R5cGUuX29uQ2hhbm5lbE1lc3NhZ2UgPSBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG4gIHZhciBkYXRhID0gZXZlbnQuZGF0YVxuICBzZWxmLl9kZWJ1ZygncmVhZDogJWQgYnl0ZXMnLCBkYXRhLmJ5dGVMZW5ndGggfHwgZGF0YS5sZW5ndGgpXG5cbiAgaWYgKGRhdGEgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikgZGF0YSA9IG5ldyBCdWZmZXIoZGF0YSlcbiAgc2VsZi5wdXNoKGRhdGEpXG59XG5cblBlZXIucHJvdG90eXBlLl9vbkNoYW5uZWxPcGVuID0gZnVuY3Rpb24gKCkge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgaWYgKHNlbGYuY29ubmVjdGVkIHx8IHNlbGYuZGVzdHJveWVkKSByZXR1cm5cbiAgc2VsZi5fZGVidWcoJ29uIGNoYW5uZWwgb3BlbicpXG4gIHNlbGYuX2NoYW5uZWxSZWFkeSA9IHRydWVcbiAgc2VsZi5fbWF5YmVSZWFkeSgpXG59XG5cblBlZXIucHJvdG90eXBlLl9vbkNoYW5uZWxDbG9zZSA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzXG4gIGlmIChzZWxmLmRlc3Ryb3llZCkgcmV0dXJuXG4gIHNlbGYuX2RlYnVnKCdvbiBjaGFubmVsIGNsb3NlJylcbiAgc2VsZi5fZGVzdHJveSgpXG59XG5cblBlZXIucHJvdG90eXBlLl9vbkFkZFN0cmVhbSA9IGZ1bmN0aW9uIChldmVudCkge1xuICB2YXIgc2VsZiA9IHRoaXNcbiAgaWYgKHNlbGYuZGVzdHJveWVkKSByZXR1cm5cbiAgc2VsZi5fZGVidWcoJ29uIGFkZCBzdHJlYW0nKVxuICBzZWxmLmVtaXQoJ3N0cmVhbScsIGV2ZW50LnN0cmVhbSlcbn1cblxuUGVlci5wcm90b3R5cGUuX29uRXJyb3IgPSBmdW5jdGlvbiAoZXJyKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICBpZiAoc2VsZi5kZXN0cm95ZWQpIHJldHVyblxuICBzZWxmLl9kZWJ1ZygnZXJyb3IgJXMnLCBlcnIubWVzc2FnZSB8fCBlcnIpXG4gIHNlbGYuX2Rlc3Ryb3koZXJyKVxufVxuXG5QZWVyLnByb3RvdHlwZS5fZGVidWcgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKVxuICB2YXIgaWQgPSBzZWxmLmNoYW5uZWxOYW1lICYmIHNlbGYuY2hhbm5lbE5hbWUuc3Vic3RyaW5nKDAsIDcpXG4gIGFyZ3NbMF0gPSAnWycgKyBpZCArICddICcgKyBhcmdzWzBdXG4gIGRlYnVnLmFwcGx5KG51bGwsIGFyZ3MpXG59XG5cbmZ1bmN0aW9uIG5vb3AgKCkge31cblxufSkuY2FsbCh0aGlzLHJlcXVpcmUoXCJidWZmZXJcIikuQnVmZmVyKSIsIid1c2Ugc3RyaWN0Jztcbm1vZHVsZS5leHBvcnRzID0gU29ydGVkQXJyYXlcbnZhciBzZWFyY2ggPSByZXF1aXJlKCdiaW5hcnktc2VhcmNoJylcblxuZnVuY3Rpb24gU29ydGVkQXJyYXkoY21wLCBhcnIpIHtcbiAgaWYgKHR5cGVvZiBjbXAgIT0gJ2Z1bmN0aW9uJylcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdjb21wYXJhdG9yIG11c3QgYmUgYSBmdW5jdGlvbicpXG5cbiAgdGhpcy5hcnIgPSBhcnIgfHwgW11cbiAgdGhpcy5jbXAgPSBjbXBcbn1cblxuU29ydGVkQXJyYXkucHJvdG90eXBlLmluc2VydCA9IGZ1bmN0aW9uKGVsZW1lbnQpIHtcbiAgdmFyIGluZGV4ID0gc2VhcmNoKHRoaXMuYXJyLCBlbGVtZW50LCB0aGlzLmNtcClcbiAgaWYgKGluZGV4IDwgMClcbiAgICBpbmRleCA9IH5pbmRleFxuXG4gIHRoaXMuYXJyLnNwbGljZShpbmRleCwgMCwgZWxlbWVudClcbn1cblxuU29ydGVkQXJyYXkucHJvdG90eXBlLmluZGV4T2YgPSBmdW5jdGlvbihlbGVtZW50KSB7XG4gIHZhciBpbmRleCA9IHNlYXJjaCh0aGlzLmFyciwgZWxlbWVudCwgdGhpcy5jbXApXG4gIHJldHVybiBpbmRleCA+PSAwXG4gICAgPyBpbmRleFxuICAgIDogLTFcbn1cblxuU29ydGVkQXJyYXkucHJvdG90eXBlLnJlbW92ZSA9IGZ1bmN0aW9uKGVsZW1lbnQpIHtcbiAgdmFyIGluZGV4ID0gc2VhcmNoKHRoaXMuYXJyLCBlbGVtZW50LCB0aGlzLmNtcClcbiAgaWYgKGluZGV4IDwgMClcbiAgICByZXR1cm4gZmFsc2VcblxuICB0aGlzLmFyci5zcGxpY2UoaW5kZXgsIDEpXG4gIHJldHVybiB0cnVlXG59XG4iLCIvLyBDb3B5cmlnaHQgSm95ZW50LCBJbmMuIGFuZCBvdGhlciBOb2RlIGNvbnRyaWJ1dG9ycy5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYVxuLy8gY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZVxuLy8gXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nXG4vLyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsXG4vLyBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0XG4vLyBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGVcbi8vIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkXG4vLyBpbiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTXG4vLyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GXG4vLyBNRVJDSEFOVEFCSUxJVFksIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOXG4vLyBOTyBFVkVOVCBTSEFMTCBUSEUgQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSxcbi8vIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUlxuLy8gT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRVxuLy8gVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxudmFyIEJ1ZmZlciA9IHJlcXVpcmUoJ2J1ZmZlcicpLkJ1ZmZlcjtcblxudmFyIGlzQnVmZmVyRW5jb2RpbmcgPSBCdWZmZXIuaXNFbmNvZGluZ1xuICB8fCBmdW5jdGlvbihlbmNvZGluZykge1xuICAgICAgIHN3aXRjaCAoZW5jb2RpbmcgJiYgZW5jb2RpbmcudG9Mb3dlckNhc2UoKSkge1xuICAgICAgICAgY2FzZSAnaGV4JzogY2FzZSAndXRmOCc6IGNhc2UgJ3V0Zi04JzogY2FzZSAnYXNjaWknOiBjYXNlICdiaW5hcnknOiBjYXNlICdiYXNlNjQnOiBjYXNlICd1Y3MyJzogY2FzZSAndWNzLTInOiBjYXNlICd1dGYxNmxlJzogY2FzZSAndXRmLTE2bGUnOiBjYXNlICdyYXcnOiByZXR1cm4gdHJ1ZTtcbiAgICAgICAgIGRlZmF1bHQ6IHJldHVybiBmYWxzZTtcbiAgICAgICB9XG4gICAgIH1cblxuXG5mdW5jdGlvbiBhc3NlcnRFbmNvZGluZyhlbmNvZGluZykge1xuICBpZiAoZW5jb2RpbmcgJiYgIWlzQnVmZmVyRW5jb2RpbmcoZW5jb2RpbmcpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIGVuY29kaW5nOiAnICsgZW5jb2RpbmcpO1xuICB9XG59XG5cbi8vIFN0cmluZ0RlY29kZXIgcHJvdmlkZXMgYW4gaW50ZXJmYWNlIGZvciBlZmZpY2llbnRseSBzcGxpdHRpbmcgYSBzZXJpZXMgb2Zcbi8vIGJ1ZmZlcnMgaW50byBhIHNlcmllcyBvZiBKUyBzdHJpbmdzIHdpdGhvdXQgYnJlYWtpbmcgYXBhcnQgbXVsdGktYnl0ZVxuLy8gY2hhcmFjdGVycy4gQ0VTVS04IGlzIGhhbmRsZWQgYXMgcGFydCBvZiB0aGUgVVRGLTggZW5jb2RpbmcuXG4vL1xuLy8gQFRPRE8gSGFuZGxpbmcgYWxsIGVuY29kaW5ncyBpbnNpZGUgYSBzaW5nbGUgb2JqZWN0IG1ha2VzIGl0IHZlcnkgZGlmZmljdWx0XG4vLyB0byByZWFzb24gYWJvdXQgdGhpcyBjb2RlLCBzbyBpdCBzaG91bGQgYmUgc3BsaXQgdXAgaW4gdGhlIGZ1dHVyZS5cbi8vIEBUT0RPIFRoZXJlIHNob3VsZCBiZSBhIHV0Zjgtc3RyaWN0IGVuY29kaW5nIHRoYXQgcmVqZWN0cyBpbnZhbGlkIFVURi04IGNvZGVcbi8vIHBvaW50cyBhcyB1c2VkIGJ5IENFU1UtOC5cbnZhciBTdHJpbmdEZWNvZGVyID0gZXhwb3J0cy5TdHJpbmdEZWNvZGVyID0gZnVuY3Rpb24oZW5jb2RpbmcpIHtcbiAgdGhpcy5lbmNvZGluZyA9IChlbmNvZGluZyB8fCAndXRmOCcpLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvWy1fXS8sICcnKTtcbiAgYXNzZXJ0RW5jb2RpbmcoZW5jb2RpbmcpO1xuICBzd2l0Y2ggKHRoaXMuZW5jb2RpbmcpIHtcbiAgICBjYXNlICd1dGY4JzpcbiAgICAgIC8vIENFU1UtOCByZXByZXNlbnRzIGVhY2ggb2YgU3Vycm9nYXRlIFBhaXIgYnkgMy1ieXRlc1xuICAgICAgdGhpcy5zdXJyb2dhdGVTaXplID0gMztcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ3VjczInOlxuICAgIGNhc2UgJ3V0ZjE2bGUnOlxuICAgICAgLy8gVVRGLTE2IHJlcHJlc2VudHMgZWFjaCBvZiBTdXJyb2dhdGUgUGFpciBieSAyLWJ5dGVzXG4gICAgICB0aGlzLnN1cnJvZ2F0ZVNpemUgPSAyO1xuICAgICAgdGhpcy5kZXRlY3RJbmNvbXBsZXRlQ2hhciA9IHV0ZjE2RGV0ZWN0SW5jb21wbGV0ZUNoYXI7XG4gICAgICBicmVhaztcbiAgICBjYXNlICdiYXNlNjQnOlxuICAgICAgLy8gQmFzZS02NCBzdG9yZXMgMyBieXRlcyBpbiA0IGNoYXJzLCBhbmQgcGFkcyB0aGUgcmVtYWluZGVyLlxuICAgICAgdGhpcy5zdXJyb2dhdGVTaXplID0gMztcbiAgICAgIHRoaXMuZGV0ZWN0SW5jb21wbGV0ZUNoYXIgPSBiYXNlNjREZXRlY3RJbmNvbXBsZXRlQ2hhcjtcbiAgICAgIGJyZWFrO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aGlzLndyaXRlID0gcGFzc1Rocm91Z2hXcml0ZTtcbiAgICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEVub3VnaCBzcGFjZSB0byBzdG9yZSBhbGwgYnl0ZXMgb2YgYSBzaW5nbGUgY2hhcmFjdGVyLiBVVEYtOCBuZWVkcyA0XG4gIC8vIGJ5dGVzLCBidXQgQ0VTVS04IG1heSByZXF1aXJlIHVwIHRvIDYgKDMgYnl0ZXMgcGVyIHN1cnJvZ2F0ZSkuXG4gIHRoaXMuY2hhckJ1ZmZlciA9IG5ldyBCdWZmZXIoNik7XG4gIC8vIE51bWJlciBvZiBieXRlcyByZWNlaXZlZCBmb3IgdGhlIGN1cnJlbnQgaW5jb21wbGV0ZSBtdWx0aS1ieXRlIGNoYXJhY3Rlci5cbiAgdGhpcy5jaGFyUmVjZWl2ZWQgPSAwO1xuICAvLyBOdW1iZXIgb2YgYnl0ZXMgZXhwZWN0ZWQgZm9yIHRoZSBjdXJyZW50IGluY29tcGxldGUgbXVsdGktYnl0ZSBjaGFyYWN0ZXIuXG4gIHRoaXMuY2hhckxlbmd0aCA9IDA7XG59O1xuXG5cbi8vIHdyaXRlIGRlY29kZXMgdGhlIGdpdmVuIGJ1ZmZlciBhbmQgcmV0dXJucyBpdCBhcyBKUyBzdHJpbmcgdGhhdCBpc1xuLy8gZ3VhcmFudGVlZCB0byBub3QgY29udGFpbiBhbnkgcGFydGlhbCBtdWx0aS1ieXRlIGNoYXJhY3RlcnMuIEFueSBwYXJ0aWFsXG4vLyBjaGFyYWN0ZXIgZm91bmQgYXQgdGhlIGVuZCBvZiB0aGUgYnVmZmVyIGlzIGJ1ZmZlcmVkIHVwLCBhbmQgd2lsbCBiZVxuLy8gcmV0dXJuZWQgd2hlbiBjYWxsaW5nIHdyaXRlIGFnYWluIHdpdGggdGhlIHJlbWFpbmluZyBieXRlcy5cbi8vXG4vLyBOb3RlOiBDb252ZXJ0aW5nIGEgQnVmZmVyIGNvbnRhaW5pbmcgYW4gb3JwaGFuIHN1cnJvZ2F0ZSB0byBhIFN0cmluZ1xuLy8gY3VycmVudGx5IHdvcmtzLCBidXQgY29udmVydGluZyBhIFN0cmluZyB0byBhIEJ1ZmZlciAodmlhIGBuZXcgQnVmZmVyYCwgb3Jcbi8vIEJ1ZmZlciN3cml0ZSkgd2lsbCByZXBsYWNlIGluY29tcGxldGUgc3Vycm9nYXRlcyB3aXRoIHRoZSB1bmljb2RlXG4vLyByZXBsYWNlbWVudCBjaGFyYWN0ZXIuIFNlZSBodHRwczovL2NvZGVyZXZpZXcuY2hyb21pdW0ub3JnLzEyMTE3MzAwOS8gLlxuU3RyaW5nRGVjb2Rlci5wcm90b3R5cGUud3JpdGUgPSBmdW5jdGlvbihidWZmZXIpIHtcbiAgdmFyIGNoYXJTdHIgPSAnJztcbiAgLy8gaWYgb3VyIGxhc3Qgd3JpdGUgZW5kZWQgd2l0aCBhbiBpbmNvbXBsZXRlIG11bHRpYnl0ZSBjaGFyYWN0ZXJcbiAgd2hpbGUgKHRoaXMuY2hhckxlbmd0aCkge1xuICAgIC8vIGRldGVybWluZSBob3cgbWFueSByZW1haW5pbmcgYnl0ZXMgdGhpcyBidWZmZXIgaGFzIHRvIG9mZmVyIGZvciB0aGlzIGNoYXJcbiAgICB2YXIgYXZhaWxhYmxlID0gKGJ1ZmZlci5sZW5ndGggPj0gdGhpcy5jaGFyTGVuZ3RoIC0gdGhpcy5jaGFyUmVjZWl2ZWQpID9cbiAgICAgICAgdGhpcy5jaGFyTGVuZ3RoIC0gdGhpcy5jaGFyUmVjZWl2ZWQgOlxuICAgICAgICBidWZmZXIubGVuZ3RoO1xuXG4gICAgLy8gYWRkIHRoZSBuZXcgYnl0ZXMgdG8gdGhlIGNoYXIgYnVmZmVyXG4gICAgYnVmZmVyLmNvcHkodGhpcy5jaGFyQnVmZmVyLCB0aGlzLmNoYXJSZWNlaXZlZCwgMCwgYXZhaWxhYmxlKTtcbiAgICB0aGlzLmNoYXJSZWNlaXZlZCArPSBhdmFpbGFibGU7XG5cbiAgICBpZiAodGhpcy5jaGFyUmVjZWl2ZWQgPCB0aGlzLmNoYXJMZW5ndGgpIHtcbiAgICAgIC8vIHN0aWxsIG5vdCBlbm91Z2ggY2hhcnMgaW4gdGhpcyBidWZmZXI/IHdhaXQgZm9yIG1vcmUgLi4uXG4gICAgICByZXR1cm4gJyc7XG4gICAgfVxuXG4gICAgLy8gcmVtb3ZlIGJ5dGVzIGJlbG9uZ2luZyB0byB0aGUgY3VycmVudCBjaGFyYWN0ZXIgZnJvbSB0aGUgYnVmZmVyXG4gICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGF2YWlsYWJsZSwgYnVmZmVyLmxlbmd0aCk7XG5cbiAgICAvLyBnZXQgdGhlIGNoYXJhY3RlciB0aGF0IHdhcyBzcGxpdFxuICAgIGNoYXJTdHIgPSB0aGlzLmNoYXJCdWZmZXIuc2xpY2UoMCwgdGhpcy5jaGFyTGVuZ3RoKS50b1N0cmluZyh0aGlzLmVuY29kaW5nKTtcblxuICAgIC8vIENFU1UtODogbGVhZCBzdXJyb2dhdGUgKEQ4MDAtREJGRikgaXMgYWxzbyB0aGUgaW5jb21wbGV0ZSBjaGFyYWN0ZXJcbiAgICB2YXIgY2hhckNvZGUgPSBjaGFyU3RyLmNoYXJDb2RlQXQoY2hhclN0ci5sZW5ndGggLSAxKTtcbiAgICBpZiAoY2hhckNvZGUgPj0gMHhEODAwICYmIGNoYXJDb2RlIDw9IDB4REJGRikge1xuICAgICAgdGhpcy5jaGFyTGVuZ3RoICs9IHRoaXMuc3Vycm9nYXRlU2l6ZTtcbiAgICAgIGNoYXJTdHIgPSAnJztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICB0aGlzLmNoYXJSZWNlaXZlZCA9IHRoaXMuY2hhckxlbmd0aCA9IDA7XG5cbiAgICAvLyBpZiB0aGVyZSBhcmUgbm8gbW9yZSBieXRlcyBpbiB0aGlzIGJ1ZmZlciwganVzdCBlbWl0IG91ciBjaGFyXG4gICAgaWYgKGJ1ZmZlci5sZW5ndGggPT09IDApIHtcbiAgICAgIHJldHVybiBjaGFyU3RyO1xuICAgIH1cbiAgICBicmVhaztcbiAgfVxuXG4gIC8vIGRldGVybWluZSBhbmQgc2V0IGNoYXJMZW5ndGggLyBjaGFyUmVjZWl2ZWRcbiAgdGhpcy5kZXRlY3RJbmNvbXBsZXRlQ2hhcihidWZmZXIpO1xuXG4gIHZhciBlbmQgPSBidWZmZXIubGVuZ3RoO1xuICBpZiAodGhpcy5jaGFyTGVuZ3RoKSB7XG4gICAgLy8gYnVmZmVyIHRoZSBpbmNvbXBsZXRlIGNoYXJhY3RlciBieXRlcyB3ZSBnb3RcbiAgICBidWZmZXIuY29weSh0aGlzLmNoYXJCdWZmZXIsIDAsIGJ1ZmZlci5sZW5ndGggLSB0aGlzLmNoYXJSZWNlaXZlZCwgZW5kKTtcbiAgICBlbmQgLT0gdGhpcy5jaGFyUmVjZWl2ZWQ7XG4gIH1cblxuICBjaGFyU3RyICs9IGJ1ZmZlci50b1N0cmluZyh0aGlzLmVuY29kaW5nLCAwLCBlbmQpO1xuXG4gIHZhciBlbmQgPSBjaGFyU3RyLmxlbmd0aCAtIDE7XG4gIHZhciBjaGFyQ29kZSA9IGNoYXJTdHIuY2hhckNvZGVBdChlbmQpO1xuICAvLyBDRVNVLTg6IGxlYWQgc3Vycm9nYXRlIChEODAwLURCRkYpIGlzIGFsc28gdGhlIGluY29tcGxldGUgY2hhcmFjdGVyXG4gIGlmIChjaGFyQ29kZSA+PSAweEQ4MDAgJiYgY2hhckNvZGUgPD0gMHhEQkZGKSB7XG4gICAgdmFyIHNpemUgPSB0aGlzLnN1cnJvZ2F0ZVNpemU7XG4gICAgdGhpcy5jaGFyTGVuZ3RoICs9IHNpemU7XG4gICAgdGhpcy5jaGFyUmVjZWl2ZWQgKz0gc2l6ZTtcbiAgICB0aGlzLmNoYXJCdWZmZXIuY29weSh0aGlzLmNoYXJCdWZmZXIsIHNpemUsIDAsIHNpemUpO1xuICAgIGJ1ZmZlci5jb3B5KHRoaXMuY2hhckJ1ZmZlciwgMCwgMCwgc2l6ZSk7XG4gICAgcmV0dXJuIGNoYXJTdHIuc3Vic3RyaW5nKDAsIGVuZCk7XG4gIH1cblxuICAvLyBvciBqdXN0IGVtaXQgdGhlIGNoYXJTdHJcbiAgcmV0dXJuIGNoYXJTdHI7XG59O1xuXG4vLyBkZXRlY3RJbmNvbXBsZXRlQ2hhciBkZXRlcm1pbmVzIGlmIHRoZXJlIGlzIGFuIGluY29tcGxldGUgVVRGLTggY2hhcmFjdGVyIGF0XG4vLyB0aGUgZW5kIG9mIHRoZSBnaXZlbiBidWZmZXIuIElmIHNvLCBpdCBzZXRzIHRoaXMuY2hhckxlbmd0aCB0byB0aGUgYnl0ZVxuLy8gbGVuZ3RoIHRoYXQgY2hhcmFjdGVyLCBhbmQgc2V0cyB0aGlzLmNoYXJSZWNlaXZlZCB0byB0aGUgbnVtYmVyIG9mIGJ5dGVzXG4vLyB0aGF0IGFyZSBhdmFpbGFibGUgZm9yIHRoaXMgY2hhcmFjdGVyLlxuU3RyaW5nRGVjb2Rlci5wcm90b3R5cGUuZGV0ZWN0SW5jb21wbGV0ZUNoYXIgPSBmdW5jdGlvbihidWZmZXIpIHtcbiAgLy8gZGV0ZXJtaW5lIGhvdyBtYW55IGJ5dGVzIHdlIGhhdmUgdG8gY2hlY2sgYXQgdGhlIGVuZCBvZiB0aGlzIGJ1ZmZlclxuICB2YXIgaSA9IChidWZmZXIubGVuZ3RoID49IDMpID8gMyA6IGJ1ZmZlci5sZW5ndGg7XG5cbiAgLy8gRmlndXJlIG91dCBpZiBvbmUgb2YgdGhlIGxhc3QgaSBieXRlcyBvZiBvdXIgYnVmZmVyIGFubm91bmNlcyBhblxuICAvLyBpbmNvbXBsZXRlIGNoYXIuXG4gIGZvciAoOyBpID4gMDsgaS0tKSB7XG4gICAgdmFyIGMgPSBidWZmZXJbYnVmZmVyLmxlbmd0aCAtIGldO1xuXG4gICAgLy8gU2VlIGh0dHA6Ly9lbi53aWtpcGVkaWEub3JnL3dpa2kvVVRGLTgjRGVzY3JpcHRpb25cblxuICAgIC8vIDExMFhYWFhYXG4gICAgaWYgKGkgPT0gMSAmJiBjID4+IDUgPT0gMHgwNikge1xuICAgICAgdGhpcy5jaGFyTGVuZ3RoID0gMjtcbiAgICAgIGJyZWFrO1xuICAgIH1cblxuICAgIC8vIDExMTBYWFhYXG4gICAgaWYgKGkgPD0gMiAmJiBjID4+IDQgPT0gMHgwRSkge1xuICAgICAgdGhpcy5jaGFyTGVuZ3RoID0gMztcbiAgICAgIGJyZWFrO1xuICAgIH1cblxuICAgIC8vIDExMTEwWFhYXG4gICAgaWYgKGkgPD0gMyAmJiBjID4+IDMgPT0gMHgxRSkge1xuICAgICAgdGhpcy5jaGFyTGVuZ3RoID0gNDtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuICB0aGlzLmNoYXJSZWNlaXZlZCA9IGk7XG59O1xuXG5TdHJpbmdEZWNvZGVyLnByb3RvdHlwZS5lbmQgPSBmdW5jdGlvbihidWZmZXIpIHtcbiAgdmFyIHJlcyA9ICcnO1xuICBpZiAoYnVmZmVyICYmIGJ1ZmZlci5sZW5ndGgpXG4gICAgcmVzID0gdGhpcy53cml0ZShidWZmZXIpO1xuXG4gIGlmICh0aGlzLmNoYXJSZWNlaXZlZCkge1xuICAgIHZhciBjciA9IHRoaXMuY2hhclJlY2VpdmVkO1xuICAgIHZhciBidWYgPSB0aGlzLmNoYXJCdWZmZXI7XG4gICAgdmFyIGVuYyA9IHRoaXMuZW5jb2Rpbmc7XG4gICAgcmVzICs9IGJ1Zi5zbGljZSgwLCBjcikudG9TdHJpbmcoZW5jKTtcbiAgfVxuXG4gIHJldHVybiByZXM7XG59O1xuXG5mdW5jdGlvbiBwYXNzVGhyb3VnaFdyaXRlKGJ1ZmZlcikge1xuICByZXR1cm4gYnVmZmVyLnRvU3RyaW5nKHRoaXMuZW5jb2RpbmcpO1xufVxuXG5mdW5jdGlvbiB1dGYxNkRldGVjdEluY29tcGxldGVDaGFyKGJ1ZmZlcikge1xuICB0aGlzLmNoYXJSZWNlaXZlZCA9IGJ1ZmZlci5sZW5ndGggJSAyO1xuICB0aGlzLmNoYXJMZW5ndGggPSB0aGlzLmNoYXJSZWNlaXZlZCA/IDIgOiAwO1xufVxuXG5mdW5jdGlvbiBiYXNlNjREZXRlY3RJbmNvbXBsZXRlQ2hhcihidWZmZXIpIHtcbiAgdGhpcy5jaGFyUmVjZWl2ZWQgPSBidWZmZXIubGVuZ3RoICUgMztcbiAgdGhpcy5jaGFyTGVuZ3RoID0gdGhpcy5jaGFyUmVjZWl2ZWQgPyAzIDogMDtcbn1cbiIsIihmdW5jdGlvbiAoZ2xvYmFsKXtcblxuLyoqXG4gKiBNb2R1bGUgZXhwb3J0cy5cbiAqL1xuXG5tb2R1bGUuZXhwb3J0cyA9IGRlcHJlY2F0ZTtcblxuLyoqXG4gKiBNYXJrIHRoYXQgYSBtZXRob2Qgc2hvdWxkIG5vdCBiZSB1c2VkLlxuICogUmV0dXJucyBhIG1vZGlmaWVkIGZ1bmN0aW9uIHdoaWNoIHdhcm5zIG9uY2UgYnkgZGVmYXVsdC5cbiAqXG4gKiBJZiBgbG9jYWxTdG9yYWdlLm5vRGVwcmVjYXRpb24gPSB0cnVlYCBpcyBzZXQsIHRoZW4gaXQgaXMgYSBuby1vcC5cbiAqXG4gKiBJZiBgbG9jYWxTdG9yYWdlLnRocm93RGVwcmVjYXRpb24gPSB0cnVlYCBpcyBzZXQsIHRoZW4gZGVwcmVjYXRlZCBmdW5jdGlvbnNcbiAqIHdpbGwgdGhyb3cgYW4gRXJyb3Igd2hlbiBpbnZva2VkLlxuICpcbiAqIElmIGBsb2NhbFN0b3JhZ2UudHJhY2VEZXByZWNhdGlvbiA9IHRydWVgIGlzIHNldCwgdGhlbiBkZXByZWNhdGVkIGZ1bmN0aW9uc1xuICogd2lsbCBpbnZva2UgYGNvbnNvbGUudHJhY2UoKWAgaW5zdGVhZCBvZiBgY29uc29sZS5lcnJvcigpYC5cbiAqXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmbiAtIHRoZSBmdW5jdGlvbiB0byBkZXByZWNhdGVcbiAqIEBwYXJhbSB7U3RyaW5nfSBtc2cgLSB0aGUgc3RyaW5nIHRvIHByaW50IHRvIHRoZSBjb25zb2xlIHdoZW4gYGZuYCBpcyBpbnZva2VkXG4gKiBAcmV0dXJucyB7RnVuY3Rpb259IGEgbmV3IFwiZGVwcmVjYXRlZFwiIHZlcnNpb24gb2YgYGZuYFxuICogQGFwaSBwdWJsaWNcbiAqL1xuXG5mdW5jdGlvbiBkZXByZWNhdGUgKGZuLCBtc2cpIHtcbiAgaWYgKGNvbmZpZygnbm9EZXByZWNhdGlvbicpKSB7XG4gICAgcmV0dXJuIGZuO1xuICB9XG5cbiAgdmFyIHdhcm5lZCA9IGZhbHNlO1xuICBmdW5jdGlvbiBkZXByZWNhdGVkKCkge1xuICAgIGlmICghd2FybmVkKSB7XG4gICAgICBpZiAoY29uZmlnKCd0aHJvd0RlcHJlY2F0aW9uJykpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1zZyk7XG4gICAgICB9IGVsc2UgaWYgKGNvbmZpZygndHJhY2VEZXByZWNhdGlvbicpKSB7XG4gICAgICAgIGNvbnNvbGUudHJhY2UobXNnKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnNvbGUud2Fybihtc2cpO1xuICAgICAgfVxuICAgICAgd2FybmVkID0gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gIH1cblxuICByZXR1cm4gZGVwcmVjYXRlZDtcbn1cblxuLyoqXG4gKiBDaGVja3MgYGxvY2FsU3RvcmFnZWAgZm9yIGJvb2xlYW4gdmFsdWVzIGZvciB0aGUgZ2l2ZW4gYG5hbWVgLlxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSBuYW1lXG4gKiBAcmV0dXJucyB7Qm9vbGVhbn1cbiAqIEBhcGkgcHJpdmF0ZVxuICovXG5cbmZ1bmN0aW9uIGNvbmZpZyAobmFtZSkge1xuICAvLyBhY2Nlc3NpbmcgZ2xvYmFsLmxvY2FsU3RvcmFnZSBjYW4gdHJpZ2dlciBhIERPTUV4Y2VwdGlvbiBpbiBzYW5kYm94ZWQgaWZyYW1lc1xuICB0cnkge1xuICAgIGlmICghZ2xvYmFsLmxvY2FsU3RvcmFnZSkgcmV0dXJuIGZhbHNlO1xuICB9IGNhdGNoIChfKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHZhciB2YWwgPSBnbG9iYWwubG9jYWxTdG9yYWdlW25hbWVdO1xuICBpZiAobnVsbCA9PSB2YWwpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIFN0cmluZyh2YWwpLnRvTG93ZXJDYXNlKCkgPT09ICd0cnVlJztcbn1cblxufSkuY2FsbCh0aGlzLHR5cGVvZiBnbG9iYWwgIT09IFwidW5kZWZpbmVkXCIgPyBnbG9iYWwgOiB0eXBlb2Ygc2VsZiAhPT0gXCJ1bmRlZmluZWRcIiA/IHNlbGYgOiB0eXBlb2Ygd2luZG93ICE9PSBcInVuZGVmaW5lZFwiID8gd2luZG93IDoge30pIiwiLy8gUmV0dXJucyBhIHdyYXBwZXIgZnVuY3Rpb24gdGhhdCByZXR1cm5zIGEgd3JhcHBlZCBjYWxsYmFja1xuLy8gVGhlIHdyYXBwZXIgZnVuY3Rpb24gc2hvdWxkIGRvIHNvbWUgc3R1ZmYsIGFuZCByZXR1cm4gYVxuLy8gcHJlc3VtYWJseSBkaWZmZXJlbnQgY2FsbGJhY2sgZnVuY3Rpb24uXG4vLyBUaGlzIG1ha2VzIHN1cmUgdGhhdCBvd24gcHJvcGVydGllcyBhcmUgcmV0YWluZWQsIHNvIHRoYXRcbi8vIGRlY29yYXRpb25zIGFuZCBzdWNoIGFyZSBub3QgbG9zdCBhbG9uZyB0aGUgd2F5LlxubW9kdWxlLmV4cG9ydHMgPSB3cmFwcHlcbmZ1bmN0aW9uIHdyYXBweSAoZm4sIGNiKSB7XG4gIGlmIChmbiAmJiBjYikgcmV0dXJuIHdyYXBweShmbikoY2IpXG5cbiAgaWYgKHR5cGVvZiBmbiAhPT0gJ2Z1bmN0aW9uJylcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCduZWVkIHdyYXBwZXIgZnVuY3Rpb24nKVxuXG4gIE9iamVjdC5rZXlzKGZuKS5mb3JFYWNoKGZ1bmN0aW9uIChrKSB7XG4gICAgd3JhcHBlcltrXSA9IGZuW2tdXG4gIH0pXG5cbiAgcmV0dXJuIHdyYXBwZXJcblxuICBmdW5jdGlvbiB3cmFwcGVyKCkge1xuICAgIHZhciBhcmdzID0gbmV3IEFycmF5KGFyZ3VtZW50cy5sZW5ndGgpXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBhcmdzW2ldID0gYXJndW1lbnRzW2ldXG4gICAgfVxuICAgIHZhciByZXQgPSBmbi5hcHBseSh0aGlzLCBhcmdzKVxuICAgIHZhciBjYiA9IGFyZ3NbYXJncy5sZW5ndGgtMV1cbiAgICBpZiAodHlwZW9mIHJldCA9PT0gJ2Z1bmN0aW9uJyAmJiByZXQgIT09IGNiKSB7XG4gICAgICBPYmplY3Qua2V5cyhjYikuZm9yRWFjaChmdW5jdGlvbiAoaykge1xuICAgICAgICByZXRba10gPSBjYltrXVxuICAgICAgfSlcbiAgICB9XG4gICAgcmV0dXJuIHJldFxuICB9XG59XG4iLCJ2YXIgU29ydGVkQXJyYXkgPSByZXF1aXJlKCdzb3J0ZWQtY21wLWFycmF5Jyk7XG52YXIgQ29tcGFyYXRvciA9IHJlcXVpcmUoJy4vdnZ3ZWVudHJ5LmpzJykuQ29tcGFyYXRvcjtcbnZhciBWVndFRW50cnkgPSByZXF1aXJlKCcuL3Z2d2VlbnRyeS5qcycpO1xuXG4vKipcbiAqIFxcY2xhc3MgVlZ3RVxuICogXFxicmllZiBjbGFzcyB2ZXJzaW9uIHZlY3RvciB3aXRoIGV4Y2VwdGlvbiBrZWVwcyB0cmFjayBvZiBldmVudHMgaW4gYSBcbiAqIGNvbmNpc2Ugd2F5XG4gKiBcXHBhcmFtIGUgdGhlIGVudHJ5IGNob3NlbiBieSB0aGUgbG9jYWwgc2l0ZSAoMSBlbnRyeSA8LT4gMSBzaXRlKVxuICovXG5mdW5jdGlvbiBWVndFKGUpe1xuICAgIHRoaXMubG9jYWwgPSBuZXcgVlZ3RUVudHJ5KGUpO1xuICAgIHRoaXMudmVjdG9yID0gbmV3IFNvcnRlZEFycmF5KENvbXBhcmF0b3IpO1xuICAgIHRoaXMudmVjdG9yLmluc2VydCh0aGlzLmxvY2FsKTtcbn07XG5cbi8qIVxuICogXFxicmllZiBjbG9uZSBvZiB0aGlzIHZ2d2VcbiAqL1xuVlZ3RS5wcm90b3R5cGUuY2xvbmUgPSBmdW5jdGlvbigpe1xuICAgIHZhciBjbG9uZVZWd0UgPSBuZXcgVlZ3RSh0aGlzLmxvY2FsLmUpO1xuICAgIGZvciAodmFyIGk9MDsgaTx0aGlzLnZlY3Rvci5hcnIubGVuZ3RoOyArK2kpe1xuICAgICAgICBjbG9uZVZWd0UudmVjdG9yLmFycltpXSA9IG5ldyBWVndFRW50cnkodGhpcy52ZWN0b3IuYXJyW2ldLmUpO1xuICAgICAgICBjbG9uZVZWd0UudmVjdG9yLmFycltpXS52ID0gdGhpcy52ZWN0b3IuYXJyW2ldLnY7XG4gICAgICAgIGZvciAodmFyIGo9MDsgajx0aGlzLnZlY3Rvci5hcnJbaV0ueC5sZW5ndGg7ICsrail7XG4gICAgICAgICAgICBjbG9uZVZWd0UudmVjdG9yLmFycltpXS54LnB1c2godGhpcy52ZWN0b3IuYXJyW2ldLnhbal0pO1xuICAgICAgICB9O1xuICAgICAgICBpZiAoY2xvbmVWVndFLnZlY3Rvci5hcnJbaV0uZSA9PT0gdGhpcy5sb2NhbC5lKXtcbiAgICAgICAgICAgIGNsb25lVlZ3RS5sb2NhbCA9IGNsb25lVlZ3RS52ZWN0b3IuYXJyW2ldO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgcmV0dXJuIGNsb25lVlZ3RTtcbn07XG5cblZWd0UucHJvdG90eXBlLmZyb21KU09OID0gZnVuY3Rpb24ob2JqZWN0KXtcbiAgICBmb3IgKHZhciBpPTA7IGk8b2JqZWN0LnZlY3Rvci5hcnIubGVuZ3RoOyArK2kpe1xuICAgICAgICB0aGlzLnZlY3Rvci5hcnJbaV0gPSBuZXcgVlZ3RUVudHJ5KG9iamVjdC52ZWN0b3IuYXJyW2ldLmUpO1xuICAgICAgICB0aGlzLnZlY3Rvci5hcnJbaV0udiA9IG9iamVjdC52ZWN0b3IuYXJyW2ldLnY7XG4gICAgICAgIGZvciAodmFyIGo9MDsgajxvYmplY3QudmVjdG9yLmFycltpXS54Lmxlbmd0aDsgKytqKXtcbiAgICAgICAgICAgIHRoaXMudmVjdG9yLmFycltpXS54LnB1c2gob2JqZWN0LnZlY3Rvci5hcnJbaV0ueFtqXSk7XG4gICAgICAgIH07XG4gICAgICAgIGlmIChvYmplY3QudmVjdG9yLmFycltpXS5lID09PSBvYmplY3QubG9jYWwuZSl7XG4gICAgICAgICAgICB0aGlzLmxvY2FsID0gdGhpcy52ZWN0b3IuYXJyW2ldO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgcmV0dXJuIHRoaXM7XG59O1xuXG4vKipcbiAqIFxcYnJpZWYgaW5jcmVtZW50IHRoZSBlbnRyeSBvZiB0aGUgdmVjdG9yIG9uIGxvY2FsIHVwZGF0ZVxuICogXFxyZXR1cm4ge19lOiBlbnRyeSwgX2M6IGNvdW50ZXJ9IHVuaXF1ZWx5IGlkZW50aWZ5aW5nIHRoZSBvcGVyYXRpb25cbiAqL1xuVlZ3RS5wcm90b3R5cGUuaW5jcmVtZW50ID0gZnVuY3Rpb24oKXtcbiAgICB0aGlzLmxvY2FsLmluY3JlbWVudCgpO1xuICAgIHJldHVybiB7X2U6IHRoaXMubG9jYWwuZSwgX2M6dGhpcy5sb2NhbC52fTsgXG59O1xuXG5cbi8qKlxuICogXFxicmllZiBpbmNyZW1lbnQgZnJvbSBhIHJlbW90ZSBvcGVyYXRpb25cbiAqIFxccGFyYW0gZWMgdGhlIGVudHJ5IGFuZCBjbG9jayBvZiB0aGUgcmVjZWl2ZWQgZXZlbnQgdG8gYWRkIHN1cHBvc2VkbHkgcmR5XG4gKiB0aGUgdHlwZSBpcyB7X2U6IGVudHJ5LCBfYzogY291bnRlcn1cbiAqL1xuVlZ3RS5wcm90b3R5cGUuaW5jcmVtZW50RnJvbSA9IGZ1bmN0aW9uIChlYyl7XG4gICAgaWYgKCFlYyB8fCAoZWMgJiYgIWVjLl9lKSB8fCAoZWMgJiYgIWVjLl9jKSkge3JldHVybjt9XG4gICAgLy8gIzAgZmluZCB0aGUgZW50cnkgd2l0aGluIHRoZSBhcnJheSBvZiBWVndFbnRyaWVzXG4gICAgdmFyIGluZGV4ID0gdGhpcy52ZWN0b3IuaW5kZXhPZihlYy5fZSk7XG4gICAgaWYgKGluZGV4IDwgMCl7XG4gICAgICAgIC8vICMxIGlmIHRoZSBlbnRyeSBkb2VzIG5vdCBleGlzdCwgaW5pdGlhbGl6ZSBhbmQgaW5jcmVtZW50XG4gICAgICAgIHRoaXMudmVjdG9yLmluc2VydChuZXcgVlZ3RUVudHJ5KGVjLl9lKSk7XG4gICAgICAgIHRoaXMudmVjdG9yLmFyclt0aGlzLnZlY3Rvci5pbmRleE9mKGVjLl9lKV0uaW5jcmVtZW50RnJvbShlYy5fYyk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgLy8gIzIgb3RoZXJ3aXNlLCBvbmx5IGluY3JlbWVudFxuICAgICAgICB0aGlzLnZlY3Rvci5hcnJbaW5kZXhdLmluY3JlbWVudEZyb20oZWMuX2MpO1xuICAgIH07XG59O1xuXG5cbi8qKlxuICogXFxicmllZiBjaGVjayBpZiB0aGUgYXJndW1lbnQgYXJlIGNhdXNhbGx5IHJlYWR5IHJlZ2FyZHMgdG8gdGhpcyB2ZWN0b3JcbiAqIFxccGFyYW0gZWMgdGhlIHNpdGUgY2xvY2sgdGhhdCBoYXBwZW4tYmVmb3JlIHRoZSBjdXJyZW50IGV2ZW50XG4gKi9cblZWd0UucHJvdG90eXBlLmlzUmVhZHkgPSBmdW5jdGlvbihlYyl7XG4gICAgdmFyIHJlYWR5ID0gIWVjO1xuICAgIGlmICghcmVhZHkpe1xuICAgICAgICB2YXIgaW5kZXggPSB0aGlzLnZlY3Rvci5pbmRleE9mKGVjLl9lKTtcbiAgICAgICAgcmVhZHkgPSBpbmRleCA+PTAgJiYgZWMuX2MgPD0gdGhpcy52ZWN0b3IuYXJyW2luZGV4XS52ICYmXG4gICAgICAgICAgICB0aGlzLnZlY3Rvci5hcnJbaW5kZXhdLnguaW5kZXhPZihlYy5fYyk8MDtcbiAgICB9O1xuICAgIHJldHVybiByZWFkeTtcbn07XG5cbi8qKlxuICogXFxicmllZiBjaGVjayBpZiB0aGUgbWVzc2FnZSBjb250YWlucyBpbmZvcm1hdGlvbiBhbHJlYWR5IGRlbGl2ZXJlZFxuICogXFxwYXJhbSBlYyB0aGUgc2l0ZSBjbG9jayB0byBjaGVja1xuICovXG5WVndFLnByb3RvdHlwZS5pc0xvd2VyID0gZnVuY3Rpb24oZWMpe1xuICAgIHJldHVybiAoZWMgJiYgdGhpcy5pc1JlYWR5KGVjKSk7XG59O1xuXG4vKipcbiAqIFxcYnJpZWYgbWVyZ2UgdGhlIHZlcnNpb24gdmVjdG9yIGluIGFyZ3VtZW50IHdpdGggdGhpc1xuICogXFxwYXJhbSBvdGhlciB0aGUgb3RoZXIgdmVyc2lvbiB2ZWN0b3IgdG8gbWVyZ2VcbiAqL1xuVlZ3RS5wcm90b3R5cGUubWVyZ2UgPSBmdW5jdGlvbihvdGhlcil7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBvdGhlci52ZWN0b3IuYXJyLmxlbmd0aDsgKytpKXtcbiAgICAgICAgdmFyIGVudHJ5ID0gb3RoZXIudmVjdG9yLmFycltpXTtcbiAgICAgICAgdmFyIGluZGV4ID0gdGhpcy52ZWN0b3IuaW5kZXhPZihlbnRyeSk7XG4gICAgICAgIGlmIChpbmRleCA8IDApe1xuICAgICAgICAgICAgLy8gIzEgZW50cnkgZG9lcyBub3QgZXhpc3QsIGZ1bGx5IGNvcHkgaXRcbiAgICAgICAgICAgIHZhciBuZXdFbnRyeSA9IG5ldyBWVndFRW50cnkoZW50cnkuZSk7XG4gICAgICAgICAgICBuZXdFbnRyeS52ID0gZW50cnkudjtcbiAgICAgICAgICAgIGZvciAodmFyIGogPSAwOyBqIDwgZW50cnkueC5sZW5ndGg7ICsrail7XG4gICAgICAgICAgICAgICAgbmV3RW50cnkueC5wdXNoKGVudHJ5Lnhbal0pO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIHRoaXMudmVjdG9yLmluc2VydChuZXdFbnRyeSk7XG4gICAgICAgIH1lbHNle1xuICAgICAgICAgICAgLy8gIzIgb3RoZXJ3aXNlIG1lcmdlIHRoZSBlbnRyaWVzXG4gICAgICAgICAgICB2YXIgY3VyckVudHJ5ID0gdGhpcy52ZWN0b3IuYXJyW2ldO1xuICAgICAgICAgICAgLy8gIzJBIHJlbW92ZSB0aGUgZXhjZXB0aW9uIGZyb20gb3VyIHZlY3RvclxuICAgICAgICAgICAgdmFyIGogPSAwO1xuICAgICAgICAgICAgd2hpbGUgKGo8Y3VyckVudHJ5LngubGVuZ3RoKXtcbiAgICAgICAgICAgICAgICBpZiAoY3VyckVudHJ5Lnhbal08ZW50cnkudiAmJlxuICAgICAgICAgICAgICAgICAgICBlbnRyeS54LmluZGV4T2YoY3VyckVudHJ5Lnhbal0pPDApe1xuICAgICAgICAgICAgICAgICAgICBjdXJyRW50cnkueC5zcGxpY2UoaiwgMSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgKytqO1xuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgLy8gIzJCIGFkZCB0aGUgbmV3IGV4Y2VwdGlvbnNcbiAgICAgICAgICAgIGogPSAwO1xuICAgICAgICAgICAgd2hpbGUgKGo8ZW50cnkueC5sZW5ndGgpe1xuICAgICAgICAgICAgICAgIGlmIChlbnRyeS54W2pdID4gY3VyckVudHJ5LnYgJiZcbiAgICAgICAgICAgICAgICAgICAgY3VyckVudHJ5LnguaW5kZXhPZihlbnRyeS54W2pdKTwwKXtcbiAgICAgICAgICAgICAgICAgICAgY3VyckVudHJ5LngucHVzaChlbnRyeS54W2pdKTtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICsrajtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBjdXJyRW50cnkudiA9IE1hdGgubWF4KGN1cnJFbnRyeS52LCBlbnRyeS52KTtcbiAgICAgICAgfTtcbiAgICB9O1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBWVndFO1xuXG4iLCJcbi8qIVxuICBcXGJyaWVmIGNyZWF0ZSBhbiBlbnRyeSBvZiB0aGUgdmVyc2lvbiB2ZWN0b3Igd2l0aCBleGNlcHRpb25zIGNvbnRhaW5pbmcgdGhlXG4gIGluZGV4IG9mIHRoZSBlbnRyeSwgdGhlIHZhbHVlIHYgdGhhdCBjcmVhdGVzIGEgY29udGlndW91cyBpbnRlcnZhbFxuICBmcm9tIDAgdG8gdiwgYW4gYXJyYXkgb2YgaW50ZWdlcnMgdGhhdCBjb250YWluIHRoZSBvcGVyYXRpb25zIGxvd2VyIHRvIHYgdGhhdFxuICBoYXZlIG5vdCBiZWVuIHJlY2VpdmVkIHlldFxuICBcXHBhcmFtIGUgdGhlIGVudHJ5IGluIHRoZSBpbnRlcnZhbCB2ZXJzaW9uIHZlY3RvclxuKi9cbmZ1bmN0aW9uIFZWd0VFbnRyeShlKXtcbiAgICB0aGlzLmUgPSBlOyAgIFxuICAgIHRoaXMudiA9IDA7XG4gICAgdGhpcy54ID0gW107XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgbG9jYWwgY291bnRlciBpbmNyZW1lbnRlZFxuICovXG5WVndFRW50cnkucHJvdG90eXBlLmluY3JlbWVudCA9IGZ1bmN0aW9uKCl7XG4gICAgdGhpcy52ICs9IDE7XG59O1xuXG4vKipcbiAqIFxcYnJpZWYgaW5jcmVtZW50IGZyb20gYSByZW1vdGUgb3BlcmF0aW9uXG4gKiBcXHBhcmFtIGMgdGhlIGNvdW50ZXIgb2YgdGhlIG9wZXJhdGlvbiB0byBhZGQgdG8gdGhpcyBcbiAqL1xuVlZ3RUVudHJ5LnByb3RvdHlwZS5pbmNyZW1lbnRGcm9tID0gZnVuY3Rpb24oYyl7XG4gICAgLy8gIzEgY2hlY2sgaWYgdGhlIGNvdW50ZXIgaXMgaW5jbHVkZWQgaW4gdGhlIGV4Y2VwdGlvbnNcbiAgICBpZiAoYyA8IHRoaXMudil7XG4gICAgICAgIHZhciBpbmRleCA9IHRoaXMueC5pbmRleE9mKGMpO1xuICAgICAgICBpZiAoaW5kZXg+PTApeyAvLyB0aGUgZXhjZXB0aW9uIGlzIGZvdW5kXG4gICAgICAgICAgICB0aGlzLnguc3BsaWNlKGluZGV4LCAxKTtcbiAgICAgICAgfTtcbiAgICB9O1xuICAgIC8vICMyIGlmIHRoZSB2YWx1ZSBpcyArMSBjb21wYXJlZCB0byB0aGUgY3VycmVudCB2YWx1ZSBvZiB0aGUgdmVjdG9yXG4gICAgaWYgKGMgPT0gKHRoaXMudiArIDEpKXtcbiAgICAgICAgdGhpcy52ICs9IDE7XG4gICAgfTtcbiAgICAvLyAjMyBvdGhlcndpc2UgZXhjZXB0aW9uIGFyZSBtYWRlXG4gICAgaWYgKGMgPiAodGhpcy52ICsgMSkpe1xuICAgICAgICBmb3IgKHZhciBpID0gKHRoaXMudiArIDEpOyBpPGM7ICsraSl7XG4gICAgICAgICAgICB0aGlzLngucHVzaChpKTtcbiAgICAgICAgfTtcbiAgICAgICAgdGhpcy52ID0gYztcbiAgICB9O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNvbXBhcmlzb24gZnVuY3Rpb24gYmV0d2VlbiB0d28gVlZ3RSBlbnRyaWVzXG4gKiBcXHBhcmFtIGEgdGhlIGZpcnN0IGVsZW1lbnRcbiAqIFxccGFyYW0gYiB0aGUgc2Vjb25kIGVsZW1lbnRcbiAqIFxccmV0dXJuIC0xIGlmIGEgPCBiLCAxIGlmIGEgPiBiLCAwIG90aGVyd2lzZVxuICovXG5mdW5jdGlvbiBDb21wYXJhdG9yIChhLCBiKXtcbiAgICB2YXIgYUVudHJ5ID0gKGEuZSkgfHwgYTtcbiAgICB2YXIgYkVudHJ5ID0gKGIuZSkgfHwgYjtcbiAgICBpZiAoYUVudHJ5IDwgYkVudHJ5KXsgcmV0dXJuIC0xOyB9O1xuICAgIGlmIChhRW50cnkgPiBiRW50cnkpeyByZXR1cm4gIDE7IH07XG4gICAgcmV0dXJuIDA7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IFZWd0VFbnRyeTtcbm1vZHVsZS5leHBvcnRzLkNvbXBhcmF0b3IgPSBDb21wYXJhdG9yO1xuIixudWxsLCIvKiFcbiAqIFRoZSBidWZmZXIgbW9kdWxlIGZyb20gbm9kZS5qcywgZm9yIHRoZSBicm93c2VyLlxuICpcbiAqIEBhdXRob3IgICBGZXJvc3MgQWJvdWtoYWRpamVoIDxmZXJvc3NAZmVyb3NzLm9yZz4gPGh0dHA6Ly9mZXJvc3Mub3JnPlxuICogQGxpY2Vuc2UgIE1JVFxuICovXG5cbnZhciBiYXNlNjQgPSByZXF1aXJlKCdiYXNlNjQtanMnKVxudmFyIGllZWU3NTQgPSByZXF1aXJlKCdpZWVlNzU0JylcbnZhciBpc0FycmF5ID0gcmVxdWlyZSgnaXMtYXJyYXknKVxuXG5leHBvcnRzLkJ1ZmZlciA9IEJ1ZmZlclxuZXhwb3J0cy5TbG93QnVmZmVyID0gQnVmZmVyXG5leHBvcnRzLklOU1BFQ1RfTUFYX0JZVEVTID0gNTBcbkJ1ZmZlci5wb29sU2l6ZSA9IDgxOTIgLy8gbm90IHVzZWQgYnkgdGhpcyBpbXBsZW1lbnRhdGlvblxuXG52YXIga01heExlbmd0aCA9IDB4M2ZmZmZmZmZcblxuLyoqXG4gKiBJZiBgQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlRgOlxuICogICA9PT0gdHJ1ZSAgICBVc2UgVWludDhBcnJheSBpbXBsZW1lbnRhdGlvbiAoZmFzdGVzdClcbiAqICAgPT09IGZhbHNlICAgVXNlIE9iamVjdCBpbXBsZW1lbnRhdGlvbiAobW9zdCBjb21wYXRpYmxlLCBldmVuIElFNilcbiAqXG4gKiBCcm93c2VycyB0aGF0IHN1cHBvcnQgdHlwZWQgYXJyYXlzIGFyZSBJRSAxMCssIEZpcmVmb3ggNCssIENocm9tZSA3KywgU2FmYXJpIDUuMSssXG4gKiBPcGVyYSAxMS42KywgaU9TIDQuMisuXG4gKlxuICogTm90ZTpcbiAqXG4gKiAtIEltcGxlbWVudGF0aW9uIG11c3Qgc3VwcG9ydCBhZGRpbmcgbmV3IHByb3BlcnRpZXMgdG8gYFVpbnQ4QXJyYXlgIGluc3RhbmNlcy5cbiAqICAgRmlyZWZveCA0LTI5IGxhY2tlZCBzdXBwb3J0LCBmaXhlZCBpbiBGaXJlZm94IDMwKy5cbiAqICAgU2VlOiBodHRwczovL2J1Z3ppbGxhLm1vemlsbGEub3JnL3Nob3dfYnVnLmNnaT9pZD02OTU0MzguXG4gKlxuICogIC0gQ2hyb21lIDktMTAgaXMgbWlzc2luZyB0aGUgYFR5cGVkQXJyYXkucHJvdG90eXBlLnN1YmFycmF5YCBmdW5jdGlvbi5cbiAqXG4gKiAgLSBJRTEwIGhhcyBhIGJyb2tlbiBgVHlwZWRBcnJheS5wcm90b3R5cGUuc3ViYXJyYXlgIGZ1bmN0aW9uIHdoaWNoIHJldHVybnMgYXJyYXlzIG9mXG4gKiAgICBpbmNvcnJlY3QgbGVuZ3RoIGluIHNvbWUgc2l0dWF0aW9ucy5cbiAqXG4gKiBXZSBkZXRlY3QgdGhlc2UgYnVnZ3kgYnJvd3NlcnMgYW5kIHNldCBgQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlRgIHRvIGBmYWxzZWAgc28gdGhleSB3aWxsXG4gKiBnZXQgdGhlIE9iamVjdCBpbXBsZW1lbnRhdGlvbiwgd2hpY2ggaXMgc2xvd2VyIGJ1dCB3aWxsIHdvcmsgY29ycmVjdGx5LlxuICovXG5CdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCA9IChmdW5jdGlvbiAoKSB7XG4gIHRyeSB7XG4gICAgdmFyIGJ1ZiA9IG5ldyBBcnJheUJ1ZmZlcigwKVxuICAgIHZhciBhcnIgPSBuZXcgVWludDhBcnJheShidWYpXG4gICAgYXJyLmZvbyA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuIDQyIH1cbiAgICByZXR1cm4gNDIgPT09IGFyci5mb28oKSAmJiAvLyB0eXBlZCBhcnJheSBpbnN0YW5jZXMgY2FuIGJlIGF1Z21lbnRlZFxuICAgICAgICB0eXBlb2YgYXJyLnN1YmFycmF5ID09PSAnZnVuY3Rpb24nICYmIC8vIGNocm9tZSA5LTEwIGxhY2sgYHN1YmFycmF5YFxuICAgICAgICBuZXcgVWludDhBcnJheSgxKS5zdWJhcnJheSgxLCAxKS5ieXRlTGVuZ3RoID09PSAwIC8vIGllMTAgaGFzIGJyb2tlbiBgc3ViYXJyYXlgXG4gIH0gY2F0Y2ggKGUpIHtcbiAgICByZXR1cm4gZmFsc2VcbiAgfVxufSkoKVxuXG4vKipcbiAqIENsYXNzOiBCdWZmZXJcbiAqID09PT09PT09PT09PT1cbiAqXG4gKiBUaGUgQnVmZmVyIGNvbnN0cnVjdG9yIHJldHVybnMgaW5zdGFuY2VzIG9mIGBVaW50OEFycmF5YCB0aGF0IGFyZSBhdWdtZW50ZWRcbiAqIHdpdGggZnVuY3Rpb24gcHJvcGVydGllcyBmb3IgYWxsIHRoZSBub2RlIGBCdWZmZXJgIEFQSSBmdW5jdGlvbnMuIFdlIHVzZVxuICogYFVpbnQ4QXJyYXlgIHNvIHRoYXQgc3F1YXJlIGJyYWNrZXQgbm90YXRpb24gd29ya3MgYXMgZXhwZWN0ZWQgLS0gaXQgcmV0dXJuc1xuICogYSBzaW5nbGUgb2N0ZXQuXG4gKlxuICogQnkgYXVnbWVudGluZyB0aGUgaW5zdGFuY2VzLCB3ZSBjYW4gYXZvaWQgbW9kaWZ5aW5nIHRoZSBgVWludDhBcnJheWBcbiAqIHByb3RvdHlwZS5cbiAqL1xuZnVuY3Rpb24gQnVmZmVyIChzdWJqZWN0LCBlbmNvZGluZywgbm9aZXJvKSB7XG4gIGlmICghKHRoaXMgaW5zdGFuY2VvZiBCdWZmZXIpKVxuICAgIHJldHVybiBuZXcgQnVmZmVyKHN1YmplY3QsIGVuY29kaW5nLCBub1plcm8pXG5cbiAgdmFyIHR5cGUgPSB0eXBlb2Ygc3ViamVjdFxuXG4gIC8vIEZpbmQgdGhlIGxlbmd0aFxuICB2YXIgbGVuZ3RoXG4gIGlmICh0eXBlID09PSAnbnVtYmVyJylcbiAgICBsZW5ndGggPSBzdWJqZWN0ID4gMCA/IHN1YmplY3QgPj4+IDAgOiAwXG4gIGVsc2UgaWYgKHR5cGUgPT09ICdzdHJpbmcnKSB7XG4gICAgaWYgKGVuY29kaW5nID09PSAnYmFzZTY0JylcbiAgICAgIHN1YmplY3QgPSBiYXNlNjRjbGVhbihzdWJqZWN0KVxuICAgIGxlbmd0aCA9IEJ1ZmZlci5ieXRlTGVuZ3RoKHN1YmplY3QsIGVuY29kaW5nKVxuICB9IGVsc2UgaWYgKHR5cGUgPT09ICdvYmplY3QnICYmIHN1YmplY3QgIT09IG51bGwpIHsgLy8gYXNzdW1lIG9iamVjdCBpcyBhcnJheS1saWtlXG4gICAgaWYgKHN1YmplY3QudHlwZSA9PT0gJ0J1ZmZlcicgJiYgaXNBcnJheShzdWJqZWN0LmRhdGEpKVxuICAgICAgc3ViamVjdCA9IHN1YmplY3QuZGF0YVxuICAgIGxlbmd0aCA9ICtzdWJqZWN0Lmxlbmd0aCA+IDAgPyBNYXRoLmZsb29yKCtzdWJqZWN0Lmxlbmd0aCkgOiAwXG4gIH0gZWxzZVxuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ211c3Qgc3RhcnQgd2l0aCBudW1iZXIsIGJ1ZmZlciwgYXJyYXkgb3Igc3RyaW5nJylcblxuICBpZiAodGhpcy5sZW5ndGggPiBrTWF4TGVuZ3RoKVxuICAgIHRocm93IG5ldyBSYW5nZUVycm9yKCdBdHRlbXB0IHRvIGFsbG9jYXRlIEJ1ZmZlciBsYXJnZXIgdGhhbiBtYXhpbXVtICcgK1xuICAgICAgJ3NpemU6IDB4JyArIGtNYXhMZW5ndGgudG9TdHJpbmcoMTYpICsgJyBieXRlcycpXG5cbiAgdmFyIGJ1ZlxuICBpZiAoQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHtcbiAgICAvLyBQcmVmZXJyZWQ6IFJldHVybiBhbiBhdWdtZW50ZWQgYFVpbnQ4QXJyYXlgIGluc3RhbmNlIGZvciBiZXN0IHBlcmZvcm1hbmNlXG4gICAgYnVmID0gQnVmZmVyLl9hdWdtZW50KG5ldyBVaW50OEFycmF5KGxlbmd0aCkpXG4gIH0gZWxzZSB7XG4gICAgLy8gRmFsbGJhY2s6IFJldHVybiBUSElTIGluc3RhbmNlIG9mIEJ1ZmZlciAoY3JlYXRlZCBieSBgbmV3YClcbiAgICBidWYgPSB0aGlzXG4gICAgYnVmLmxlbmd0aCA9IGxlbmd0aFxuICAgIGJ1Zi5faXNCdWZmZXIgPSB0cnVlXG4gIH1cblxuICB2YXIgaVxuICBpZiAoQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQgJiYgdHlwZW9mIHN1YmplY3QuYnl0ZUxlbmd0aCA9PT0gJ251bWJlcicpIHtcbiAgICAvLyBTcGVlZCBvcHRpbWl6YXRpb24gLS0gdXNlIHNldCBpZiB3ZSdyZSBjb3B5aW5nIGZyb20gYSB0eXBlZCBhcnJheVxuICAgIGJ1Zi5fc2V0KHN1YmplY3QpXG4gIH0gZWxzZSBpZiAoaXNBcnJheWlzaChzdWJqZWN0KSkge1xuICAgIC8vIFRyZWF0IGFycmF5LWlzaCBvYmplY3RzIGFzIGEgYnl0ZSBhcnJheVxuICAgIGlmIChCdWZmZXIuaXNCdWZmZXIoc3ViamVjdCkpIHtcbiAgICAgIGZvciAoaSA9IDA7IGkgPCBsZW5ndGg7IGkrKylcbiAgICAgICAgYnVmW2ldID0gc3ViamVjdC5yZWFkVUludDgoaSlcbiAgICB9IGVsc2Uge1xuICAgICAgZm9yIChpID0gMDsgaSA8IGxlbmd0aDsgaSsrKVxuICAgICAgICBidWZbaV0gPSAoKHN1YmplY3RbaV0gJSAyNTYpICsgMjU2KSAlIDI1NlxuICAgIH1cbiAgfSBlbHNlIGlmICh0eXBlID09PSAnc3RyaW5nJykge1xuICAgIGJ1Zi53cml0ZShzdWJqZWN0LCAwLCBlbmNvZGluZylcbiAgfSBlbHNlIGlmICh0eXBlID09PSAnbnVtYmVyJyAmJiAhQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQgJiYgIW5vWmVybykge1xuICAgIGZvciAoaSA9IDA7IGkgPCBsZW5ndGg7IGkrKykge1xuICAgICAgYnVmW2ldID0gMFxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBidWZcbn1cblxuQnVmZmVyLmlzQnVmZmVyID0gZnVuY3Rpb24gKGIpIHtcbiAgcmV0dXJuICEhKGIgIT0gbnVsbCAmJiBiLl9pc0J1ZmZlcilcbn1cblxuQnVmZmVyLmNvbXBhcmUgPSBmdW5jdGlvbiAoYSwgYikge1xuICBpZiAoIUJ1ZmZlci5pc0J1ZmZlcihhKSB8fCAhQnVmZmVyLmlzQnVmZmVyKGIpKVxuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0FyZ3VtZW50cyBtdXN0IGJlIEJ1ZmZlcnMnKVxuXG4gIHZhciB4ID0gYS5sZW5ndGhcbiAgdmFyIHkgPSBiLmxlbmd0aFxuICBmb3IgKHZhciBpID0gMCwgbGVuID0gTWF0aC5taW4oeCwgeSk7IGkgPCBsZW4gJiYgYVtpXSA9PT0gYltpXTsgaSsrKSB7fVxuICBpZiAoaSAhPT0gbGVuKSB7XG4gICAgeCA9IGFbaV1cbiAgICB5ID0gYltpXVxuICB9XG4gIGlmICh4IDwgeSkgcmV0dXJuIC0xXG4gIGlmICh5IDwgeCkgcmV0dXJuIDFcbiAgcmV0dXJuIDBcbn1cblxuQnVmZmVyLmlzRW5jb2RpbmcgPSBmdW5jdGlvbiAoZW5jb2RpbmcpIHtcbiAgc3dpdGNoIChTdHJpbmcoZW5jb2RpbmcpLnRvTG93ZXJDYXNlKCkpIHtcbiAgICBjYXNlICdoZXgnOlxuICAgIGNhc2UgJ3V0ZjgnOlxuICAgIGNhc2UgJ3V0Zi04JzpcbiAgICBjYXNlICdhc2NpaSc6XG4gICAgY2FzZSAnYmluYXJ5JzpcbiAgICBjYXNlICdiYXNlNjQnOlxuICAgIGNhc2UgJ3Jhdyc6XG4gICAgY2FzZSAndWNzMic6XG4gICAgY2FzZSAndWNzLTInOlxuICAgIGNhc2UgJ3V0ZjE2bGUnOlxuICAgIGNhc2UgJ3V0Zi0xNmxlJzpcbiAgICAgIHJldHVybiB0cnVlXG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiBmYWxzZVxuICB9XG59XG5cbkJ1ZmZlci5jb25jYXQgPSBmdW5jdGlvbiAobGlzdCwgdG90YWxMZW5ndGgpIHtcbiAgaWYgKCFpc0FycmF5KGxpc3QpKSB0aHJvdyBuZXcgVHlwZUVycm9yKCdVc2FnZTogQnVmZmVyLmNvbmNhdChsaXN0WywgbGVuZ3RoXSknKVxuXG4gIGlmIChsaXN0Lmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBuZXcgQnVmZmVyKDApXG4gIH0gZWxzZSBpZiAobGlzdC5sZW5ndGggPT09IDEpIHtcbiAgICByZXR1cm4gbGlzdFswXVxuICB9XG5cbiAgdmFyIGlcbiAgaWYgKHRvdGFsTGVuZ3RoID09PSB1bmRlZmluZWQpIHtcbiAgICB0b3RhbExlbmd0aCA9IDBcbiAgICBmb3IgKGkgPSAwOyBpIDwgbGlzdC5sZW5ndGg7IGkrKykge1xuICAgICAgdG90YWxMZW5ndGggKz0gbGlzdFtpXS5sZW5ndGhcbiAgICB9XG4gIH1cblxuICB2YXIgYnVmID0gbmV3IEJ1ZmZlcih0b3RhbExlbmd0aClcbiAgdmFyIHBvcyA9IDBcbiAgZm9yIChpID0gMDsgaSA8IGxpc3QubGVuZ3RoOyBpKyspIHtcbiAgICB2YXIgaXRlbSA9IGxpc3RbaV1cbiAgICBpdGVtLmNvcHkoYnVmLCBwb3MpXG4gICAgcG9zICs9IGl0ZW0ubGVuZ3RoXG4gIH1cbiAgcmV0dXJuIGJ1ZlxufVxuXG5CdWZmZXIuYnl0ZUxlbmd0aCA9IGZ1bmN0aW9uIChzdHIsIGVuY29kaW5nKSB7XG4gIHZhciByZXRcbiAgc3RyID0gc3RyICsgJydcbiAgc3dpdGNoIChlbmNvZGluZyB8fCAndXRmOCcpIHtcbiAgICBjYXNlICdhc2NpaSc6XG4gICAgY2FzZSAnYmluYXJ5JzpcbiAgICBjYXNlICdyYXcnOlxuICAgICAgcmV0ID0gc3RyLmxlbmd0aFxuICAgICAgYnJlYWtcbiAgICBjYXNlICd1Y3MyJzpcbiAgICBjYXNlICd1Y3MtMic6XG4gICAgY2FzZSAndXRmMTZsZSc6XG4gICAgY2FzZSAndXRmLTE2bGUnOlxuICAgICAgcmV0ID0gc3RyLmxlbmd0aCAqIDJcbiAgICAgIGJyZWFrXG4gICAgY2FzZSAnaGV4JzpcbiAgICAgIHJldCA9IHN0ci5sZW5ndGggPj4+IDFcbiAgICAgIGJyZWFrXG4gICAgY2FzZSAndXRmOCc6XG4gICAgY2FzZSAndXRmLTgnOlxuICAgICAgcmV0ID0gdXRmOFRvQnl0ZXMoc3RyKS5sZW5ndGhcbiAgICAgIGJyZWFrXG4gICAgY2FzZSAnYmFzZTY0JzpcbiAgICAgIHJldCA9IGJhc2U2NFRvQnl0ZXMoc3RyKS5sZW5ndGhcbiAgICAgIGJyZWFrXG4gICAgZGVmYXVsdDpcbiAgICAgIHJldCA9IHN0ci5sZW5ndGhcbiAgfVxuICByZXR1cm4gcmV0XG59XG5cbi8vIHByZS1zZXQgZm9yIHZhbHVlcyB0aGF0IG1heSBleGlzdCBpbiB0aGUgZnV0dXJlXG5CdWZmZXIucHJvdG90eXBlLmxlbmd0aCA9IHVuZGVmaW5lZFxuQnVmZmVyLnByb3RvdHlwZS5wYXJlbnQgPSB1bmRlZmluZWRcblxuLy8gdG9TdHJpbmcoZW5jb2RpbmcsIHN0YXJ0PTAsIGVuZD1idWZmZXIubGVuZ3RoKVxuQnVmZmVyLnByb3RvdHlwZS50b1N0cmluZyA9IGZ1bmN0aW9uIChlbmNvZGluZywgc3RhcnQsIGVuZCkge1xuICB2YXIgbG93ZXJlZENhc2UgPSBmYWxzZVxuXG4gIHN0YXJ0ID0gc3RhcnQgPj4+IDBcbiAgZW5kID0gZW5kID09PSB1bmRlZmluZWQgfHwgZW5kID09PSBJbmZpbml0eSA/IHRoaXMubGVuZ3RoIDogZW5kID4+PiAwXG5cbiAgaWYgKCFlbmNvZGluZykgZW5jb2RpbmcgPSAndXRmOCdcbiAgaWYgKHN0YXJ0IDwgMCkgc3RhcnQgPSAwXG4gIGlmIChlbmQgPiB0aGlzLmxlbmd0aCkgZW5kID0gdGhpcy5sZW5ndGhcbiAgaWYgKGVuZCA8PSBzdGFydCkgcmV0dXJuICcnXG5cbiAgd2hpbGUgKHRydWUpIHtcbiAgICBzd2l0Y2ggKGVuY29kaW5nKSB7XG4gICAgICBjYXNlICdoZXgnOlxuICAgICAgICByZXR1cm4gaGV4U2xpY2UodGhpcywgc3RhcnQsIGVuZClcblxuICAgICAgY2FzZSAndXRmOCc6XG4gICAgICBjYXNlICd1dGYtOCc6XG4gICAgICAgIHJldHVybiB1dGY4U2xpY2UodGhpcywgc3RhcnQsIGVuZClcblxuICAgICAgY2FzZSAnYXNjaWknOlxuICAgICAgICByZXR1cm4gYXNjaWlTbGljZSh0aGlzLCBzdGFydCwgZW5kKVxuXG4gICAgICBjYXNlICdiaW5hcnknOlxuICAgICAgICByZXR1cm4gYmluYXJ5U2xpY2UodGhpcywgc3RhcnQsIGVuZClcblxuICAgICAgY2FzZSAnYmFzZTY0JzpcbiAgICAgICAgcmV0dXJuIGJhc2U2NFNsaWNlKHRoaXMsIHN0YXJ0LCBlbmQpXG5cbiAgICAgIGNhc2UgJ3VjczInOlxuICAgICAgY2FzZSAndWNzLTInOlxuICAgICAgY2FzZSAndXRmMTZsZSc6XG4gICAgICBjYXNlICd1dGYtMTZsZSc6XG4gICAgICAgIHJldHVybiB1dGYxNmxlU2xpY2UodGhpcywgc3RhcnQsIGVuZClcblxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgaWYgKGxvd2VyZWRDYXNlKVxuICAgICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ1Vua25vd24gZW5jb2Rpbmc6ICcgKyBlbmNvZGluZylcbiAgICAgICAgZW5jb2RpbmcgPSAoZW5jb2RpbmcgKyAnJykudG9Mb3dlckNhc2UoKVxuICAgICAgICBsb3dlcmVkQ2FzZSA9IHRydWVcbiAgICB9XG4gIH1cbn1cblxuQnVmZmVyLnByb3RvdHlwZS5lcXVhbHMgPSBmdW5jdGlvbiAoYikge1xuICBpZighQnVmZmVyLmlzQnVmZmVyKGIpKSB0aHJvdyBuZXcgVHlwZUVycm9yKCdBcmd1bWVudCBtdXN0IGJlIGEgQnVmZmVyJylcbiAgcmV0dXJuIEJ1ZmZlci5jb21wYXJlKHRoaXMsIGIpID09PSAwXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUuaW5zcGVjdCA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHN0ciA9ICcnXG4gIHZhciBtYXggPSBleHBvcnRzLklOU1BFQ1RfTUFYX0JZVEVTXG4gIGlmICh0aGlzLmxlbmd0aCA+IDApIHtcbiAgICBzdHIgPSB0aGlzLnRvU3RyaW5nKCdoZXgnLCAwLCBtYXgpLm1hdGNoKC8uezJ9L2cpLmpvaW4oJyAnKVxuICAgIGlmICh0aGlzLmxlbmd0aCA+IG1heClcbiAgICAgIHN0ciArPSAnIC4uLiAnXG4gIH1cbiAgcmV0dXJuICc8QnVmZmVyICcgKyBzdHIgKyAnPidcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5jb21wYXJlID0gZnVuY3Rpb24gKGIpIHtcbiAgaWYgKCFCdWZmZXIuaXNCdWZmZXIoYikpIHRocm93IG5ldyBUeXBlRXJyb3IoJ0FyZ3VtZW50IG11c3QgYmUgYSBCdWZmZXInKVxuICByZXR1cm4gQnVmZmVyLmNvbXBhcmUodGhpcywgYilcbn1cblxuLy8gYGdldGAgd2lsbCBiZSByZW1vdmVkIGluIE5vZGUgMC4xMytcbkJ1ZmZlci5wcm90b3R5cGUuZ2V0ID0gZnVuY3Rpb24gKG9mZnNldCkge1xuICBjb25zb2xlLmxvZygnLmdldCgpIGlzIGRlcHJlY2F0ZWQuIEFjY2VzcyB1c2luZyBhcnJheSBpbmRleGVzIGluc3RlYWQuJylcbiAgcmV0dXJuIHRoaXMucmVhZFVJbnQ4KG9mZnNldClcbn1cblxuLy8gYHNldGAgd2lsbCBiZSByZW1vdmVkIGluIE5vZGUgMC4xMytcbkJ1ZmZlci5wcm90b3R5cGUuc2V0ID0gZnVuY3Rpb24gKHYsIG9mZnNldCkge1xuICBjb25zb2xlLmxvZygnLnNldCgpIGlzIGRlcHJlY2F0ZWQuIEFjY2VzcyB1c2luZyBhcnJheSBpbmRleGVzIGluc3RlYWQuJylcbiAgcmV0dXJuIHRoaXMud3JpdGVVSW50OCh2LCBvZmZzZXQpXG59XG5cbmZ1bmN0aW9uIGhleFdyaXRlIChidWYsIHN0cmluZywgb2Zmc2V0LCBsZW5ndGgpIHtcbiAgb2Zmc2V0ID0gTnVtYmVyKG9mZnNldCkgfHwgMFxuICB2YXIgcmVtYWluaW5nID0gYnVmLmxlbmd0aCAtIG9mZnNldFxuICBpZiAoIWxlbmd0aCkge1xuICAgIGxlbmd0aCA9IHJlbWFpbmluZ1xuICB9IGVsc2Uge1xuICAgIGxlbmd0aCA9IE51bWJlcihsZW5ndGgpXG4gICAgaWYgKGxlbmd0aCA+IHJlbWFpbmluZykge1xuICAgICAgbGVuZ3RoID0gcmVtYWluaW5nXG4gICAgfVxuICB9XG5cbiAgLy8gbXVzdCBiZSBhbiBldmVuIG51bWJlciBvZiBkaWdpdHNcbiAgdmFyIHN0ckxlbiA9IHN0cmluZy5sZW5ndGhcbiAgaWYgKHN0ckxlbiAlIDIgIT09IDApIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBoZXggc3RyaW5nJylcblxuICBpZiAobGVuZ3RoID4gc3RyTGVuIC8gMikge1xuICAgIGxlbmd0aCA9IHN0ckxlbiAvIDJcbiAgfVxuICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIGJ5dGUgPSBwYXJzZUludChzdHJpbmcuc3Vic3RyKGkgKiAyLCAyKSwgMTYpXG4gICAgaWYgKGlzTmFOKGJ5dGUpKSB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgaGV4IHN0cmluZycpXG4gICAgYnVmW29mZnNldCArIGldID0gYnl0ZVxuICB9XG4gIHJldHVybiBpXG59XG5cbmZ1bmN0aW9uIHV0ZjhXcml0ZSAoYnVmLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKSB7XG4gIHZhciBjaGFyc1dyaXR0ZW4gPSBibGl0QnVmZmVyKHV0ZjhUb0J5dGVzKHN0cmluZyksIGJ1Ziwgb2Zmc2V0LCBsZW5ndGgpXG4gIHJldHVybiBjaGFyc1dyaXR0ZW5cbn1cblxuZnVuY3Rpb24gYXNjaWlXcml0ZSAoYnVmLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKSB7XG4gIHZhciBjaGFyc1dyaXR0ZW4gPSBibGl0QnVmZmVyKGFzY2lpVG9CeXRlcyhzdHJpbmcpLCBidWYsIG9mZnNldCwgbGVuZ3RoKVxuICByZXR1cm4gY2hhcnNXcml0dGVuXG59XG5cbmZ1bmN0aW9uIGJpbmFyeVdyaXRlIChidWYsIHN0cmluZywgb2Zmc2V0LCBsZW5ndGgpIHtcbiAgcmV0dXJuIGFzY2lpV3JpdGUoYnVmLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKVxufVxuXG5mdW5jdGlvbiBiYXNlNjRXcml0ZSAoYnVmLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKSB7XG4gIHZhciBjaGFyc1dyaXR0ZW4gPSBibGl0QnVmZmVyKGJhc2U2NFRvQnl0ZXMoc3RyaW5nKSwgYnVmLCBvZmZzZXQsIGxlbmd0aClcbiAgcmV0dXJuIGNoYXJzV3JpdHRlblxufVxuXG5mdW5jdGlvbiB1dGYxNmxlV3JpdGUgKGJ1Ziwgc3RyaW5nLCBvZmZzZXQsIGxlbmd0aCkge1xuICB2YXIgY2hhcnNXcml0dGVuID0gYmxpdEJ1ZmZlcih1dGYxNmxlVG9CeXRlcyhzdHJpbmcpLCBidWYsIG9mZnNldCwgbGVuZ3RoKVxuICByZXR1cm4gY2hhcnNXcml0dGVuXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUud3JpdGUgPSBmdW5jdGlvbiAoc3RyaW5nLCBvZmZzZXQsIGxlbmd0aCwgZW5jb2RpbmcpIHtcbiAgLy8gU3VwcG9ydCBib3RoIChzdHJpbmcsIG9mZnNldCwgbGVuZ3RoLCBlbmNvZGluZylcbiAgLy8gYW5kIHRoZSBsZWdhY3kgKHN0cmluZywgZW5jb2RpbmcsIG9mZnNldCwgbGVuZ3RoKVxuICBpZiAoaXNGaW5pdGUob2Zmc2V0KSkge1xuICAgIGlmICghaXNGaW5pdGUobGVuZ3RoKSkge1xuICAgICAgZW5jb2RpbmcgPSBsZW5ndGhcbiAgICAgIGxlbmd0aCA9IHVuZGVmaW5lZFxuICAgIH1cbiAgfSBlbHNlIHsgIC8vIGxlZ2FjeVxuICAgIHZhciBzd2FwID0gZW5jb2RpbmdcbiAgICBlbmNvZGluZyA9IG9mZnNldFxuICAgIG9mZnNldCA9IGxlbmd0aFxuICAgIGxlbmd0aCA9IHN3YXBcbiAgfVxuXG4gIG9mZnNldCA9IE51bWJlcihvZmZzZXQpIHx8IDBcbiAgdmFyIHJlbWFpbmluZyA9IHRoaXMubGVuZ3RoIC0gb2Zmc2V0XG4gIGlmICghbGVuZ3RoKSB7XG4gICAgbGVuZ3RoID0gcmVtYWluaW5nXG4gIH0gZWxzZSB7XG4gICAgbGVuZ3RoID0gTnVtYmVyKGxlbmd0aClcbiAgICBpZiAobGVuZ3RoID4gcmVtYWluaW5nKSB7XG4gICAgICBsZW5ndGggPSByZW1haW5pbmdcbiAgICB9XG4gIH1cbiAgZW5jb2RpbmcgPSBTdHJpbmcoZW5jb2RpbmcgfHwgJ3V0ZjgnKS50b0xvd2VyQ2FzZSgpXG5cbiAgdmFyIHJldFxuICBzd2l0Y2ggKGVuY29kaW5nKSB7XG4gICAgY2FzZSAnaGV4JzpcbiAgICAgIHJldCA9IGhleFdyaXRlKHRoaXMsIHN0cmluZywgb2Zmc2V0LCBsZW5ndGgpXG4gICAgICBicmVha1xuICAgIGNhc2UgJ3V0ZjgnOlxuICAgIGNhc2UgJ3V0Zi04JzpcbiAgICAgIHJldCA9IHV0ZjhXcml0ZSh0aGlzLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKVxuICAgICAgYnJlYWtcbiAgICBjYXNlICdhc2NpaSc6XG4gICAgICByZXQgPSBhc2NpaVdyaXRlKHRoaXMsIHN0cmluZywgb2Zmc2V0LCBsZW5ndGgpXG4gICAgICBicmVha1xuICAgIGNhc2UgJ2JpbmFyeSc6XG4gICAgICByZXQgPSBiaW5hcnlXcml0ZSh0aGlzLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKVxuICAgICAgYnJlYWtcbiAgICBjYXNlICdiYXNlNjQnOlxuICAgICAgcmV0ID0gYmFzZTY0V3JpdGUodGhpcywgc3RyaW5nLCBvZmZzZXQsIGxlbmd0aClcbiAgICAgIGJyZWFrXG4gICAgY2FzZSAndWNzMic6XG4gICAgY2FzZSAndWNzLTInOlxuICAgIGNhc2UgJ3V0ZjE2bGUnOlxuICAgIGNhc2UgJ3V0Zi0xNmxlJzpcbiAgICAgIHJldCA9IHV0ZjE2bGVXcml0ZSh0aGlzLCBzdHJpbmcsIG9mZnNldCwgbGVuZ3RoKVxuICAgICAgYnJlYWtcbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignVW5rbm93biBlbmNvZGluZzogJyArIGVuY29kaW5nKVxuICB9XG4gIHJldHVybiByZXRcbn1cblxuQnVmZmVyLnByb3RvdHlwZS50b0pTT04gPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiB7XG4gICAgdHlwZTogJ0J1ZmZlcicsXG4gICAgZGF0YTogQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwodGhpcy5fYXJyIHx8IHRoaXMsIDApXG4gIH1cbn1cblxuZnVuY3Rpb24gYmFzZTY0U2xpY2UgKGJ1Ziwgc3RhcnQsIGVuZCkge1xuICBpZiAoc3RhcnQgPT09IDAgJiYgZW5kID09PSBidWYubGVuZ3RoKSB7XG4gICAgcmV0dXJuIGJhc2U2NC5mcm9tQnl0ZUFycmF5KGJ1ZilcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gYmFzZTY0LmZyb21CeXRlQXJyYXkoYnVmLnNsaWNlKHN0YXJ0LCBlbmQpKVxuICB9XG59XG5cbmZ1bmN0aW9uIHV0ZjhTbGljZSAoYnVmLCBzdGFydCwgZW5kKSB7XG4gIHZhciByZXMgPSAnJ1xuICB2YXIgdG1wID0gJydcbiAgZW5kID0gTWF0aC5taW4oYnVmLmxlbmd0aCwgZW5kKVxuXG4gIGZvciAodmFyIGkgPSBzdGFydDsgaSA8IGVuZDsgaSsrKSB7XG4gICAgaWYgKGJ1ZltpXSA8PSAweDdGKSB7XG4gICAgICByZXMgKz0gZGVjb2RlVXRmOENoYXIodG1wKSArIFN0cmluZy5mcm9tQ2hhckNvZGUoYnVmW2ldKVxuICAgICAgdG1wID0gJydcbiAgICB9IGVsc2Uge1xuICAgICAgdG1wICs9ICclJyArIGJ1ZltpXS50b1N0cmluZygxNilcbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzICsgZGVjb2RlVXRmOENoYXIodG1wKVxufVxuXG5mdW5jdGlvbiBhc2NpaVNsaWNlIChidWYsIHN0YXJ0LCBlbmQpIHtcbiAgdmFyIHJldCA9ICcnXG4gIGVuZCA9IE1hdGgubWluKGJ1Zi5sZW5ndGgsIGVuZClcblxuICBmb3IgKHZhciBpID0gc3RhcnQ7IGkgPCBlbmQ7IGkrKykge1xuICAgIHJldCArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGJ1ZltpXSlcbiAgfVxuICByZXR1cm4gcmV0XG59XG5cbmZ1bmN0aW9uIGJpbmFyeVNsaWNlIChidWYsIHN0YXJ0LCBlbmQpIHtcbiAgcmV0dXJuIGFzY2lpU2xpY2UoYnVmLCBzdGFydCwgZW5kKVxufVxuXG5mdW5jdGlvbiBoZXhTbGljZSAoYnVmLCBzdGFydCwgZW5kKSB7XG4gIHZhciBsZW4gPSBidWYubGVuZ3RoXG5cbiAgaWYgKCFzdGFydCB8fCBzdGFydCA8IDApIHN0YXJ0ID0gMFxuICBpZiAoIWVuZCB8fCBlbmQgPCAwIHx8IGVuZCA+IGxlbikgZW5kID0gbGVuXG5cbiAgdmFyIG91dCA9ICcnXG4gIGZvciAodmFyIGkgPSBzdGFydDsgaSA8IGVuZDsgaSsrKSB7XG4gICAgb3V0ICs9IHRvSGV4KGJ1ZltpXSlcbiAgfVxuICByZXR1cm4gb3V0XG59XG5cbmZ1bmN0aW9uIHV0ZjE2bGVTbGljZSAoYnVmLCBzdGFydCwgZW5kKSB7XG4gIHZhciBieXRlcyA9IGJ1Zi5zbGljZShzdGFydCwgZW5kKVxuICB2YXIgcmVzID0gJydcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBieXRlcy5sZW5ndGg7IGkgKz0gMikge1xuICAgIHJlcyArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGJ5dGVzW2ldICsgYnl0ZXNbaSArIDFdICogMjU2KVxuICB9XG4gIHJldHVybiByZXNcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5zbGljZSA9IGZ1bmN0aW9uIChzdGFydCwgZW5kKSB7XG4gIHZhciBsZW4gPSB0aGlzLmxlbmd0aFxuICBzdGFydCA9IH5+c3RhcnRcbiAgZW5kID0gZW5kID09PSB1bmRlZmluZWQgPyBsZW4gOiB+fmVuZFxuXG4gIGlmIChzdGFydCA8IDApIHtcbiAgICBzdGFydCArPSBsZW47XG4gICAgaWYgKHN0YXJ0IDwgMClcbiAgICAgIHN0YXJ0ID0gMFxuICB9IGVsc2UgaWYgKHN0YXJ0ID4gbGVuKSB7XG4gICAgc3RhcnQgPSBsZW5cbiAgfVxuXG4gIGlmIChlbmQgPCAwKSB7XG4gICAgZW5kICs9IGxlblxuICAgIGlmIChlbmQgPCAwKVxuICAgICAgZW5kID0gMFxuICB9IGVsc2UgaWYgKGVuZCA+IGxlbikge1xuICAgIGVuZCA9IGxlblxuICB9XG5cbiAgaWYgKGVuZCA8IHN0YXJ0KVxuICAgIGVuZCA9IHN0YXJ0XG5cbiAgaWYgKEJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUKSB7XG4gICAgcmV0dXJuIEJ1ZmZlci5fYXVnbWVudCh0aGlzLnN1YmFycmF5KHN0YXJ0LCBlbmQpKVxuICB9IGVsc2Uge1xuICAgIHZhciBzbGljZUxlbiA9IGVuZCAtIHN0YXJ0XG4gICAgdmFyIG5ld0J1ZiA9IG5ldyBCdWZmZXIoc2xpY2VMZW4sIHVuZGVmaW5lZCwgdHJ1ZSlcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHNsaWNlTGVuOyBpKyspIHtcbiAgICAgIG5ld0J1ZltpXSA9IHRoaXNbaSArIHN0YXJ0XVxuICAgIH1cbiAgICByZXR1cm4gbmV3QnVmXG4gIH1cbn1cblxuLypcbiAqIE5lZWQgdG8gbWFrZSBzdXJlIHRoYXQgYnVmZmVyIGlzbid0IHRyeWluZyB0byB3cml0ZSBvdXQgb2YgYm91bmRzLlxuICovXG5mdW5jdGlvbiBjaGVja09mZnNldCAob2Zmc2V0LCBleHQsIGxlbmd0aCkge1xuICBpZiAoKG9mZnNldCAlIDEpICE9PSAwIHx8IG9mZnNldCA8IDApXG4gICAgdGhyb3cgbmV3IFJhbmdlRXJyb3IoJ29mZnNldCBpcyBub3QgdWludCcpXG4gIGlmIChvZmZzZXQgKyBleHQgPiBsZW5ndGgpXG4gICAgdGhyb3cgbmV3IFJhbmdlRXJyb3IoJ1RyeWluZyB0byBhY2Nlc3MgYmV5b25kIGJ1ZmZlciBsZW5ndGgnKVxufVxuXG5CdWZmZXIucHJvdG90eXBlLnJlYWRVSW50OCA9IGZ1bmN0aW9uIChvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIGlmICghbm9Bc3NlcnQpXG4gICAgY2hlY2tPZmZzZXQob2Zmc2V0LCAxLCB0aGlzLmxlbmd0aClcbiAgcmV0dXJuIHRoaXNbb2Zmc2V0XVxufVxuXG5CdWZmZXIucHJvdG90eXBlLnJlYWRVSW50MTZMRSA9IGZ1bmN0aW9uIChvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIGlmICghbm9Bc3NlcnQpXG4gICAgY2hlY2tPZmZzZXQob2Zmc2V0LCAyLCB0aGlzLmxlbmd0aClcbiAgcmV0dXJuIHRoaXNbb2Zmc2V0XSB8ICh0aGlzW29mZnNldCArIDFdIDw8IDgpXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZFVJbnQxNkJFID0gZnVuY3Rpb24gKG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja09mZnNldChvZmZzZXQsIDIsIHRoaXMubGVuZ3RoKVxuICByZXR1cm4gKHRoaXNbb2Zmc2V0XSA8PCA4KSB8IHRoaXNbb2Zmc2V0ICsgMV1cbn1cblxuQnVmZmVyLnByb3RvdHlwZS5yZWFkVUludDMyTEUgPSBmdW5jdGlvbiAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrT2Zmc2V0KG9mZnNldCwgNCwgdGhpcy5sZW5ndGgpXG5cbiAgcmV0dXJuICgodGhpc1tvZmZzZXRdKSB8XG4gICAgICAodGhpc1tvZmZzZXQgKyAxXSA8PCA4KSB8XG4gICAgICAodGhpc1tvZmZzZXQgKyAyXSA8PCAxNikpICtcbiAgICAgICh0aGlzW29mZnNldCArIDNdICogMHgxMDAwMDAwKVxufVxuXG5CdWZmZXIucHJvdG90eXBlLnJlYWRVSW50MzJCRSA9IGZ1bmN0aW9uIChvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIGlmICghbm9Bc3NlcnQpXG4gICAgY2hlY2tPZmZzZXQob2Zmc2V0LCA0LCB0aGlzLmxlbmd0aClcblxuICByZXR1cm4gKHRoaXNbb2Zmc2V0XSAqIDB4MTAwMDAwMCkgK1xuICAgICAgKCh0aGlzW29mZnNldCArIDFdIDw8IDE2KSB8XG4gICAgICAodGhpc1tvZmZzZXQgKyAyXSA8PCA4KSB8XG4gICAgICB0aGlzW29mZnNldCArIDNdKVxufVxuXG5CdWZmZXIucHJvdG90eXBlLnJlYWRJbnQ4ID0gZnVuY3Rpb24gKG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja09mZnNldChvZmZzZXQsIDEsIHRoaXMubGVuZ3RoKVxuICBpZiAoISh0aGlzW29mZnNldF0gJiAweDgwKSlcbiAgICByZXR1cm4gKHRoaXNbb2Zmc2V0XSlcbiAgcmV0dXJuICgoMHhmZiAtIHRoaXNbb2Zmc2V0XSArIDEpICogLTEpXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZEludDE2TEUgPSBmdW5jdGlvbiAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrT2Zmc2V0KG9mZnNldCwgMiwgdGhpcy5sZW5ndGgpXG4gIHZhciB2YWwgPSB0aGlzW29mZnNldF0gfCAodGhpc1tvZmZzZXQgKyAxXSA8PCA4KVxuICByZXR1cm4gKHZhbCAmIDB4ODAwMCkgPyB2YWwgfCAweEZGRkYwMDAwIDogdmFsXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZEludDE2QkUgPSBmdW5jdGlvbiAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrT2Zmc2V0KG9mZnNldCwgMiwgdGhpcy5sZW5ndGgpXG4gIHZhciB2YWwgPSB0aGlzW29mZnNldCArIDFdIHwgKHRoaXNbb2Zmc2V0XSA8PCA4KVxuICByZXR1cm4gKHZhbCAmIDB4ODAwMCkgPyB2YWwgfCAweEZGRkYwMDAwIDogdmFsXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZEludDMyTEUgPSBmdW5jdGlvbiAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrT2Zmc2V0KG9mZnNldCwgNCwgdGhpcy5sZW5ndGgpXG5cbiAgcmV0dXJuICh0aGlzW29mZnNldF0pIHxcbiAgICAgICh0aGlzW29mZnNldCArIDFdIDw8IDgpIHxcbiAgICAgICh0aGlzW29mZnNldCArIDJdIDw8IDE2KSB8XG4gICAgICAodGhpc1tvZmZzZXQgKyAzXSA8PCAyNClcbn1cblxuQnVmZmVyLnByb3RvdHlwZS5yZWFkSW50MzJCRSA9IGZ1bmN0aW9uIChvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIGlmICghbm9Bc3NlcnQpXG4gICAgY2hlY2tPZmZzZXQob2Zmc2V0LCA0LCB0aGlzLmxlbmd0aClcblxuICByZXR1cm4gKHRoaXNbb2Zmc2V0XSA8PCAyNCkgfFxuICAgICAgKHRoaXNbb2Zmc2V0ICsgMV0gPDwgMTYpIHxcbiAgICAgICh0aGlzW29mZnNldCArIDJdIDw8IDgpIHxcbiAgICAgICh0aGlzW29mZnNldCArIDNdKVxufVxuXG5CdWZmZXIucHJvdG90eXBlLnJlYWRGbG9hdExFID0gZnVuY3Rpb24gKG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja09mZnNldChvZmZzZXQsIDQsIHRoaXMubGVuZ3RoKVxuICByZXR1cm4gaWVlZTc1NC5yZWFkKHRoaXMsIG9mZnNldCwgdHJ1ZSwgMjMsIDQpXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZEZsb2F0QkUgPSBmdW5jdGlvbiAob2Zmc2V0LCBub0Fzc2VydCkge1xuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrT2Zmc2V0KG9mZnNldCwgNCwgdGhpcy5sZW5ndGgpXG4gIHJldHVybiBpZWVlNzU0LnJlYWQodGhpcywgb2Zmc2V0LCBmYWxzZSwgMjMsIDQpXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZERvdWJsZUxFID0gZnVuY3Rpb24gKG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja09mZnNldChvZmZzZXQsIDgsIHRoaXMubGVuZ3RoKVxuICByZXR1cm4gaWVlZTc1NC5yZWFkKHRoaXMsIG9mZnNldCwgdHJ1ZSwgNTIsIDgpXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUucmVhZERvdWJsZUJFID0gZnVuY3Rpb24gKG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja09mZnNldChvZmZzZXQsIDgsIHRoaXMubGVuZ3RoKVxuICByZXR1cm4gaWVlZTc1NC5yZWFkKHRoaXMsIG9mZnNldCwgZmFsc2UsIDUyLCA4KVxufVxuXG5mdW5jdGlvbiBjaGVja0ludCAoYnVmLCB2YWx1ZSwgb2Zmc2V0LCBleHQsIG1heCwgbWluKSB7XG4gIGlmICghQnVmZmVyLmlzQnVmZmVyKGJ1ZikpIHRocm93IG5ldyBUeXBlRXJyb3IoJ2J1ZmZlciBtdXN0IGJlIGEgQnVmZmVyIGluc3RhbmNlJylcbiAgaWYgKHZhbHVlID4gbWF4IHx8IHZhbHVlIDwgbWluKSB0aHJvdyBuZXcgVHlwZUVycm9yKCd2YWx1ZSBpcyBvdXQgb2YgYm91bmRzJylcbiAgaWYgKG9mZnNldCArIGV4dCA+IGJ1Zi5sZW5ndGgpIHRocm93IG5ldyBUeXBlRXJyb3IoJ2luZGV4IG91dCBvZiByYW5nZScpXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUud3JpdGVVSW50OCA9IGZ1bmN0aW9uICh2YWx1ZSwgb2Zmc2V0LCBub0Fzc2VydCkge1xuICB2YWx1ZSA9ICt2YWx1ZVxuICBvZmZzZXQgPSBvZmZzZXQgPj4+IDBcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja0ludCh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCAxLCAweGZmLCAwKVxuICBpZiAoIUJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUKSB2YWx1ZSA9IE1hdGguZmxvb3IodmFsdWUpXG4gIHRoaXNbb2Zmc2V0XSA9IHZhbHVlXG4gIHJldHVybiBvZmZzZXQgKyAxXG59XG5cbmZ1bmN0aW9uIG9iamVjdFdyaXRlVUludDE2IChidWYsIHZhbHVlLCBvZmZzZXQsIGxpdHRsZUVuZGlhbikge1xuICBpZiAodmFsdWUgPCAwKSB2YWx1ZSA9IDB4ZmZmZiArIHZhbHVlICsgMVxuICBmb3IgKHZhciBpID0gMCwgaiA9IE1hdGgubWluKGJ1Zi5sZW5ndGggLSBvZmZzZXQsIDIpOyBpIDwgajsgaSsrKSB7XG4gICAgYnVmW29mZnNldCArIGldID0gKHZhbHVlICYgKDB4ZmYgPDwgKDggKiAobGl0dGxlRW5kaWFuID8gaSA6IDEgLSBpKSkpKSA+Pj5cbiAgICAgIChsaXR0bGVFbmRpYW4gPyBpIDogMSAtIGkpICogOFxuICB9XG59XG5cbkJ1ZmZlci5wcm90b3R5cGUud3JpdGVVSW50MTZMRSA9IGZ1bmN0aW9uICh2YWx1ZSwgb2Zmc2V0LCBub0Fzc2VydCkge1xuICB2YWx1ZSA9ICt2YWx1ZVxuICBvZmZzZXQgPSBvZmZzZXQgPj4+IDBcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja0ludCh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCAyLCAweGZmZmYsIDApXG4gIGlmIChCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkge1xuICAgIHRoaXNbb2Zmc2V0XSA9IHZhbHVlXG4gICAgdGhpc1tvZmZzZXQgKyAxXSA9ICh2YWx1ZSA+Pj4gOClcbiAgfSBlbHNlIG9iamVjdFdyaXRlVUludDE2KHRoaXMsIHZhbHVlLCBvZmZzZXQsIHRydWUpXG4gIHJldHVybiBvZmZzZXQgKyAyXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUud3JpdGVVSW50MTZCRSA9IGZ1bmN0aW9uICh2YWx1ZSwgb2Zmc2V0LCBub0Fzc2VydCkge1xuICB2YWx1ZSA9ICt2YWx1ZVxuICBvZmZzZXQgPSBvZmZzZXQgPj4+IDBcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja0ludCh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCAyLCAweGZmZmYsIDApXG4gIGlmIChCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkge1xuICAgIHRoaXNbb2Zmc2V0XSA9ICh2YWx1ZSA+Pj4gOClcbiAgICB0aGlzW29mZnNldCArIDFdID0gdmFsdWVcbiAgfSBlbHNlIG9iamVjdFdyaXRlVUludDE2KHRoaXMsIHZhbHVlLCBvZmZzZXQsIGZhbHNlKVxuICByZXR1cm4gb2Zmc2V0ICsgMlxufVxuXG5mdW5jdGlvbiBvYmplY3RXcml0ZVVJbnQzMiAoYnVmLCB2YWx1ZSwgb2Zmc2V0LCBsaXR0bGVFbmRpYW4pIHtcbiAgaWYgKHZhbHVlIDwgMCkgdmFsdWUgPSAweGZmZmZmZmZmICsgdmFsdWUgKyAxXG4gIGZvciAodmFyIGkgPSAwLCBqID0gTWF0aC5taW4oYnVmLmxlbmd0aCAtIG9mZnNldCwgNCk7IGkgPCBqOyBpKyspIHtcbiAgICBidWZbb2Zmc2V0ICsgaV0gPSAodmFsdWUgPj4+IChsaXR0bGVFbmRpYW4gPyBpIDogMyAtIGkpICogOCkgJiAweGZmXG4gIH1cbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZVVJbnQzMkxFID0gZnVuY3Rpb24gKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHZhbHVlID0gK3ZhbHVlXG4gIG9mZnNldCA9IG9mZnNldCA+Pj4gMFxuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrSW50KHRoaXMsIHZhbHVlLCBvZmZzZXQsIDQsIDB4ZmZmZmZmZmYsIDApXG4gIGlmIChCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkge1xuICAgIHRoaXNbb2Zmc2V0ICsgM10gPSAodmFsdWUgPj4+IDI0KVxuICAgIHRoaXNbb2Zmc2V0ICsgMl0gPSAodmFsdWUgPj4+IDE2KVxuICAgIHRoaXNbb2Zmc2V0ICsgMV0gPSAodmFsdWUgPj4+IDgpXG4gICAgdGhpc1tvZmZzZXRdID0gdmFsdWVcbiAgfSBlbHNlIG9iamVjdFdyaXRlVUludDMyKHRoaXMsIHZhbHVlLCBvZmZzZXQsIHRydWUpXG4gIHJldHVybiBvZmZzZXQgKyA0XG59XG5cbkJ1ZmZlci5wcm90b3R5cGUud3JpdGVVSW50MzJCRSA9IGZ1bmN0aW9uICh2YWx1ZSwgb2Zmc2V0LCBub0Fzc2VydCkge1xuICB2YWx1ZSA9ICt2YWx1ZVxuICBvZmZzZXQgPSBvZmZzZXQgPj4+IDBcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja0ludCh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCA0LCAweGZmZmZmZmZmLCAwKVxuICBpZiAoQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHtcbiAgICB0aGlzW29mZnNldF0gPSAodmFsdWUgPj4+IDI0KVxuICAgIHRoaXNbb2Zmc2V0ICsgMV0gPSAodmFsdWUgPj4+IDE2KVxuICAgIHRoaXNbb2Zmc2V0ICsgMl0gPSAodmFsdWUgPj4+IDgpXG4gICAgdGhpc1tvZmZzZXQgKyAzXSA9IHZhbHVlXG4gIH0gZWxzZSBvYmplY3RXcml0ZVVJbnQzMih0aGlzLCB2YWx1ZSwgb2Zmc2V0LCBmYWxzZSlcbiAgcmV0dXJuIG9mZnNldCArIDRcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZUludDggPSBmdW5jdGlvbiAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgdmFsdWUgPSArdmFsdWVcbiAgb2Zmc2V0ID0gb2Zmc2V0ID4+PiAwXG4gIGlmICghbm9Bc3NlcnQpXG4gICAgY2hlY2tJbnQodGhpcywgdmFsdWUsIG9mZnNldCwgMSwgMHg3ZiwgLTB4ODApXG4gIGlmICghQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHZhbHVlID0gTWF0aC5mbG9vcih2YWx1ZSlcbiAgaWYgKHZhbHVlIDwgMCkgdmFsdWUgPSAweGZmICsgdmFsdWUgKyAxXG4gIHRoaXNbb2Zmc2V0XSA9IHZhbHVlXG4gIHJldHVybiBvZmZzZXQgKyAxXG59XG5cbkJ1ZmZlci5wcm90b3R5cGUud3JpdGVJbnQxNkxFID0gZnVuY3Rpb24gKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHZhbHVlID0gK3ZhbHVlXG4gIG9mZnNldCA9IG9mZnNldCA+Pj4gMFxuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrSW50KHRoaXMsIHZhbHVlLCBvZmZzZXQsIDIsIDB4N2ZmZiwgLTB4ODAwMClcbiAgaWYgKEJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUKSB7XG4gICAgdGhpc1tvZmZzZXRdID0gdmFsdWVcbiAgICB0aGlzW29mZnNldCArIDFdID0gKHZhbHVlID4+PiA4KVxuICB9IGVsc2Ugb2JqZWN0V3JpdGVVSW50MTYodGhpcywgdmFsdWUsIG9mZnNldCwgdHJ1ZSlcbiAgcmV0dXJuIG9mZnNldCArIDJcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZUludDE2QkUgPSBmdW5jdGlvbiAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgdmFsdWUgPSArdmFsdWVcbiAgb2Zmc2V0ID0gb2Zmc2V0ID4+PiAwXG4gIGlmICghbm9Bc3NlcnQpXG4gICAgY2hlY2tJbnQodGhpcywgdmFsdWUsIG9mZnNldCwgMiwgMHg3ZmZmLCAtMHg4MDAwKVxuICBpZiAoQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHtcbiAgICB0aGlzW29mZnNldF0gPSAodmFsdWUgPj4+IDgpXG4gICAgdGhpc1tvZmZzZXQgKyAxXSA9IHZhbHVlXG4gIH0gZWxzZSBvYmplY3RXcml0ZVVJbnQxNih0aGlzLCB2YWx1ZSwgb2Zmc2V0LCBmYWxzZSlcbiAgcmV0dXJuIG9mZnNldCArIDJcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZUludDMyTEUgPSBmdW5jdGlvbiAodmFsdWUsIG9mZnNldCwgbm9Bc3NlcnQpIHtcbiAgdmFsdWUgPSArdmFsdWVcbiAgb2Zmc2V0ID0gb2Zmc2V0ID4+PiAwXG4gIGlmICghbm9Bc3NlcnQpXG4gICAgY2hlY2tJbnQodGhpcywgdmFsdWUsIG9mZnNldCwgNCwgMHg3ZmZmZmZmZiwgLTB4ODAwMDAwMDApXG4gIGlmIChCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkge1xuICAgIHRoaXNbb2Zmc2V0XSA9IHZhbHVlXG4gICAgdGhpc1tvZmZzZXQgKyAxXSA9ICh2YWx1ZSA+Pj4gOClcbiAgICB0aGlzW29mZnNldCArIDJdID0gKHZhbHVlID4+PiAxNilcbiAgICB0aGlzW29mZnNldCArIDNdID0gKHZhbHVlID4+PiAyNClcbiAgfSBlbHNlIG9iamVjdFdyaXRlVUludDMyKHRoaXMsIHZhbHVlLCBvZmZzZXQsIHRydWUpXG4gIHJldHVybiBvZmZzZXQgKyA0XG59XG5cbkJ1ZmZlci5wcm90b3R5cGUud3JpdGVJbnQzMkJFID0gZnVuY3Rpb24gKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHZhbHVlID0gK3ZhbHVlXG4gIG9mZnNldCA9IG9mZnNldCA+Pj4gMFxuICBpZiAoIW5vQXNzZXJ0KVxuICAgIGNoZWNrSW50KHRoaXMsIHZhbHVlLCBvZmZzZXQsIDQsIDB4N2ZmZmZmZmYsIC0weDgwMDAwMDAwKVxuICBpZiAodmFsdWUgPCAwKSB2YWx1ZSA9IDB4ZmZmZmZmZmYgKyB2YWx1ZSArIDFcbiAgaWYgKEJ1ZmZlci5UWVBFRF9BUlJBWV9TVVBQT1JUKSB7XG4gICAgdGhpc1tvZmZzZXRdID0gKHZhbHVlID4+PiAyNClcbiAgICB0aGlzW29mZnNldCArIDFdID0gKHZhbHVlID4+PiAxNilcbiAgICB0aGlzW29mZnNldCArIDJdID0gKHZhbHVlID4+PiA4KVxuICAgIHRoaXNbb2Zmc2V0ICsgM10gPSB2YWx1ZVxuICB9IGVsc2Ugb2JqZWN0V3JpdGVVSW50MzIodGhpcywgdmFsdWUsIG9mZnNldCwgZmFsc2UpXG4gIHJldHVybiBvZmZzZXQgKyA0XG59XG5cbmZ1bmN0aW9uIGNoZWNrSUVFRTc1NCAoYnVmLCB2YWx1ZSwgb2Zmc2V0LCBleHQsIG1heCwgbWluKSB7XG4gIGlmICh2YWx1ZSA+IG1heCB8fCB2YWx1ZSA8IG1pbikgdGhyb3cgbmV3IFR5cGVFcnJvcigndmFsdWUgaXMgb3V0IG9mIGJvdW5kcycpXG4gIGlmIChvZmZzZXQgKyBleHQgPiBidWYubGVuZ3RoKSB0aHJvdyBuZXcgVHlwZUVycm9yKCdpbmRleCBvdXQgb2YgcmFuZ2UnKVxufVxuXG5mdW5jdGlvbiB3cml0ZUZsb2F0IChidWYsIHZhbHVlLCBvZmZzZXQsIGxpdHRsZUVuZGlhbiwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja0lFRUU3NTQoYnVmLCB2YWx1ZSwgb2Zmc2V0LCA0LCAzLjQwMjgyMzQ2NjM4NTI4ODZlKzM4LCAtMy40MDI4MjM0NjYzODUyODg2ZSszOClcbiAgaWVlZTc1NC53cml0ZShidWYsIHZhbHVlLCBvZmZzZXQsIGxpdHRsZUVuZGlhbiwgMjMsIDQpXG4gIHJldHVybiBvZmZzZXQgKyA0XG59XG5cbkJ1ZmZlci5wcm90b3R5cGUud3JpdGVGbG9hdExFID0gZnVuY3Rpb24gKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHJldHVybiB3cml0ZUZsb2F0KHRoaXMsIHZhbHVlLCBvZmZzZXQsIHRydWUsIG5vQXNzZXJ0KVxufVxuXG5CdWZmZXIucHJvdG90eXBlLndyaXRlRmxvYXRCRSA9IGZ1bmN0aW9uICh2YWx1ZSwgb2Zmc2V0LCBub0Fzc2VydCkge1xuICByZXR1cm4gd3JpdGVGbG9hdCh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCBmYWxzZSwgbm9Bc3NlcnQpXG59XG5cbmZ1bmN0aW9uIHdyaXRlRG91YmxlIChidWYsIHZhbHVlLCBvZmZzZXQsIGxpdHRsZUVuZGlhbiwgbm9Bc3NlcnQpIHtcbiAgaWYgKCFub0Fzc2VydClcbiAgICBjaGVja0lFRUU3NTQoYnVmLCB2YWx1ZSwgb2Zmc2V0LCA4LCAxLjc5NzY5MzEzNDg2MjMxNTdFKzMwOCwgLTEuNzk3NjkzMTM0ODYyMzE1N0UrMzA4KVxuICBpZWVlNzU0LndyaXRlKGJ1ZiwgdmFsdWUsIG9mZnNldCwgbGl0dGxlRW5kaWFuLCA1MiwgOClcbiAgcmV0dXJuIG9mZnNldCArIDhcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZURvdWJsZUxFID0gZnVuY3Rpb24gKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHJldHVybiB3cml0ZURvdWJsZSh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCB0cnVlLCBub0Fzc2VydClcbn1cblxuQnVmZmVyLnByb3RvdHlwZS53cml0ZURvdWJsZUJFID0gZnVuY3Rpb24gKHZhbHVlLCBvZmZzZXQsIG5vQXNzZXJ0KSB7XG4gIHJldHVybiB3cml0ZURvdWJsZSh0aGlzLCB2YWx1ZSwgb2Zmc2V0LCBmYWxzZSwgbm9Bc3NlcnQpXG59XG5cbi8vIGNvcHkodGFyZ2V0QnVmZmVyLCB0YXJnZXRTdGFydD0wLCBzb3VyY2VTdGFydD0wLCBzb3VyY2VFbmQ9YnVmZmVyLmxlbmd0aClcbkJ1ZmZlci5wcm90b3R5cGUuY29weSA9IGZ1bmN0aW9uICh0YXJnZXQsIHRhcmdldF9zdGFydCwgc3RhcnQsIGVuZCkge1xuICB2YXIgc291cmNlID0gdGhpc1xuXG4gIGlmICghc3RhcnQpIHN0YXJ0ID0gMFxuICBpZiAoIWVuZCAmJiBlbmQgIT09IDApIGVuZCA9IHRoaXMubGVuZ3RoXG4gIGlmICghdGFyZ2V0X3N0YXJ0KSB0YXJnZXRfc3RhcnQgPSAwXG5cbiAgLy8gQ29weSAwIGJ5dGVzOyB3ZSdyZSBkb25lXG4gIGlmIChlbmQgPT09IHN0YXJ0KSByZXR1cm5cbiAgaWYgKHRhcmdldC5sZW5ndGggPT09IDAgfHwgc291cmNlLmxlbmd0aCA9PT0gMCkgcmV0dXJuXG5cbiAgLy8gRmF0YWwgZXJyb3IgY29uZGl0aW9uc1xuICBpZiAoZW5kIDwgc3RhcnQpIHRocm93IG5ldyBUeXBlRXJyb3IoJ3NvdXJjZUVuZCA8IHNvdXJjZVN0YXJ0JylcbiAgaWYgKHRhcmdldF9zdGFydCA8IDAgfHwgdGFyZ2V0X3N0YXJ0ID49IHRhcmdldC5sZW5ndGgpXG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcigndGFyZ2V0U3RhcnQgb3V0IG9mIGJvdW5kcycpXG4gIGlmIChzdGFydCA8IDAgfHwgc3RhcnQgPj0gc291cmNlLmxlbmd0aCkgdGhyb3cgbmV3IFR5cGVFcnJvcignc291cmNlU3RhcnQgb3V0IG9mIGJvdW5kcycpXG4gIGlmIChlbmQgPCAwIHx8IGVuZCA+IHNvdXJjZS5sZW5ndGgpIHRocm93IG5ldyBUeXBlRXJyb3IoJ3NvdXJjZUVuZCBvdXQgb2YgYm91bmRzJylcblxuICAvLyBBcmUgd2Ugb29iP1xuICBpZiAoZW5kID4gdGhpcy5sZW5ndGgpXG4gICAgZW5kID0gdGhpcy5sZW5ndGhcbiAgaWYgKHRhcmdldC5sZW5ndGggLSB0YXJnZXRfc3RhcnQgPCBlbmQgLSBzdGFydClcbiAgICBlbmQgPSB0YXJnZXQubGVuZ3RoIC0gdGFyZ2V0X3N0YXJ0ICsgc3RhcnRcblxuICB2YXIgbGVuID0gZW5kIC0gc3RhcnRcblxuICBpZiAobGVuIDwgMTAwMCB8fCAhQnVmZmVyLlRZUEVEX0FSUkFZX1NVUFBPUlQpIHtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgICB0YXJnZXRbaSArIHRhcmdldF9zdGFydF0gPSB0aGlzW2kgKyBzdGFydF1cbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgdGFyZ2V0Ll9zZXQodGhpcy5zdWJhcnJheShzdGFydCwgc3RhcnQgKyBsZW4pLCB0YXJnZXRfc3RhcnQpXG4gIH1cbn1cblxuLy8gZmlsbCh2YWx1ZSwgc3RhcnQ9MCwgZW5kPWJ1ZmZlci5sZW5ndGgpXG5CdWZmZXIucHJvdG90eXBlLmZpbGwgPSBmdW5jdGlvbiAodmFsdWUsIHN0YXJ0LCBlbmQpIHtcbiAgaWYgKCF2YWx1ZSkgdmFsdWUgPSAwXG4gIGlmICghc3RhcnQpIHN0YXJ0ID0gMFxuICBpZiAoIWVuZCkgZW5kID0gdGhpcy5sZW5ndGhcblxuICBpZiAoZW5kIDwgc3RhcnQpIHRocm93IG5ldyBUeXBlRXJyb3IoJ2VuZCA8IHN0YXJ0JylcblxuICAvLyBGaWxsIDAgYnl0ZXM7IHdlJ3JlIGRvbmVcbiAgaWYgKGVuZCA9PT0gc3RhcnQpIHJldHVyblxuICBpZiAodGhpcy5sZW5ndGggPT09IDApIHJldHVyblxuXG4gIGlmIChzdGFydCA8IDAgfHwgc3RhcnQgPj0gdGhpcy5sZW5ndGgpIHRocm93IG5ldyBUeXBlRXJyb3IoJ3N0YXJ0IG91dCBvZiBib3VuZHMnKVxuICBpZiAoZW5kIDwgMCB8fCBlbmQgPiB0aGlzLmxlbmd0aCkgdGhyb3cgbmV3IFR5cGVFcnJvcignZW5kIG91dCBvZiBib3VuZHMnKVxuXG4gIHZhciBpXG4gIGlmICh0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInKSB7XG4gICAgZm9yIChpID0gc3RhcnQ7IGkgPCBlbmQ7IGkrKykge1xuICAgICAgdGhpc1tpXSA9IHZhbHVlXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHZhciBieXRlcyA9IHV0ZjhUb0J5dGVzKHZhbHVlLnRvU3RyaW5nKCkpXG4gICAgdmFyIGxlbiA9IGJ5dGVzLmxlbmd0aFxuICAgIGZvciAoaSA9IHN0YXJ0OyBpIDwgZW5kOyBpKyspIHtcbiAgICAgIHRoaXNbaV0gPSBieXRlc1tpICUgbGVuXVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB0aGlzXG59XG5cbi8qKlxuICogQ3JlYXRlcyBhIG5ldyBgQXJyYXlCdWZmZXJgIHdpdGggdGhlICpjb3BpZWQqIG1lbW9yeSBvZiB0aGUgYnVmZmVyIGluc3RhbmNlLlxuICogQWRkZWQgaW4gTm9kZSAwLjEyLiBPbmx5IGF2YWlsYWJsZSBpbiBicm93c2VycyB0aGF0IHN1cHBvcnQgQXJyYXlCdWZmZXIuXG4gKi9cbkJ1ZmZlci5wcm90b3R5cGUudG9BcnJheUJ1ZmZlciA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHR5cGVvZiBVaW50OEFycmF5ICE9PSAndW5kZWZpbmVkJykge1xuICAgIGlmIChCdWZmZXIuVFlQRURfQVJSQVlfU1VQUE9SVCkge1xuICAgICAgcmV0dXJuIChuZXcgQnVmZmVyKHRoaXMpKS5idWZmZXJcbiAgICB9IGVsc2Uge1xuICAgICAgdmFyIGJ1ZiA9IG5ldyBVaW50OEFycmF5KHRoaXMubGVuZ3RoKVxuICAgICAgZm9yICh2YXIgaSA9IDAsIGxlbiA9IGJ1Zi5sZW5ndGg7IGkgPCBsZW47IGkgKz0gMSkge1xuICAgICAgICBidWZbaV0gPSB0aGlzW2ldXG4gICAgICB9XG4gICAgICByZXR1cm4gYnVmLmJ1ZmZlclxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdCdWZmZXIudG9BcnJheUJ1ZmZlciBub3Qgc3VwcG9ydGVkIGluIHRoaXMgYnJvd3NlcicpXG4gIH1cbn1cblxuLy8gSEVMUEVSIEZVTkNUSU9OU1xuLy8gPT09PT09PT09PT09PT09PVxuXG52YXIgQlAgPSBCdWZmZXIucHJvdG90eXBlXG5cbi8qKlxuICogQXVnbWVudCBhIFVpbnQ4QXJyYXkgKmluc3RhbmNlKiAobm90IHRoZSBVaW50OEFycmF5IGNsYXNzISkgd2l0aCBCdWZmZXIgbWV0aG9kc1xuICovXG5CdWZmZXIuX2F1Z21lbnQgPSBmdW5jdGlvbiAoYXJyKSB7XG4gIGFyci5jb25zdHJ1Y3RvciA9IEJ1ZmZlclxuICBhcnIuX2lzQnVmZmVyID0gdHJ1ZVxuXG4gIC8vIHNhdmUgcmVmZXJlbmNlIHRvIG9yaWdpbmFsIFVpbnQ4QXJyYXkgZ2V0L3NldCBtZXRob2RzIGJlZm9yZSBvdmVyd3JpdGluZ1xuICBhcnIuX2dldCA9IGFyci5nZXRcbiAgYXJyLl9zZXQgPSBhcnIuc2V0XG5cbiAgLy8gZGVwcmVjYXRlZCwgd2lsbCBiZSByZW1vdmVkIGluIG5vZGUgMC4xMytcbiAgYXJyLmdldCA9IEJQLmdldFxuICBhcnIuc2V0ID0gQlAuc2V0XG5cbiAgYXJyLndyaXRlID0gQlAud3JpdGVcbiAgYXJyLnRvU3RyaW5nID0gQlAudG9TdHJpbmdcbiAgYXJyLnRvTG9jYWxlU3RyaW5nID0gQlAudG9TdHJpbmdcbiAgYXJyLnRvSlNPTiA9IEJQLnRvSlNPTlxuICBhcnIuZXF1YWxzID0gQlAuZXF1YWxzXG4gIGFyci5jb21wYXJlID0gQlAuY29tcGFyZVxuICBhcnIuY29weSA9IEJQLmNvcHlcbiAgYXJyLnNsaWNlID0gQlAuc2xpY2VcbiAgYXJyLnJlYWRVSW50OCA9IEJQLnJlYWRVSW50OFxuICBhcnIucmVhZFVJbnQxNkxFID0gQlAucmVhZFVJbnQxNkxFXG4gIGFyci5yZWFkVUludDE2QkUgPSBCUC5yZWFkVUludDE2QkVcbiAgYXJyLnJlYWRVSW50MzJMRSA9IEJQLnJlYWRVSW50MzJMRVxuICBhcnIucmVhZFVJbnQzMkJFID0gQlAucmVhZFVJbnQzMkJFXG4gIGFyci5yZWFkSW50OCA9IEJQLnJlYWRJbnQ4XG4gIGFyci5yZWFkSW50MTZMRSA9IEJQLnJlYWRJbnQxNkxFXG4gIGFyci5yZWFkSW50MTZCRSA9IEJQLnJlYWRJbnQxNkJFXG4gIGFyci5yZWFkSW50MzJMRSA9IEJQLnJlYWRJbnQzMkxFXG4gIGFyci5yZWFkSW50MzJCRSA9IEJQLnJlYWRJbnQzMkJFXG4gIGFyci5yZWFkRmxvYXRMRSA9IEJQLnJlYWRGbG9hdExFXG4gIGFyci5yZWFkRmxvYXRCRSA9IEJQLnJlYWRGbG9hdEJFXG4gIGFyci5yZWFkRG91YmxlTEUgPSBCUC5yZWFkRG91YmxlTEVcbiAgYXJyLnJlYWREb3VibGVCRSA9IEJQLnJlYWREb3VibGVCRVxuICBhcnIud3JpdGVVSW50OCA9IEJQLndyaXRlVUludDhcbiAgYXJyLndyaXRlVUludDE2TEUgPSBCUC53cml0ZVVJbnQxNkxFXG4gIGFyci53cml0ZVVJbnQxNkJFID0gQlAud3JpdGVVSW50MTZCRVxuICBhcnIud3JpdGVVSW50MzJMRSA9IEJQLndyaXRlVUludDMyTEVcbiAgYXJyLndyaXRlVUludDMyQkUgPSBCUC53cml0ZVVJbnQzMkJFXG4gIGFyci53cml0ZUludDggPSBCUC53cml0ZUludDhcbiAgYXJyLndyaXRlSW50MTZMRSA9IEJQLndyaXRlSW50MTZMRVxuICBhcnIud3JpdGVJbnQxNkJFID0gQlAud3JpdGVJbnQxNkJFXG4gIGFyci53cml0ZUludDMyTEUgPSBCUC53cml0ZUludDMyTEVcbiAgYXJyLndyaXRlSW50MzJCRSA9IEJQLndyaXRlSW50MzJCRVxuICBhcnIud3JpdGVGbG9hdExFID0gQlAud3JpdGVGbG9hdExFXG4gIGFyci53cml0ZUZsb2F0QkUgPSBCUC53cml0ZUZsb2F0QkVcbiAgYXJyLndyaXRlRG91YmxlTEUgPSBCUC53cml0ZURvdWJsZUxFXG4gIGFyci53cml0ZURvdWJsZUJFID0gQlAud3JpdGVEb3VibGVCRVxuICBhcnIuZmlsbCA9IEJQLmZpbGxcbiAgYXJyLmluc3BlY3QgPSBCUC5pbnNwZWN0XG4gIGFyci50b0FycmF5QnVmZmVyID0gQlAudG9BcnJheUJ1ZmZlclxuXG4gIHJldHVybiBhcnJcbn1cblxudmFyIElOVkFMSURfQkFTRTY0X1JFID0gL1teK1xcLzAtOUEtel0vZ1xuXG5mdW5jdGlvbiBiYXNlNjRjbGVhbiAoc3RyKSB7XG4gIC8vIE5vZGUgc3RyaXBzIG91dCBpbnZhbGlkIGNoYXJhY3RlcnMgbGlrZSBcXG4gYW5kIFxcdCBmcm9tIHRoZSBzdHJpbmcsIGJhc2U2NC1qcyBkb2VzIG5vdFxuICBzdHIgPSBzdHJpbmd0cmltKHN0cikucmVwbGFjZShJTlZBTElEX0JBU0U2NF9SRSwgJycpXG4gIC8vIE5vZGUgYWxsb3dzIGZvciBub24tcGFkZGVkIGJhc2U2NCBzdHJpbmdzIChtaXNzaW5nIHRyYWlsaW5nID09PSksIGJhc2U2NC1qcyBkb2VzIG5vdFxuICB3aGlsZSAoc3RyLmxlbmd0aCAlIDQgIT09IDApIHtcbiAgICBzdHIgPSBzdHIgKyAnPSdcbiAgfVxuICByZXR1cm4gc3RyXG59XG5cbmZ1bmN0aW9uIHN0cmluZ3RyaW0gKHN0cikge1xuICBpZiAoc3RyLnRyaW0pIHJldHVybiBzdHIudHJpbSgpXG4gIHJldHVybiBzdHIucmVwbGFjZSgvXlxccyt8XFxzKyQvZywgJycpXG59XG5cbmZ1bmN0aW9uIGlzQXJyYXlpc2ggKHN1YmplY3QpIHtcbiAgcmV0dXJuIGlzQXJyYXkoc3ViamVjdCkgfHwgQnVmZmVyLmlzQnVmZmVyKHN1YmplY3QpIHx8XG4gICAgICBzdWJqZWN0ICYmIHR5cGVvZiBzdWJqZWN0ID09PSAnb2JqZWN0JyAmJlxuICAgICAgdHlwZW9mIHN1YmplY3QubGVuZ3RoID09PSAnbnVtYmVyJ1xufVxuXG5mdW5jdGlvbiB0b0hleCAobikge1xuICBpZiAobiA8IDE2KSByZXR1cm4gJzAnICsgbi50b1N0cmluZygxNilcbiAgcmV0dXJuIG4udG9TdHJpbmcoMTYpXG59XG5cbmZ1bmN0aW9uIHV0ZjhUb0J5dGVzIChzdHIpIHtcbiAgdmFyIGJ5dGVBcnJheSA9IFtdXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgc3RyLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIGIgPSBzdHIuY2hhckNvZGVBdChpKVxuICAgIGlmIChiIDw9IDB4N0YpIHtcbiAgICAgIGJ5dGVBcnJheS5wdXNoKGIpXG4gICAgfSBlbHNlIHtcbiAgICAgIHZhciBzdGFydCA9IGlcbiAgICAgIGlmIChiID49IDB4RDgwMCAmJiBiIDw9IDB4REZGRikgaSsrXG4gICAgICB2YXIgaCA9IGVuY29kZVVSSUNvbXBvbmVudChzdHIuc2xpY2Uoc3RhcnQsIGkrMSkpLnN1YnN0cigxKS5zcGxpdCgnJScpXG4gICAgICBmb3IgKHZhciBqID0gMDsgaiA8IGgubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgYnl0ZUFycmF5LnB1c2gocGFyc2VJbnQoaFtqXSwgMTYpKVxuICAgICAgfVxuICAgIH1cbiAgfVxuICByZXR1cm4gYnl0ZUFycmF5XG59XG5cbmZ1bmN0aW9uIGFzY2lpVG9CeXRlcyAoc3RyKSB7XG4gIHZhciBieXRlQXJyYXkgPSBbXVxuICBmb3IgKHZhciBpID0gMDsgaSA8IHN0ci5sZW5ndGg7IGkrKykge1xuICAgIC8vIE5vZGUncyBjb2RlIHNlZW1zIHRvIGJlIGRvaW5nIHRoaXMgYW5kIG5vdCAmIDB4N0YuLlxuICAgIGJ5dGVBcnJheS5wdXNoKHN0ci5jaGFyQ29kZUF0KGkpICYgMHhGRilcbiAgfVxuICByZXR1cm4gYnl0ZUFycmF5XG59XG5cbmZ1bmN0aW9uIHV0ZjE2bGVUb0J5dGVzIChzdHIpIHtcbiAgdmFyIGMsIGhpLCBsb1xuICB2YXIgYnl0ZUFycmF5ID0gW11cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBzdHIubGVuZ3RoOyBpKyspIHtcbiAgICBjID0gc3RyLmNoYXJDb2RlQXQoaSlcbiAgICBoaSA9IGMgPj4gOFxuICAgIGxvID0gYyAlIDI1NlxuICAgIGJ5dGVBcnJheS5wdXNoKGxvKVxuICAgIGJ5dGVBcnJheS5wdXNoKGhpKVxuICB9XG5cbiAgcmV0dXJuIGJ5dGVBcnJheVxufVxuXG5mdW5jdGlvbiBiYXNlNjRUb0J5dGVzIChzdHIpIHtcbiAgcmV0dXJuIGJhc2U2NC50b0J5dGVBcnJheShzdHIpXG59XG5cbmZ1bmN0aW9uIGJsaXRCdWZmZXIgKHNyYywgZHN0LCBvZmZzZXQsIGxlbmd0aCkge1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKChpICsgb2Zmc2V0ID49IGRzdC5sZW5ndGgpIHx8IChpID49IHNyYy5sZW5ndGgpKVxuICAgICAgYnJlYWtcbiAgICBkc3RbaSArIG9mZnNldF0gPSBzcmNbaV1cbiAgfVxuICByZXR1cm4gaVxufVxuXG5mdW5jdGlvbiBkZWNvZGVVdGY4Q2hhciAoc3RyKSB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGRlY29kZVVSSUNvbXBvbmVudChzdHIpXG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiBTdHJpbmcuZnJvbUNoYXJDb2RlKDB4RkZGRCkgLy8gVVRGIDggaW52YWxpZCBjaGFyXG4gIH1cbn1cbiIsInZhciBsb29rdXAgPSAnQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkrLyc7XG5cbjsoZnVuY3Rpb24gKGV4cG9ydHMpIHtcblx0J3VzZSBzdHJpY3QnO1xuXG4gIHZhciBBcnIgPSAodHlwZW9mIFVpbnQ4QXJyYXkgIT09ICd1bmRlZmluZWQnKVxuICAgID8gVWludDhBcnJheVxuICAgIDogQXJyYXlcblxuXHR2YXIgUExVUyAgID0gJysnLmNoYXJDb2RlQXQoMClcblx0dmFyIFNMQVNIICA9ICcvJy5jaGFyQ29kZUF0KDApXG5cdHZhciBOVU1CRVIgPSAnMCcuY2hhckNvZGVBdCgwKVxuXHR2YXIgTE9XRVIgID0gJ2EnLmNoYXJDb2RlQXQoMClcblx0dmFyIFVQUEVSICA9ICdBJy5jaGFyQ29kZUF0KDApXG5cblx0ZnVuY3Rpb24gZGVjb2RlIChlbHQpIHtcblx0XHR2YXIgY29kZSA9IGVsdC5jaGFyQ29kZUF0KDApXG5cdFx0aWYgKGNvZGUgPT09IFBMVVMpXG5cdFx0XHRyZXR1cm4gNjIgLy8gJysnXG5cdFx0aWYgKGNvZGUgPT09IFNMQVNIKVxuXHRcdFx0cmV0dXJuIDYzIC8vICcvJ1xuXHRcdGlmIChjb2RlIDwgTlVNQkVSKVxuXHRcdFx0cmV0dXJuIC0xIC8vbm8gbWF0Y2hcblx0XHRpZiAoY29kZSA8IE5VTUJFUiArIDEwKVxuXHRcdFx0cmV0dXJuIGNvZGUgLSBOVU1CRVIgKyAyNiArIDI2XG5cdFx0aWYgKGNvZGUgPCBVUFBFUiArIDI2KVxuXHRcdFx0cmV0dXJuIGNvZGUgLSBVUFBFUlxuXHRcdGlmIChjb2RlIDwgTE9XRVIgKyAyNilcblx0XHRcdHJldHVybiBjb2RlIC0gTE9XRVIgKyAyNlxuXHR9XG5cblx0ZnVuY3Rpb24gYjY0VG9CeXRlQXJyYXkgKGI2NCkge1xuXHRcdHZhciBpLCBqLCBsLCB0bXAsIHBsYWNlSG9sZGVycywgYXJyXG5cblx0XHRpZiAoYjY0Lmxlbmd0aCAlIDQgPiAwKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgc3RyaW5nLiBMZW5ndGggbXVzdCBiZSBhIG11bHRpcGxlIG9mIDQnKVxuXHRcdH1cblxuXHRcdC8vIHRoZSBudW1iZXIgb2YgZXF1YWwgc2lnbnMgKHBsYWNlIGhvbGRlcnMpXG5cdFx0Ly8gaWYgdGhlcmUgYXJlIHR3byBwbGFjZWhvbGRlcnMsIHRoYW4gdGhlIHR3byBjaGFyYWN0ZXJzIGJlZm9yZSBpdFxuXHRcdC8vIHJlcHJlc2VudCBvbmUgYnl0ZVxuXHRcdC8vIGlmIHRoZXJlIGlzIG9ubHkgb25lLCB0aGVuIHRoZSB0aHJlZSBjaGFyYWN0ZXJzIGJlZm9yZSBpdCByZXByZXNlbnQgMiBieXRlc1xuXHRcdC8vIHRoaXMgaXMganVzdCBhIGNoZWFwIGhhY2sgdG8gbm90IGRvIGluZGV4T2YgdHdpY2Vcblx0XHR2YXIgbGVuID0gYjY0Lmxlbmd0aFxuXHRcdHBsYWNlSG9sZGVycyA9ICc9JyA9PT0gYjY0LmNoYXJBdChsZW4gLSAyKSA/IDIgOiAnPScgPT09IGI2NC5jaGFyQXQobGVuIC0gMSkgPyAxIDogMFxuXG5cdFx0Ly8gYmFzZTY0IGlzIDQvMyArIHVwIHRvIHR3byBjaGFyYWN0ZXJzIG9mIHRoZSBvcmlnaW5hbCBkYXRhXG5cdFx0YXJyID0gbmV3IEFycihiNjQubGVuZ3RoICogMyAvIDQgLSBwbGFjZUhvbGRlcnMpXG5cblx0XHQvLyBpZiB0aGVyZSBhcmUgcGxhY2Vob2xkZXJzLCBvbmx5IGdldCB1cCB0byB0aGUgbGFzdCBjb21wbGV0ZSA0IGNoYXJzXG5cdFx0bCA9IHBsYWNlSG9sZGVycyA+IDAgPyBiNjQubGVuZ3RoIC0gNCA6IGI2NC5sZW5ndGhcblxuXHRcdHZhciBMID0gMFxuXG5cdFx0ZnVuY3Rpb24gcHVzaCAodikge1xuXHRcdFx0YXJyW0wrK10gPSB2XG5cdFx0fVxuXG5cdFx0Zm9yIChpID0gMCwgaiA9IDA7IGkgPCBsOyBpICs9IDQsIGogKz0gMykge1xuXHRcdFx0dG1wID0gKGRlY29kZShiNjQuY2hhckF0KGkpKSA8PCAxOCkgfCAoZGVjb2RlKGI2NC5jaGFyQXQoaSArIDEpKSA8PCAxMikgfCAoZGVjb2RlKGI2NC5jaGFyQXQoaSArIDIpKSA8PCA2KSB8IGRlY29kZShiNjQuY2hhckF0KGkgKyAzKSlcblx0XHRcdHB1c2goKHRtcCAmIDB4RkYwMDAwKSA+PiAxNilcblx0XHRcdHB1c2goKHRtcCAmIDB4RkYwMCkgPj4gOClcblx0XHRcdHB1c2godG1wICYgMHhGRilcblx0XHR9XG5cblx0XHRpZiAocGxhY2VIb2xkZXJzID09PSAyKSB7XG5cdFx0XHR0bXAgPSAoZGVjb2RlKGI2NC5jaGFyQXQoaSkpIDw8IDIpIHwgKGRlY29kZShiNjQuY2hhckF0KGkgKyAxKSkgPj4gNClcblx0XHRcdHB1c2godG1wICYgMHhGRilcblx0XHR9IGVsc2UgaWYgKHBsYWNlSG9sZGVycyA9PT0gMSkge1xuXHRcdFx0dG1wID0gKGRlY29kZShiNjQuY2hhckF0KGkpKSA8PCAxMCkgfCAoZGVjb2RlKGI2NC5jaGFyQXQoaSArIDEpKSA8PCA0KSB8IChkZWNvZGUoYjY0LmNoYXJBdChpICsgMikpID4+IDIpXG5cdFx0XHRwdXNoKCh0bXAgPj4gOCkgJiAweEZGKVxuXHRcdFx0cHVzaCh0bXAgJiAweEZGKVxuXHRcdH1cblxuXHRcdHJldHVybiBhcnJcblx0fVxuXG5cdGZ1bmN0aW9uIHVpbnQ4VG9CYXNlNjQgKHVpbnQ4KSB7XG5cdFx0dmFyIGksXG5cdFx0XHRleHRyYUJ5dGVzID0gdWludDgubGVuZ3RoICUgMywgLy8gaWYgd2UgaGF2ZSAxIGJ5dGUgbGVmdCwgcGFkIDIgYnl0ZXNcblx0XHRcdG91dHB1dCA9IFwiXCIsXG5cdFx0XHR0ZW1wLCBsZW5ndGhcblxuXHRcdGZ1bmN0aW9uIGVuY29kZSAobnVtKSB7XG5cdFx0XHRyZXR1cm4gbG9va3VwLmNoYXJBdChudW0pXG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gdHJpcGxldFRvQmFzZTY0IChudW0pIHtcblx0XHRcdHJldHVybiBlbmNvZGUobnVtID4+IDE4ICYgMHgzRikgKyBlbmNvZGUobnVtID4+IDEyICYgMHgzRikgKyBlbmNvZGUobnVtID4+IDYgJiAweDNGKSArIGVuY29kZShudW0gJiAweDNGKVxuXHRcdH1cblxuXHRcdC8vIGdvIHRocm91Z2ggdGhlIGFycmF5IGV2ZXJ5IHRocmVlIGJ5dGVzLCB3ZSdsbCBkZWFsIHdpdGggdHJhaWxpbmcgc3R1ZmYgbGF0ZXJcblx0XHRmb3IgKGkgPSAwLCBsZW5ndGggPSB1aW50OC5sZW5ndGggLSBleHRyYUJ5dGVzOyBpIDwgbGVuZ3RoOyBpICs9IDMpIHtcblx0XHRcdHRlbXAgPSAodWludDhbaV0gPDwgMTYpICsgKHVpbnQ4W2kgKyAxXSA8PCA4KSArICh1aW50OFtpICsgMl0pXG5cdFx0XHRvdXRwdXQgKz0gdHJpcGxldFRvQmFzZTY0KHRlbXApXG5cdFx0fVxuXG5cdFx0Ly8gcGFkIHRoZSBlbmQgd2l0aCB6ZXJvcywgYnV0IG1ha2Ugc3VyZSB0byBub3QgZm9yZ2V0IHRoZSBleHRyYSBieXRlc1xuXHRcdHN3aXRjaCAoZXh0cmFCeXRlcykge1xuXHRcdFx0Y2FzZSAxOlxuXHRcdFx0XHR0ZW1wID0gdWludDhbdWludDgubGVuZ3RoIC0gMV1cblx0XHRcdFx0b3V0cHV0ICs9IGVuY29kZSh0ZW1wID4+IDIpXG5cdFx0XHRcdG91dHB1dCArPSBlbmNvZGUoKHRlbXAgPDwgNCkgJiAweDNGKVxuXHRcdFx0XHRvdXRwdXQgKz0gJz09J1xuXHRcdFx0XHRicmVha1xuXHRcdFx0Y2FzZSAyOlxuXHRcdFx0XHR0ZW1wID0gKHVpbnQ4W3VpbnQ4Lmxlbmd0aCAtIDJdIDw8IDgpICsgKHVpbnQ4W3VpbnQ4Lmxlbmd0aCAtIDFdKVxuXHRcdFx0XHRvdXRwdXQgKz0gZW5jb2RlKHRlbXAgPj4gMTApXG5cdFx0XHRcdG91dHB1dCArPSBlbmNvZGUoKHRlbXAgPj4gNCkgJiAweDNGKVxuXHRcdFx0XHRvdXRwdXQgKz0gZW5jb2RlKCh0ZW1wIDw8IDIpICYgMHgzRilcblx0XHRcdFx0b3V0cHV0ICs9ICc9J1xuXHRcdFx0XHRicmVha1xuXHRcdH1cblxuXHRcdHJldHVybiBvdXRwdXRcblx0fVxuXG5cdGV4cG9ydHMudG9CeXRlQXJyYXkgPSBiNjRUb0J5dGVBcnJheVxuXHRleHBvcnRzLmZyb21CeXRlQXJyYXkgPSB1aW50OFRvQmFzZTY0XG59KHR5cGVvZiBleHBvcnRzID09PSAndW5kZWZpbmVkJyA/ICh0aGlzLmJhc2U2NGpzID0ge30pIDogZXhwb3J0cykpXG4iLCJleHBvcnRzLnJlYWQgPSBmdW5jdGlvbihidWZmZXIsIG9mZnNldCwgaXNMRSwgbUxlbiwgbkJ5dGVzKSB7XG4gIHZhciBlLCBtLFxuICAgICAgZUxlbiA9IG5CeXRlcyAqIDggLSBtTGVuIC0gMSxcbiAgICAgIGVNYXggPSAoMSA8PCBlTGVuKSAtIDEsXG4gICAgICBlQmlhcyA9IGVNYXggPj4gMSxcbiAgICAgIG5CaXRzID0gLTcsXG4gICAgICBpID0gaXNMRSA/IChuQnl0ZXMgLSAxKSA6IDAsXG4gICAgICBkID0gaXNMRSA/IC0xIDogMSxcbiAgICAgIHMgPSBidWZmZXJbb2Zmc2V0ICsgaV07XG5cbiAgaSArPSBkO1xuXG4gIGUgPSBzICYgKCgxIDw8ICgtbkJpdHMpKSAtIDEpO1xuICBzID4+PSAoLW5CaXRzKTtcbiAgbkJpdHMgKz0gZUxlbjtcbiAgZm9yICg7IG5CaXRzID4gMDsgZSA9IGUgKiAyNTYgKyBidWZmZXJbb2Zmc2V0ICsgaV0sIGkgKz0gZCwgbkJpdHMgLT0gOCk7XG5cbiAgbSA9IGUgJiAoKDEgPDwgKC1uQml0cykpIC0gMSk7XG4gIGUgPj49ICgtbkJpdHMpO1xuICBuQml0cyArPSBtTGVuO1xuICBmb3IgKDsgbkJpdHMgPiAwOyBtID0gbSAqIDI1NiArIGJ1ZmZlcltvZmZzZXQgKyBpXSwgaSArPSBkLCBuQml0cyAtPSA4KTtcblxuICBpZiAoZSA9PT0gMCkge1xuICAgIGUgPSAxIC0gZUJpYXM7XG4gIH0gZWxzZSBpZiAoZSA9PT0gZU1heCkge1xuICAgIHJldHVybiBtID8gTmFOIDogKChzID8gLTEgOiAxKSAqIEluZmluaXR5KTtcbiAgfSBlbHNlIHtcbiAgICBtID0gbSArIE1hdGgucG93KDIsIG1MZW4pO1xuICAgIGUgPSBlIC0gZUJpYXM7XG4gIH1cbiAgcmV0dXJuIChzID8gLTEgOiAxKSAqIG0gKiBNYXRoLnBvdygyLCBlIC0gbUxlbik7XG59O1xuXG5leHBvcnRzLndyaXRlID0gZnVuY3Rpb24oYnVmZmVyLCB2YWx1ZSwgb2Zmc2V0LCBpc0xFLCBtTGVuLCBuQnl0ZXMpIHtcbiAgdmFyIGUsIG0sIGMsXG4gICAgICBlTGVuID0gbkJ5dGVzICogOCAtIG1MZW4gLSAxLFxuICAgICAgZU1heCA9ICgxIDw8IGVMZW4pIC0gMSxcbiAgICAgIGVCaWFzID0gZU1heCA+PiAxLFxuICAgICAgcnQgPSAobUxlbiA9PT0gMjMgPyBNYXRoLnBvdygyLCAtMjQpIC0gTWF0aC5wb3coMiwgLTc3KSA6IDApLFxuICAgICAgaSA9IGlzTEUgPyAwIDogKG5CeXRlcyAtIDEpLFxuICAgICAgZCA9IGlzTEUgPyAxIDogLTEsXG4gICAgICBzID0gdmFsdWUgPCAwIHx8ICh2YWx1ZSA9PT0gMCAmJiAxIC8gdmFsdWUgPCAwKSA/IDEgOiAwO1xuXG4gIHZhbHVlID0gTWF0aC5hYnModmFsdWUpO1xuXG4gIGlmIChpc05hTih2YWx1ZSkgfHwgdmFsdWUgPT09IEluZmluaXR5KSB7XG4gICAgbSA9IGlzTmFOKHZhbHVlKSA/IDEgOiAwO1xuICAgIGUgPSBlTWF4O1xuICB9IGVsc2Uge1xuICAgIGUgPSBNYXRoLmZsb29yKE1hdGgubG9nKHZhbHVlKSAvIE1hdGguTE4yKTtcbiAgICBpZiAodmFsdWUgKiAoYyA9IE1hdGgucG93KDIsIC1lKSkgPCAxKSB7XG4gICAgICBlLS07XG4gICAgICBjICo9IDI7XG4gICAgfVxuICAgIGlmIChlICsgZUJpYXMgPj0gMSkge1xuICAgICAgdmFsdWUgKz0gcnQgLyBjO1xuICAgIH0gZWxzZSB7XG4gICAgICB2YWx1ZSArPSBydCAqIE1hdGgucG93KDIsIDEgLSBlQmlhcyk7XG4gICAgfVxuICAgIGlmICh2YWx1ZSAqIGMgPj0gMikge1xuICAgICAgZSsrO1xuICAgICAgYyAvPSAyO1xuICAgIH1cblxuICAgIGlmIChlICsgZUJpYXMgPj0gZU1heCkge1xuICAgICAgbSA9IDA7XG4gICAgICBlID0gZU1heDtcbiAgICB9IGVsc2UgaWYgKGUgKyBlQmlhcyA+PSAxKSB7XG4gICAgICBtID0gKHZhbHVlICogYyAtIDEpICogTWF0aC5wb3coMiwgbUxlbik7XG4gICAgICBlID0gZSArIGVCaWFzO1xuICAgIH0gZWxzZSB7XG4gICAgICBtID0gdmFsdWUgKiBNYXRoLnBvdygyLCBlQmlhcyAtIDEpICogTWF0aC5wb3coMiwgbUxlbik7XG4gICAgICBlID0gMDtcbiAgICB9XG4gIH1cblxuICBmb3IgKDsgbUxlbiA+PSA4OyBidWZmZXJbb2Zmc2V0ICsgaV0gPSBtICYgMHhmZiwgaSArPSBkLCBtIC89IDI1NiwgbUxlbiAtPSA4KTtcblxuICBlID0gKGUgPDwgbUxlbikgfCBtO1xuICBlTGVuICs9IG1MZW47XG4gIGZvciAoOyBlTGVuID4gMDsgYnVmZmVyW29mZnNldCArIGldID0gZSAmIDB4ZmYsIGkgKz0gZCwgZSAvPSAyNTYsIGVMZW4gLT0gOCk7XG5cbiAgYnVmZmVyW29mZnNldCArIGkgLSBkXSB8PSBzICogMTI4O1xufTtcbiIsIlxuLyoqXG4gKiBpc0FycmF5XG4gKi9cblxudmFyIGlzQXJyYXkgPSBBcnJheS5pc0FycmF5O1xuXG4vKipcbiAqIHRvU3RyaW5nXG4gKi9cblxudmFyIHN0ciA9IE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmc7XG5cbi8qKlxuICogV2hldGhlciBvciBub3QgdGhlIGdpdmVuIGB2YWxgXG4gKiBpcyBhbiBhcnJheS5cbiAqXG4gKiBleGFtcGxlOlxuICpcbiAqICAgICAgICBpc0FycmF5KFtdKTtcbiAqICAgICAgICAvLyA+IHRydWVcbiAqICAgICAgICBpc0FycmF5KGFyZ3VtZW50cyk7XG4gKiAgICAgICAgLy8gPiBmYWxzZVxuICogICAgICAgIGlzQXJyYXkoJycpO1xuICogICAgICAgIC8vID4gZmFsc2VcbiAqXG4gKiBAcGFyYW0ge21peGVkfSB2YWxcbiAqIEByZXR1cm4ge2Jvb2x9XG4gKi9cblxubW9kdWxlLmV4cG9ydHMgPSBpc0FycmF5IHx8IGZ1bmN0aW9uICh2YWwpIHtcbiAgcmV0dXJuICEhIHZhbCAmJiAnW29iamVjdCBBcnJheV0nID09IHN0ci5jYWxsKHZhbCk7XG59O1xuIiwiLy8gQ29weXJpZ2h0IEpveWVudCwgSW5jLiBhbmQgb3RoZXIgTm9kZSBjb250cmlidXRvcnMuXG4vL1xuLy8gUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGFcbi8vIGNvcHkgb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGVcbi8vIFwiU29mdHdhcmVcIiksIHRvIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZ1xuLy8gd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLFxuLy8gZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdFxuLy8gcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlXG4vLyBmb2xsb3dpbmcgY29uZGl0aW9uczpcbi8vXG4vLyBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZFxuLy8gaW4gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4vL1xuLy8gVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTU1xuLy8gT1IgSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRlxuLy8gTUVSQ0hBTlRBQklMSVRZLCBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTlxuLy8gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sXG4vLyBEQU1BR0VTIE9SIE9USEVSIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1Jcbi8vIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLCBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEVcbi8vIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuXG5cbmZ1bmN0aW9uIEV2ZW50RW1pdHRlcigpIHtcbiAgdGhpcy5fZXZlbnRzID0gdGhpcy5fZXZlbnRzIHx8IHt9O1xuICB0aGlzLl9tYXhMaXN0ZW5lcnMgPSB0aGlzLl9tYXhMaXN0ZW5lcnMgfHwgdW5kZWZpbmVkO1xufVxubW9kdWxlLmV4cG9ydHMgPSBFdmVudEVtaXR0ZXI7XG5cbi8vIEJhY2t3YXJkcy1jb21wYXQgd2l0aCBub2RlIDAuMTAueFxuRXZlbnRFbWl0dGVyLkV2ZW50RW1pdHRlciA9IEV2ZW50RW1pdHRlcjtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5fZXZlbnRzID0gdW5kZWZpbmVkO1xuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5fbWF4TGlzdGVuZXJzID0gdW5kZWZpbmVkO1xuXG4vLyBCeSBkZWZhdWx0IEV2ZW50RW1pdHRlcnMgd2lsbCBwcmludCBhIHdhcm5pbmcgaWYgbW9yZSB0aGFuIDEwIGxpc3RlbmVycyBhcmVcbi8vIGFkZGVkIHRvIGl0LiBUaGlzIGlzIGEgdXNlZnVsIGRlZmF1bHQgd2hpY2ggaGVscHMgZmluZGluZyBtZW1vcnkgbGVha3MuXG5FdmVudEVtaXR0ZXIuZGVmYXVsdE1heExpc3RlbmVycyA9IDEwO1xuXG4vLyBPYnZpb3VzbHkgbm90IGFsbCBFbWl0dGVycyBzaG91bGQgYmUgbGltaXRlZCB0byAxMC4gVGhpcyBmdW5jdGlvbiBhbGxvd3Ncbi8vIHRoYXQgdG8gYmUgaW5jcmVhc2VkLiBTZXQgdG8gemVybyBmb3IgdW5saW1pdGVkLlxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5zZXRNYXhMaXN0ZW5lcnMgPSBmdW5jdGlvbihuKSB7XG4gIGlmICghaXNOdW1iZXIobikgfHwgbiA8IDAgfHwgaXNOYU4obikpXG4gICAgdGhyb3cgVHlwZUVycm9yKCduIG11c3QgYmUgYSBwb3NpdGl2ZSBudW1iZXInKTtcbiAgdGhpcy5fbWF4TGlzdGVuZXJzID0gbjtcbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLmVtaXQgPSBmdW5jdGlvbih0eXBlKSB7XG4gIHZhciBlciwgaGFuZGxlciwgbGVuLCBhcmdzLCBpLCBsaXN0ZW5lcnM7XG5cbiAgaWYgKCF0aGlzLl9ldmVudHMpXG4gICAgdGhpcy5fZXZlbnRzID0ge307XG5cbiAgLy8gSWYgdGhlcmUgaXMgbm8gJ2Vycm9yJyBldmVudCBsaXN0ZW5lciB0aGVuIHRocm93LlxuICBpZiAodHlwZSA9PT0gJ2Vycm9yJykge1xuICAgIGlmICghdGhpcy5fZXZlbnRzLmVycm9yIHx8XG4gICAgICAgIChpc09iamVjdCh0aGlzLl9ldmVudHMuZXJyb3IpICYmICF0aGlzLl9ldmVudHMuZXJyb3IubGVuZ3RoKSkge1xuICAgICAgZXIgPSBhcmd1bWVudHNbMV07XG4gICAgICBpZiAoZXIgaW5zdGFuY2VvZiBFcnJvcikge1xuICAgICAgICB0aHJvdyBlcjsgLy8gVW5oYW5kbGVkICdlcnJvcicgZXZlbnRcbiAgICAgIH1cbiAgICAgIHRocm93IFR5cGVFcnJvcignVW5jYXVnaHQsIHVuc3BlY2lmaWVkIFwiZXJyb3JcIiBldmVudC4nKTtcbiAgICB9XG4gIH1cblxuICBoYW5kbGVyID0gdGhpcy5fZXZlbnRzW3R5cGVdO1xuXG4gIGlmIChpc1VuZGVmaW5lZChoYW5kbGVyKSlcbiAgICByZXR1cm4gZmFsc2U7XG5cbiAgaWYgKGlzRnVuY3Rpb24oaGFuZGxlcikpIHtcbiAgICBzd2l0Y2ggKGFyZ3VtZW50cy5sZW5ndGgpIHtcbiAgICAgIC8vIGZhc3QgY2FzZXNcbiAgICAgIGNhc2UgMTpcbiAgICAgICAgaGFuZGxlci5jYWxsKHRoaXMpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgMjpcbiAgICAgICAgaGFuZGxlci5jYWxsKHRoaXMsIGFyZ3VtZW50c1sxXSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAzOlxuICAgICAgICBoYW5kbGVyLmNhbGwodGhpcywgYXJndW1lbnRzWzFdLCBhcmd1bWVudHNbMl0pO1xuICAgICAgICBicmVhaztcbiAgICAgIC8vIHNsb3dlclxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgbGVuID0gYXJndW1lbnRzLmxlbmd0aDtcbiAgICAgICAgYXJncyA9IG5ldyBBcnJheShsZW4gLSAxKTtcbiAgICAgICAgZm9yIChpID0gMTsgaSA8IGxlbjsgaSsrKVxuICAgICAgICAgIGFyZ3NbaSAtIDFdID0gYXJndW1lbnRzW2ldO1xuICAgICAgICBoYW5kbGVyLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgIH1cbiAgfSBlbHNlIGlmIChpc09iamVjdChoYW5kbGVyKSkge1xuICAgIGxlbiA9IGFyZ3VtZW50cy5sZW5ndGg7XG4gICAgYXJncyA9IG5ldyBBcnJheShsZW4gLSAxKTtcbiAgICBmb3IgKGkgPSAxOyBpIDwgbGVuOyBpKyspXG4gICAgICBhcmdzW2kgLSAxXSA9IGFyZ3VtZW50c1tpXTtcblxuICAgIGxpc3RlbmVycyA9IGhhbmRsZXIuc2xpY2UoKTtcbiAgICBsZW4gPSBsaXN0ZW5lcnMubGVuZ3RoO1xuICAgIGZvciAoaSA9IDA7IGkgPCBsZW47IGkrKylcbiAgICAgIGxpc3RlbmVyc1tpXS5hcHBseSh0aGlzLCBhcmdzKTtcbiAgfVxuXG4gIHJldHVybiB0cnVlO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5hZGRMaXN0ZW5lciA9IGZ1bmN0aW9uKHR5cGUsIGxpc3RlbmVyKSB7XG4gIHZhciBtO1xuXG4gIGlmICghaXNGdW5jdGlvbihsaXN0ZW5lcikpXG4gICAgdGhyb3cgVHlwZUVycm9yKCdsaXN0ZW5lciBtdXN0IGJlIGEgZnVuY3Rpb24nKTtcblxuICBpZiAoIXRoaXMuX2V2ZW50cylcbiAgICB0aGlzLl9ldmVudHMgPSB7fTtcblxuICAvLyBUbyBhdm9pZCByZWN1cnNpb24gaW4gdGhlIGNhc2UgdGhhdCB0eXBlID09PSBcIm5ld0xpc3RlbmVyXCIhIEJlZm9yZVxuICAvLyBhZGRpbmcgaXQgdG8gdGhlIGxpc3RlbmVycywgZmlyc3QgZW1pdCBcIm5ld0xpc3RlbmVyXCIuXG4gIGlmICh0aGlzLl9ldmVudHMubmV3TGlzdGVuZXIpXG4gICAgdGhpcy5lbWl0KCduZXdMaXN0ZW5lcicsIHR5cGUsXG4gICAgICAgICAgICAgIGlzRnVuY3Rpb24obGlzdGVuZXIubGlzdGVuZXIpID9cbiAgICAgICAgICAgICAgbGlzdGVuZXIubGlzdGVuZXIgOiBsaXN0ZW5lcik7XG5cbiAgaWYgKCF0aGlzLl9ldmVudHNbdHlwZV0pXG4gICAgLy8gT3B0aW1pemUgdGhlIGNhc2Ugb2Ygb25lIGxpc3RlbmVyLiBEb24ndCBuZWVkIHRoZSBleHRyYSBhcnJheSBvYmplY3QuXG4gICAgdGhpcy5fZXZlbnRzW3R5cGVdID0gbGlzdGVuZXI7XG4gIGVsc2UgaWYgKGlzT2JqZWN0KHRoaXMuX2V2ZW50c1t0eXBlXSkpXG4gICAgLy8gSWYgd2UndmUgYWxyZWFkeSBnb3QgYW4gYXJyYXksIGp1c3QgYXBwZW5kLlxuICAgIHRoaXMuX2V2ZW50c1t0eXBlXS5wdXNoKGxpc3RlbmVyKTtcbiAgZWxzZVxuICAgIC8vIEFkZGluZyB0aGUgc2Vjb25kIGVsZW1lbnQsIG5lZWQgdG8gY2hhbmdlIHRvIGFycmF5LlxuICAgIHRoaXMuX2V2ZW50c1t0eXBlXSA9IFt0aGlzLl9ldmVudHNbdHlwZV0sIGxpc3RlbmVyXTtcblxuICAvLyBDaGVjayBmb3IgbGlzdGVuZXIgbGVha1xuICBpZiAoaXNPYmplY3QodGhpcy5fZXZlbnRzW3R5cGVdKSAmJiAhdGhpcy5fZXZlbnRzW3R5cGVdLndhcm5lZCkge1xuICAgIHZhciBtO1xuICAgIGlmICghaXNVbmRlZmluZWQodGhpcy5fbWF4TGlzdGVuZXJzKSkge1xuICAgICAgbSA9IHRoaXMuX21heExpc3RlbmVycztcbiAgICB9IGVsc2Uge1xuICAgICAgbSA9IEV2ZW50RW1pdHRlci5kZWZhdWx0TWF4TGlzdGVuZXJzO1xuICAgIH1cblxuICAgIGlmIChtICYmIG0gPiAwICYmIHRoaXMuX2V2ZW50c1t0eXBlXS5sZW5ndGggPiBtKSB7XG4gICAgICB0aGlzLl9ldmVudHNbdHlwZV0ud2FybmVkID0gdHJ1ZTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJyhub2RlKSB3YXJuaW5nOiBwb3NzaWJsZSBFdmVudEVtaXR0ZXIgbWVtb3J5ICcgK1xuICAgICAgICAgICAgICAgICAgICAnbGVhayBkZXRlY3RlZC4gJWQgbGlzdGVuZXJzIGFkZGVkLiAnICtcbiAgICAgICAgICAgICAgICAgICAgJ1VzZSBlbWl0dGVyLnNldE1heExpc3RlbmVycygpIHRvIGluY3JlYXNlIGxpbWl0LicsXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50c1t0eXBlXS5sZW5ndGgpO1xuICAgICAgaWYgKHR5cGVvZiBjb25zb2xlLnRyYWNlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIC8vIG5vdCBzdXBwb3J0ZWQgaW4gSUUgMTBcbiAgICAgICAgY29uc29sZS50cmFjZSgpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB0aGlzO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5vbiA9IEV2ZW50RW1pdHRlci5wcm90b3R5cGUuYWRkTGlzdGVuZXI7XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUub25jZSA9IGZ1bmN0aW9uKHR5cGUsIGxpc3RlbmVyKSB7XG4gIGlmICghaXNGdW5jdGlvbihsaXN0ZW5lcikpXG4gICAgdGhyb3cgVHlwZUVycm9yKCdsaXN0ZW5lciBtdXN0IGJlIGEgZnVuY3Rpb24nKTtcblxuICB2YXIgZmlyZWQgPSBmYWxzZTtcblxuICBmdW5jdGlvbiBnKCkge1xuICAgIHRoaXMucmVtb3ZlTGlzdGVuZXIodHlwZSwgZyk7XG5cbiAgICBpZiAoIWZpcmVkKSB7XG4gICAgICBmaXJlZCA9IHRydWU7XG4gICAgICBsaXN0ZW5lci5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgIH1cbiAgfVxuXG4gIGcubGlzdGVuZXIgPSBsaXN0ZW5lcjtcbiAgdGhpcy5vbih0eXBlLCBnKTtcblxuICByZXR1cm4gdGhpcztcbn07XG5cbi8vIGVtaXRzIGEgJ3JlbW92ZUxpc3RlbmVyJyBldmVudCBpZmYgdGhlIGxpc3RlbmVyIHdhcyByZW1vdmVkXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLnJlbW92ZUxpc3RlbmVyID0gZnVuY3Rpb24odHlwZSwgbGlzdGVuZXIpIHtcbiAgdmFyIGxpc3QsIHBvc2l0aW9uLCBsZW5ndGgsIGk7XG5cbiAgaWYgKCFpc0Z1bmN0aW9uKGxpc3RlbmVyKSlcbiAgICB0aHJvdyBUeXBlRXJyb3IoJ2xpc3RlbmVyIG11c3QgYmUgYSBmdW5jdGlvbicpO1xuXG4gIGlmICghdGhpcy5fZXZlbnRzIHx8ICF0aGlzLl9ldmVudHNbdHlwZV0pXG4gICAgcmV0dXJuIHRoaXM7XG5cbiAgbGlzdCA9IHRoaXMuX2V2ZW50c1t0eXBlXTtcbiAgbGVuZ3RoID0gbGlzdC5sZW5ndGg7XG4gIHBvc2l0aW9uID0gLTE7XG5cbiAgaWYgKGxpc3QgPT09IGxpc3RlbmVyIHx8XG4gICAgICAoaXNGdW5jdGlvbihsaXN0Lmxpc3RlbmVyKSAmJiBsaXN0Lmxpc3RlbmVyID09PSBsaXN0ZW5lcikpIHtcbiAgICBkZWxldGUgdGhpcy5fZXZlbnRzW3R5cGVdO1xuICAgIGlmICh0aGlzLl9ldmVudHMucmVtb3ZlTGlzdGVuZXIpXG4gICAgICB0aGlzLmVtaXQoJ3JlbW92ZUxpc3RlbmVyJywgdHlwZSwgbGlzdGVuZXIpO1xuXG4gIH0gZWxzZSBpZiAoaXNPYmplY3QobGlzdCkpIHtcbiAgICBmb3IgKGkgPSBsZW5ndGg7IGktLSA+IDA7KSB7XG4gICAgICBpZiAobGlzdFtpXSA9PT0gbGlzdGVuZXIgfHxcbiAgICAgICAgICAobGlzdFtpXS5saXN0ZW5lciAmJiBsaXN0W2ldLmxpc3RlbmVyID09PSBsaXN0ZW5lcikpIHtcbiAgICAgICAgcG9zaXRpb24gPSBpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAocG9zaXRpb24gPCAwKVxuICAgICAgcmV0dXJuIHRoaXM7XG5cbiAgICBpZiAobGlzdC5sZW5ndGggPT09IDEpIHtcbiAgICAgIGxpc3QubGVuZ3RoID0gMDtcbiAgICAgIGRlbGV0ZSB0aGlzLl9ldmVudHNbdHlwZV07XG4gICAgfSBlbHNlIHtcbiAgICAgIGxpc3Quc3BsaWNlKHBvc2l0aW9uLCAxKTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5fZXZlbnRzLnJlbW92ZUxpc3RlbmVyKVxuICAgICAgdGhpcy5lbWl0KCdyZW1vdmVMaXN0ZW5lcicsIHR5cGUsIGxpc3RlbmVyKTtcbiAgfVxuXG4gIHJldHVybiB0aGlzO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5yZW1vdmVBbGxMaXN0ZW5lcnMgPSBmdW5jdGlvbih0eXBlKSB7XG4gIHZhciBrZXksIGxpc3RlbmVycztcblxuICBpZiAoIXRoaXMuX2V2ZW50cylcbiAgICByZXR1cm4gdGhpcztcblxuICAvLyBub3QgbGlzdGVuaW5nIGZvciByZW1vdmVMaXN0ZW5lciwgbm8gbmVlZCB0byBlbWl0XG4gIGlmICghdGhpcy5fZXZlbnRzLnJlbW92ZUxpc3RlbmVyKSB7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDApXG4gICAgICB0aGlzLl9ldmVudHMgPSB7fTtcbiAgICBlbHNlIGlmICh0aGlzLl9ldmVudHNbdHlwZV0pXG4gICAgICBkZWxldGUgdGhpcy5fZXZlbnRzW3R5cGVdO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLy8gZW1pdCByZW1vdmVMaXN0ZW5lciBmb3IgYWxsIGxpc3RlbmVycyBvbiBhbGwgZXZlbnRzXG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgZm9yIChrZXkgaW4gdGhpcy5fZXZlbnRzKSB7XG4gICAgICBpZiAoa2V5ID09PSAncmVtb3ZlTGlzdGVuZXInKSBjb250aW51ZTtcbiAgICAgIHRoaXMucmVtb3ZlQWxsTGlzdGVuZXJzKGtleSk7XG4gICAgfVxuICAgIHRoaXMucmVtb3ZlQWxsTGlzdGVuZXJzKCdyZW1vdmVMaXN0ZW5lcicpO1xuICAgIHRoaXMuX2V2ZW50cyA9IHt9O1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgbGlzdGVuZXJzID0gdGhpcy5fZXZlbnRzW3R5cGVdO1xuXG4gIGlmIChpc0Z1bmN0aW9uKGxpc3RlbmVycykpIHtcbiAgICB0aGlzLnJlbW92ZUxpc3RlbmVyKHR5cGUsIGxpc3RlbmVycyk7XG4gIH0gZWxzZSB7XG4gICAgLy8gTElGTyBvcmRlclxuICAgIHdoaWxlIChsaXN0ZW5lcnMubGVuZ3RoKVxuICAgICAgdGhpcy5yZW1vdmVMaXN0ZW5lcih0eXBlLCBsaXN0ZW5lcnNbbGlzdGVuZXJzLmxlbmd0aCAtIDFdKTtcbiAgfVxuICBkZWxldGUgdGhpcy5fZXZlbnRzW3R5cGVdO1xuXG4gIHJldHVybiB0aGlzO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5saXN0ZW5lcnMgPSBmdW5jdGlvbih0eXBlKSB7XG4gIHZhciByZXQ7XG4gIGlmICghdGhpcy5fZXZlbnRzIHx8ICF0aGlzLl9ldmVudHNbdHlwZV0pXG4gICAgcmV0ID0gW107XG4gIGVsc2UgaWYgKGlzRnVuY3Rpb24odGhpcy5fZXZlbnRzW3R5cGVdKSlcbiAgICByZXQgPSBbdGhpcy5fZXZlbnRzW3R5cGVdXTtcbiAgZWxzZVxuICAgIHJldCA9IHRoaXMuX2V2ZW50c1t0eXBlXS5zbGljZSgpO1xuICByZXR1cm4gcmV0O1xufTtcblxuRXZlbnRFbWl0dGVyLmxpc3RlbmVyQ291bnQgPSBmdW5jdGlvbihlbWl0dGVyLCB0eXBlKSB7XG4gIHZhciByZXQ7XG4gIGlmICghZW1pdHRlci5fZXZlbnRzIHx8ICFlbWl0dGVyLl9ldmVudHNbdHlwZV0pXG4gICAgcmV0ID0gMDtcbiAgZWxzZSBpZiAoaXNGdW5jdGlvbihlbWl0dGVyLl9ldmVudHNbdHlwZV0pKVxuICAgIHJldCA9IDE7XG4gIGVsc2VcbiAgICByZXQgPSBlbWl0dGVyLl9ldmVudHNbdHlwZV0ubGVuZ3RoO1xuICByZXR1cm4gcmV0O1xufTtcblxuZnVuY3Rpb24gaXNGdW5jdGlvbihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdmdW5jdGlvbic7XG59XG5cbmZ1bmN0aW9uIGlzTnVtYmVyKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ251bWJlcic7XG59XG5cbmZ1bmN0aW9uIGlzT2JqZWN0KGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ29iamVjdCcgJiYgYXJnICE9PSBudWxsO1xufVxuXG5mdW5jdGlvbiBpc1VuZGVmaW5lZChhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gdm9pZCAwO1xufVxuIiwiLy8gc2hpbSBmb3IgdXNpbmcgcHJvY2VzcyBpbiBicm93c2VyXG5cbnZhciBwcm9jZXNzID0gbW9kdWxlLmV4cG9ydHMgPSB7fTtcblxucHJvY2Vzcy5uZXh0VGljayA9IChmdW5jdGlvbiAoKSB7XG4gICAgdmFyIGNhblNldEltbWVkaWF0ZSA9IHR5cGVvZiB3aW5kb3cgIT09ICd1bmRlZmluZWQnXG4gICAgJiYgd2luZG93LnNldEltbWVkaWF0ZTtcbiAgICB2YXIgY2FuTXV0YXRpb25PYnNlcnZlciA9IHR5cGVvZiB3aW5kb3cgIT09ICd1bmRlZmluZWQnXG4gICAgJiYgd2luZG93Lk11dGF0aW9uT2JzZXJ2ZXI7XG4gICAgdmFyIGNhblBvc3QgPSB0eXBlb2Ygd2luZG93ICE9PSAndW5kZWZpbmVkJ1xuICAgICYmIHdpbmRvdy5wb3N0TWVzc2FnZSAmJiB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lclxuICAgIDtcblxuICAgIGlmIChjYW5TZXRJbW1lZGlhdGUpIHtcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIChmKSB7IHJldHVybiB3aW5kb3cuc2V0SW1tZWRpYXRlKGYpIH07XG4gICAgfVxuXG4gICAgdmFyIHF1ZXVlID0gW107XG5cbiAgICBpZiAoY2FuTXV0YXRpb25PYnNlcnZlcikge1xuICAgICAgICB2YXIgaGlkZGVuRGl2ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgICAgdmFyIG9ic2VydmVyID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdmFyIHF1ZXVlTGlzdCA9IHF1ZXVlLnNsaWNlKCk7XG4gICAgICAgICAgICBxdWV1ZS5sZW5ndGggPSAwO1xuICAgICAgICAgICAgcXVldWVMaXN0LmZvckVhY2goZnVuY3Rpb24gKGZuKSB7XG4gICAgICAgICAgICAgICAgZm4oKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcblxuICAgICAgICBvYnNlcnZlci5vYnNlcnZlKGhpZGRlbkRpdiwgeyBhdHRyaWJ1dGVzOiB0cnVlIH0pO1xuXG4gICAgICAgIHJldHVybiBmdW5jdGlvbiBuZXh0VGljayhmbikge1xuICAgICAgICAgICAgaWYgKCFxdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBoaWRkZW5EaXYuc2V0QXR0cmlidXRlKCd5ZXMnLCAnbm8nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHF1ZXVlLnB1c2goZm4pO1xuICAgICAgICB9O1xuICAgIH1cblxuICAgIGlmIChjYW5Qb3N0KSB7XG4gICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdtZXNzYWdlJywgZnVuY3Rpb24gKGV2KSB7XG4gICAgICAgICAgICB2YXIgc291cmNlID0gZXYuc291cmNlO1xuICAgICAgICAgICAgaWYgKChzb3VyY2UgPT09IHdpbmRvdyB8fCBzb3VyY2UgPT09IG51bGwpICYmIGV2LmRhdGEgPT09ICdwcm9jZXNzLXRpY2snKSB7XG4gICAgICAgICAgICAgICAgZXYuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICAgICAgICAgICAgaWYgKHF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGZuID0gcXVldWUuc2hpZnQoKTtcbiAgICAgICAgICAgICAgICAgICAgZm4oKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIHRydWUpO1xuXG4gICAgICAgIHJldHVybiBmdW5jdGlvbiBuZXh0VGljayhmbikge1xuICAgICAgICAgICAgcXVldWUucHVzaChmbik7XG4gICAgICAgICAgICB3aW5kb3cucG9zdE1lc3NhZ2UoJ3Byb2Nlc3MtdGljaycsICcqJyk7XG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIGZ1bmN0aW9uIG5leHRUaWNrKGZuKSB7XG4gICAgICAgIHNldFRpbWVvdXQoZm4sIDApO1xuICAgIH07XG59KSgpO1xuXG5wcm9jZXNzLnRpdGxlID0gJ2Jyb3dzZXInO1xucHJvY2Vzcy5icm93c2VyID0gdHJ1ZTtcbnByb2Nlc3MuZW52ID0ge307XG5wcm9jZXNzLmFyZ3YgPSBbXTtcblxuZnVuY3Rpb24gbm9vcCgpIHt9XG5cbnByb2Nlc3Mub24gPSBub29wO1xucHJvY2Vzcy5hZGRMaXN0ZW5lciA9IG5vb3A7XG5wcm9jZXNzLm9uY2UgPSBub29wO1xucHJvY2Vzcy5vZmYgPSBub29wO1xucHJvY2Vzcy5yZW1vdmVMaXN0ZW5lciA9IG5vb3A7XG5wcm9jZXNzLnJlbW92ZUFsbExpc3RlbmVycyA9IG5vb3A7XG5wcm9jZXNzLmVtaXQgPSBub29wO1xuXG5wcm9jZXNzLmJpbmRpbmcgPSBmdW5jdGlvbiAobmFtZSkge1xuICAgIHRocm93IG5ldyBFcnJvcigncHJvY2Vzcy5iaW5kaW5nIGlzIG5vdCBzdXBwb3J0ZWQnKTtcbn07XG5cbi8vIFRPRE8oc2h0eWxtYW4pXG5wcm9jZXNzLmN3ZCA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICcvJyB9O1xucHJvY2Vzcy5jaGRpciA9IGZ1bmN0aW9uIChkaXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuY2hkaXIgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcbiIsIm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gaXNCdWZmZXIoYXJnKSB7XG4gIHJldHVybiBhcmcgJiYgdHlwZW9mIGFyZyA9PT0gJ29iamVjdCdcbiAgICAmJiB0eXBlb2YgYXJnLmNvcHkgPT09ICdmdW5jdGlvbidcbiAgICAmJiB0eXBlb2YgYXJnLmZpbGwgPT09ICdmdW5jdGlvbidcbiAgICAmJiB0eXBlb2YgYXJnLnJlYWRVSW50OCA9PT0gJ2Z1bmN0aW9uJztcbn0iLCIoZnVuY3Rpb24gKHByb2Nlc3MsZ2xvYmFsKXtcbi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG52YXIgZm9ybWF0UmVnRXhwID0gLyVbc2RqJV0vZztcbmV4cG9ydHMuZm9ybWF0ID0gZnVuY3Rpb24oZikge1xuICBpZiAoIWlzU3RyaW5nKGYpKSB7XG4gICAgdmFyIG9iamVjdHMgPSBbXTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGFyZ3VtZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgb2JqZWN0cy5wdXNoKGluc3BlY3QoYXJndW1lbnRzW2ldKSk7XG4gICAgfVxuICAgIHJldHVybiBvYmplY3RzLmpvaW4oJyAnKTtcbiAgfVxuXG4gIHZhciBpID0gMTtcbiAgdmFyIGFyZ3MgPSBhcmd1bWVudHM7XG4gIHZhciBsZW4gPSBhcmdzLmxlbmd0aDtcbiAgdmFyIHN0ciA9IFN0cmluZyhmKS5yZXBsYWNlKGZvcm1hdFJlZ0V4cCwgZnVuY3Rpb24oeCkge1xuICAgIGlmICh4ID09PSAnJSUnKSByZXR1cm4gJyUnO1xuICAgIGlmIChpID49IGxlbikgcmV0dXJuIHg7XG4gICAgc3dpdGNoICh4KSB7XG4gICAgICBjYXNlICclcyc6IHJldHVybiBTdHJpbmcoYXJnc1tpKytdKTtcbiAgICAgIGNhc2UgJyVkJzogcmV0dXJuIE51bWJlcihhcmdzW2krK10pO1xuICAgICAgY2FzZSAnJWonOlxuICAgICAgICB0cnkge1xuICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShhcmdzW2krK10pO1xuICAgICAgICB9IGNhdGNoIChfKSB7XG4gICAgICAgICAgcmV0dXJuICdbQ2lyY3VsYXJdJztcbiAgICAgICAgfVxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmV0dXJuIHg7XG4gICAgfVxuICB9KTtcbiAgZm9yICh2YXIgeCA9IGFyZ3NbaV07IGkgPCBsZW47IHggPSBhcmdzWysraV0pIHtcbiAgICBpZiAoaXNOdWxsKHgpIHx8ICFpc09iamVjdCh4KSkge1xuICAgICAgc3RyICs9ICcgJyArIHg7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0ciArPSAnICcgKyBpbnNwZWN0KHgpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gc3RyO1xufTtcblxuXG4vLyBNYXJrIHRoYXQgYSBtZXRob2Qgc2hvdWxkIG5vdCBiZSB1c2VkLlxuLy8gUmV0dXJucyBhIG1vZGlmaWVkIGZ1bmN0aW9uIHdoaWNoIHdhcm5zIG9uY2UgYnkgZGVmYXVsdC5cbi8vIElmIC0tbm8tZGVwcmVjYXRpb24gaXMgc2V0LCB0aGVuIGl0IGlzIGEgbm8tb3AuXG5leHBvcnRzLmRlcHJlY2F0ZSA9IGZ1bmN0aW9uKGZuLCBtc2cpIHtcbiAgLy8gQWxsb3cgZm9yIGRlcHJlY2F0aW5nIHRoaW5ncyBpbiB0aGUgcHJvY2VzcyBvZiBzdGFydGluZyB1cC5cbiAgaWYgKGlzVW5kZWZpbmVkKGdsb2JhbC5wcm9jZXNzKSkge1xuICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgIHJldHVybiBleHBvcnRzLmRlcHJlY2F0ZShmbiwgbXNnKS5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgIH07XG4gIH1cblxuICBpZiAocHJvY2Vzcy5ub0RlcHJlY2F0aW9uID09PSB0cnVlKSB7XG4gICAgcmV0dXJuIGZuO1xuICB9XG5cbiAgdmFyIHdhcm5lZCA9IGZhbHNlO1xuICBmdW5jdGlvbiBkZXByZWNhdGVkKCkge1xuICAgIGlmICghd2FybmVkKSB7XG4gICAgICBpZiAocHJvY2Vzcy50aHJvd0RlcHJlY2F0aW9uKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihtc2cpO1xuICAgICAgfSBlbHNlIGlmIChwcm9jZXNzLnRyYWNlRGVwcmVjYXRpb24pIHtcbiAgICAgICAgY29uc29sZS50cmFjZShtc2cpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihtc2cpO1xuICAgICAgfVxuICAgICAgd2FybmVkID0gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gIH1cblxuICByZXR1cm4gZGVwcmVjYXRlZDtcbn07XG5cblxudmFyIGRlYnVncyA9IHt9O1xudmFyIGRlYnVnRW52aXJvbjtcbmV4cG9ydHMuZGVidWdsb2cgPSBmdW5jdGlvbihzZXQpIHtcbiAgaWYgKGlzVW5kZWZpbmVkKGRlYnVnRW52aXJvbikpXG4gICAgZGVidWdFbnZpcm9uID0gcHJvY2Vzcy5lbnYuTk9ERV9ERUJVRyB8fCAnJztcbiAgc2V0ID0gc2V0LnRvVXBwZXJDYXNlKCk7XG4gIGlmICghZGVidWdzW3NldF0pIHtcbiAgICBpZiAobmV3IFJlZ0V4cCgnXFxcXGInICsgc2V0ICsgJ1xcXFxiJywgJ2knKS50ZXN0KGRlYnVnRW52aXJvbikpIHtcbiAgICAgIHZhciBwaWQgPSBwcm9jZXNzLnBpZDtcbiAgICAgIGRlYnVnc1tzZXRdID0gZnVuY3Rpb24oKSB7XG4gICAgICAgIHZhciBtc2cgPSBleHBvcnRzLmZvcm1hdC5hcHBseShleHBvcnRzLCBhcmd1bWVudHMpO1xuICAgICAgICBjb25zb2xlLmVycm9yKCclcyAlZDogJXMnLCBzZXQsIHBpZCwgbXNnKTtcbiAgICAgIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIGRlYnVnc1tzZXRdID0gZnVuY3Rpb24oKSB7fTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGRlYnVnc1tzZXRdO1xufTtcblxuXG4vKipcbiAqIEVjaG9zIHRoZSB2YWx1ZSBvZiBhIHZhbHVlLiBUcnlzIHRvIHByaW50IHRoZSB2YWx1ZSBvdXRcbiAqIGluIHRoZSBiZXN0IHdheSBwb3NzaWJsZSBnaXZlbiB0aGUgZGlmZmVyZW50IHR5cGVzLlxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBvYmogVGhlIG9iamVjdCB0byBwcmludCBvdXQuXG4gKiBAcGFyYW0ge09iamVjdH0gb3B0cyBPcHRpb25hbCBvcHRpb25zIG9iamVjdCB0aGF0IGFsdGVycyB0aGUgb3V0cHV0LlxuICovXG4vKiBsZWdhY3k6IG9iaiwgc2hvd0hpZGRlbiwgZGVwdGgsIGNvbG9ycyovXG5mdW5jdGlvbiBpbnNwZWN0KG9iaiwgb3B0cykge1xuICAvLyBkZWZhdWx0IG9wdGlvbnNcbiAgdmFyIGN0eCA9IHtcbiAgICBzZWVuOiBbXSxcbiAgICBzdHlsaXplOiBzdHlsaXplTm9Db2xvclxuICB9O1xuICAvLyBsZWdhY3kuLi5cbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPj0gMykgY3R4LmRlcHRoID0gYXJndW1lbnRzWzJdO1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+PSA0KSBjdHguY29sb3JzID0gYXJndW1lbnRzWzNdO1xuICBpZiAoaXNCb29sZWFuKG9wdHMpKSB7XG4gICAgLy8gbGVnYWN5Li4uXG4gICAgY3R4LnNob3dIaWRkZW4gPSBvcHRzO1xuICB9IGVsc2UgaWYgKG9wdHMpIHtcbiAgICAvLyBnb3QgYW4gXCJvcHRpb25zXCIgb2JqZWN0XG4gICAgZXhwb3J0cy5fZXh0ZW5kKGN0eCwgb3B0cyk7XG4gIH1cbiAgLy8gc2V0IGRlZmF1bHQgb3B0aW9uc1xuICBpZiAoaXNVbmRlZmluZWQoY3R4LnNob3dIaWRkZW4pKSBjdHguc2hvd0hpZGRlbiA9IGZhbHNlO1xuICBpZiAoaXNVbmRlZmluZWQoY3R4LmRlcHRoKSkgY3R4LmRlcHRoID0gMjtcbiAgaWYgKGlzVW5kZWZpbmVkKGN0eC5jb2xvcnMpKSBjdHguY29sb3JzID0gZmFsc2U7XG4gIGlmIChpc1VuZGVmaW5lZChjdHguY3VzdG9tSW5zcGVjdCkpIGN0eC5jdXN0b21JbnNwZWN0ID0gdHJ1ZTtcbiAgaWYgKGN0eC5jb2xvcnMpIGN0eC5zdHlsaXplID0gc3R5bGl6ZVdpdGhDb2xvcjtcbiAgcmV0dXJuIGZvcm1hdFZhbHVlKGN0eCwgb2JqLCBjdHguZGVwdGgpO1xufVxuZXhwb3J0cy5pbnNwZWN0ID0gaW5zcGVjdDtcblxuXG4vLyBodHRwOi8vZW4ud2lraXBlZGlhLm9yZy93aWtpL0FOU0lfZXNjYXBlX2NvZGUjZ3JhcGhpY3Ncbmluc3BlY3QuY29sb3JzID0ge1xuICAnYm9sZCcgOiBbMSwgMjJdLFxuICAnaXRhbGljJyA6IFszLCAyM10sXG4gICd1bmRlcmxpbmUnIDogWzQsIDI0XSxcbiAgJ2ludmVyc2UnIDogWzcsIDI3XSxcbiAgJ3doaXRlJyA6IFszNywgMzldLFxuICAnZ3JleScgOiBbOTAsIDM5XSxcbiAgJ2JsYWNrJyA6IFszMCwgMzldLFxuICAnYmx1ZScgOiBbMzQsIDM5XSxcbiAgJ2N5YW4nIDogWzM2LCAzOV0sXG4gICdncmVlbicgOiBbMzIsIDM5XSxcbiAgJ21hZ2VudGEnIDogWzM1LCAzOV0sXG4gICdyZWQnIDogWzMxLCAzOV0sXG4gICd5ZWxsb3cnIDogWzMzLCAzOV1cbn07XG5cbi8vIERvbid0IHVzZSAnYmx1ZScgbm90IHZpc2libGUgb24gY21kLmV4ZVxuaW5zcGVjdC5zdHlsZXMgPSB7XG4gICdzcGVjaWFsJzogJ2N5YW4nLFxuICAnbnVtYmVyJzogJ3llbGxvdycsXG4gICdib29sZWFuJzogJ3llbGxvdycsXG4gICd1bmRlZmluZWQnOiAnZ3JleScsXG4gICdudWxsJzogJ2JvbGQnLFxuICAnc3RyaW5nJzogJ2dyZWVuJyxcbiAgJ2RhdGUnOiAnbWFnZW50YScsXG4gIC8vIFwibmFtZVwiOiBpbnRlbnRpb25hbGx5IG5vdCBzdHlsaW5nXG4gICdyZWdleHAnOiAncmVkJ1xufTtcblxuXG5mdW5jdGlvbiBzdHlsaXplV2l0aENvbG9yKHN0ciwgc3R5bGVUeXBlKSB7XG4gIHZhciBzdHlsZSA9IGluc3BlY3Quc3R5bGVzW3N0eWxlVHlwZV07XG5cbiAgaWYgKHN0eWxlKSB7XG4gICAgcmV0dXJuICdcXHUwMDFiWycgKyBpbnNwZWN0LmNvbG9yc1tzdHlsZV1bMF0gKyAnbScgKyBzdHIgK1xuICAgICAgICAgICAnXFx1MDAxYlsnICsgaW5zcGVjdC5jb2xvcnNbc3R5bGVdWzFdICsgJ20nO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBzdHI7XG4gIH1cbn1cblxuXG5mdW5jdGlvbiBzdHlsaXplTm9Db2xvcihzdHIsIHN0eWxlVHlwZSkge1xuICByZXR1cm4gc3RyO1xufVxuXG5cbmZ1bmN0aW9uIGFycmF5VG9IYXNoKGFycmF5KSB7XG4gIHZhciBoYXNoID0ge307XG5cbiAgYXJyYXkuZm9yRWFjaChmdW5jdGlvbih2YWwsIGlkeCkge1xuICAgIGhhc2hbdmFsXSA9IHRydWU7XG4gIH0pO1xuXG4gIHJldHVybiBoYXNoO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdFZhbHVlKGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcykge1xuICAvLyBQcm92aWRlIGEgaG9vayBmb3IgdXNlci1zcGVjaWZpZWQgaW5zcGVjdCBmdW5jdGlvbnMuXG4gIC8vIENoZWNrIHRoYXQgdmFsdWUgaXMgYW4gb2JqZWN0IHdpdGggYW4gaW5zcGVjdCBmdW5jdGlvbiBvbiBpdFxuICBpZiAoY3R4LmN1c3RvbUluc3BlY3QgJiZcbiAgICAgIHZhbHVlICYmXG4gICAgICBpc0Z1bmN0aW9uKHZhbHVlLmluc3BlY3QpICYmXG4gICAgICAvLyBGaWx0ZXIgb3V0IHRoZSB1dGlsIG1vZHVsZSwgaXQncyBpbnNwZWN0IGZ1bmN0aW9uIGlzIHNwZWNpYWxcbiAgICAgIHZhbHVlLmluc3BlY3QgIT09IGV4cG9ydHMuaW5zcGVjdCAmJlxuICAgICAgLy8gQWxzbyBmaWx0ZXIgb3V0IGFueSBwcm90b3R5cGUgb2JqZWN0cyB1c2luZyB0aGUgY2lyY3VsYXIgY2hlY2suXG4gICAgICAhKHZhbHVlLmNvbnN0cnVjdG9yICYmIHZhbHVlLmNvbnN0cnVjdG9yLnByb3RvdHlwZSA9PT0gdmFsdWUpKSB7XG4gICAgdmFyIHJldCA9IHZhbHVlLmluc3BlY3QocmVjdXJzZVRpbWVzLCBjdHgpO1xuICAgIGlmICghaXNTdHJpbmcocmV0KSkge1xuICAgICAgcmV0ID0gZm9ybWF0VmFsdWUoY3R4LCByZXQsIHJlY3Vyc2VUaW1lcyk7XG4gICAgfVxuICAgIHJldHVybiByZXQ7XG4gIH1cblxuICAvLyBQcmltaXRpdmUgdHlwZXMgY2Fubm90IGhhdmUgcHJvcGVydGllc1xuICB2YXIgcHJpbWl0aXZlID0gZm9ybWF0UHJpbWl0aXZlKGN0eCwgdmFsdWUpO1xuICBpZiAocHJpbWl0aXZlKSB7XG4gICAgcmV0dXJuIHByaW1pdGl2ZTtcbiAgfVxuXG4gIC8vIExvb2sgdXAgdGhlIGtleXMgb2YgdGhlIG9iamVjdC5cbiAgdmFyIGtleXMgPSBPYmplY3Qua2V5cyh2YWx1ZSk7XG4gIHZhciB2aXNpYmxlS2V5cyA9IGFycmF5VG9IYXNoKGtleXMpO1xuXG4gIGlmIChjdHguc2hvd0hpZGRlbikge1xuICAgIGtleXMgPSBPYmplY3QuZ2V0T3duUHJvcGVydHlOYW1lcyh2YWx1ZSk7XG4gIH1cblxuICAvLyBJRSBkb2Vzbid0IG1ha2UgZXJyb3IgZmllbGRzIG5vbi1lbnVtZXJhYmxlXG4gIC8vIGh0dHA6Ly9tc2RuLm1pY3Jvc29mdC5jb20vZW4tdXMvbGlicmFyeS9pZS9kd3c1MnNidCh2PXZzLjk0KS5hc3B4XG4gIGlmIChpc0Vycm9yKHZhbHVlKVxuICAgICAgJiYgKGtleXMuaW5kZXhPZignbWVzc2FnZScpID49IDAgfHwga2V5cy5pbmRleE9mKCdkZXNjcmlwdGlvbicpID49IDApKSB7XG4gICAgcmV0dXJuIGZvcm1hdEVycm9yKHZhbHVlKTtcbiAgfVxuXG4gIC8vIFNvbWUgdHlwZSBvZiBvYmplY3Qgd2l0aG91dCBwcm9wZXJ0aWVzIGNhbiBiZSBzaG9ydGN1dHRlZC5cbiAgaWYgKGtleXMubGVuZ3RoID09PSAwKSB7XG4gICAgaWYgKGlzRnVuY3Rpb24odmFsdWUpKSB7XG4gICAgICB2YXIgbmFtZSA9IHZhbHVlLm5hbWUgPyAnOiAnICsgdmFsdWUubmFtZSA6ICcnO1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKCdbRnVuY3Rpb24nICsgbmFtZSArICddJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gICAgaWYgKGlzUmVnRXhwKHZhbHVlKSkge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKFJlZ0V4cC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSksICdyZWdleHAnKTtcbiAgICB9XG4gICAgaWYgKGlzRGF0ZSh2YWx1ZSkpIHtcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZShEYXRlLnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHZhbHVlKSwgJ2RhdGUnKTtcbiAgICB9XG4gICAgaWYgKGlzRXJyb3IodmFsdWUpKSB7XG4gICAgICByZXR1cm4gZm9ybWF0RXJyb3IodmFsdWUpO1xuICAgIH1cbiAgfVxuXG4gIHZhciBiYXNlID0gJycsIGFycmF5ID0gZmFsc2UsIGJyYWNlcyA9IFsneycsICd9J107XG5cbiAgLy8gTWFrZSBBcnJheSBzYXkgdGhhdCB0aGV5IGFyZSBBcnJheVxuICBpZiAoaXNBcnJheSh2YWx1ZSkpIHtcbiAgICBhcnJheSA9IHRydWU7XG4gICAgYnJhY2VzID0gWydbJywgJ10nXTtcbiAgfVxuXG4gIC8vIE1ha2UgZnVuY3Rpb25zIHNheSB0aGF0IHRoZXkgYXJlIGZ1bmN0aW9uc1xuICBpZiAoaXNGdW5jdGlvbih2YWx1ZSkpIHtcbiAgICB2YXIgbiA9IHZhbHVlLm5hbWUgPyAnOiAnICsgdmFsdWUubmFtZSA6ICcnO1xuICAgIGJhc2UgPSAnIFtGdW5jdGlvbicgKyBuICsgJ10nO1xuICB9XG5cbiAgLy8gTWFrZSBSZWdFeHBzIHNheSB0aGF0IHRoZXkgYXJlIFJlZ0V4cHNcbiAgaWYgKGlzUmVnRXhwKHZhbHVlKSkge1xuICAgIGJhc2UgPSAnICcgKyBSZWdFeHAucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpO1xuICB9XG5cbiAgLy8gTWFrZSBkYXRlcyB3aXRoIHByb3BlcnRpZXMgZmlyc3Qgc2F5IHRoZSBkYXRlXG4gIGlmIChpc0RhdGUodmFsdWUpKSB7XG4gICAgYmFzZSA9ICcgJyArIERhdGUucHJvdG90eXBlLnRvVVRDU3RyaW5nLmNhbGwodmFsdWUpO1xuICB9XG5cbiAgLy8gTWFrZSBlcnJvciB3aXRoIG1lc3NhZ2UgZmlyc3Qgc2F5IHRoZSBlcnJvclxuICBpZiAoaXNFcnJvcih2YWx1ZSkpIHtcbiAgICBiYXNlID0gJyAnICsgZm9ybWF0RXJyb3IodmFsdWUpO1xuICB9XG5cbiAgaWYgKGtleXMubGVuZ3RoID09PSAwICYmICghYXJyYXkgfHwgdmFsdWUubGVuZ3RoID09IDApKSB7XG4gICAgcmV0dXJuIGJyYWNlc1swXSArIGJhc2UgKyBicmFjZXNbMV07XG4gIH1cblxuICBpZiAocmVjdXJzZVRpbWVzIDwgMCkge1xuICAgIGlmIChpc1JlZ0V4cCh2YWx1ZSkpIHtcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZShSZWdFeHAucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpLCAncmVnZXhwJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZSgnW09iamVjdF0nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgfVxuXG4gIGN0eC5zZWVuLnB1c2godmFsdWUpO1xuXG4gIHZhciBvdXRwdXQ7XG4gIGlmIChhcnJheSkge1xuICAgIG91dHB1dCA9IGZvcm1hdEFycmF5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsIGtleXMpO1xuICB9IGVsc2Uge1xuICAgIG91dHB1dCA9IGtleXMubWFwKGZ1bmN0aW9uKGtleSkge1xuICAgICAgcmV0dXJuIGZvcm1hdFByb3BlcnR5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsIGtleSwgYXJyYXkpO1xuICAgIH0pO1xuICB9XG5cbiAgY3R4LnNlZW4ucG9wKCk7XG5cbiAgcmV0dXJuIHJlZHVjZVRvU2luZ2xlU3RyaW5nKG91dHB1dCwgYmFzZSwgYnJhY2VzKTtcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRQcmltaXRpdmUoY3R4LCB2YWx1ZSkge1xuICBpZiAoaXNVbmRlZmluZWQodmFsdWUpKVxuICAgIHJldHVybiBjdHguc3R5bGl6ZSgndW5kZWZpbmVkJywgJ3VuZGVmaW5lZCcpO1xuICBpZiAoaXNTdHJpbmcodmFsdWUpKSB7XG4gICAgdmFyIHNpbXBsZSA9ICdcXCcnICsgSlNPTi5zdHJpbmdpZnkodmFsdWUpLnJlcGxhY2UoL15cInxcIiQvZywgJycpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvJy9nLCBcIlxcXFwnXCIpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvXFxcXFwiL2csICdcIicpICsgJ1xcJyc7XG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKHNpbXBsZSwgJ3N0cmluZycpO1xuICB9XG4gIGlmIChpc051bWJlcih2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCcnICsgdmFsdWUsICdudW1iZXInKTtcbiAgaWYgKGlzQm9vbGVhbih2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCcnICsgdmFsdWUsICdib29sZWFuJyk7XG4gIC8vIEZvciBzb21lIHJlYXNvbiB0eXBlb2YgbnVsbCBpcyBcIm9iamVjdFwiLCBzbyBzcGVjaWFsIGNhc2UgaGVyZS5cbiAgaWYgKGlzTnVsbCh2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCdudWxsJywgJ251bGwnKTtcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRFcnJvcih2YWx1ZSkge1xuICByZXR1cm4gJ1snICsgRXJyb3IucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpICsgJ10nO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdEFycmF5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsIGtleXMpIHtcbiAgdmFyIG91dHB1dCA9IFtdO1xuICBmb3IgKHZhciBpID0gMCwgbCA9IHZhbHVlLmxlbmd0aDsgaSA8IGw7ICsraSkge1xuICAgIGlmIChoYXNPd25Qcm9wZXJ0eSh2YWx1ZSwgU3RyaW5nKGkpKSkge1xuICAgICAgb3V0cHV0LnB1c2goZm9ybWF0UHJvcGVydHkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cyxcbiAgICAgICAgICBTdHJpbmcoaSksIHRydWUpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgb3V0cHV0LnB1c2goJycpO1xuICAgIH1cbiAgfVxuICBrZXlzLmZvckVhY2goZnVuY3Rpb24oa2V5KSB7XG4gICAgaWYgKCFrZXkubWF0Y2goL15cXGQrJC8pKSB7XG4gICAgICBvdXRwdXQucHVzaChmb3JtYXRQcm9wZXJ0eShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLFxuICAgICAgICAgIGtleSwgdHJ1ZSkpO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBvdXRwdXQ7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0UHJvcGVydHkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5LCBhcnJheSkge1xuICB2YXIgbmFtZSwgc3RyLCBkZXNjO1xuICBkZXNjID0gT2JqZWN0LmdldE93blByb3BlcnR5RGVzY3JpcHRvcih2YWx1ZSwga2V5KSB8fCB7IHZhbHVlOiB2YWx1ZVtrZXldIH07XG4gIGlmIChkZXNjLmdldCkge1xuICAgIGlmIChkZXNjLnNldCkge1xuICAgICAgc3RyID0gY3R4LnN0eWxpemUoJ1tHZXR0ZXIvU2V0dGVyXScsICdzcGVjaWFsJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0ciA9IGN0eC5zdHlsaXplKCdbR2V0dGVyXScsICdzcGVjaWFsJyk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGlmIChkZXNjLnNldCkge1xuICAgICAgc3RyID0gY3R4LnN0eWxpemUoJ1tTZXR0ZXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gIH1cbiAgaWYgKCFoYXNPd25Qcm9wZXJ0eSh2aXNpYmxlS2V5cywga2V5KSkge1xuICAgIG5hbWUgPSAnWycgKyBrZXkgKyAnXSc7XG4gIH1cbiAgaWYgKCFzdHIpIHtcbiAgICBpZiAoY3R4LnNlZW4uaW5kZXhPZihkZXNjLnZhbHVlKSA8IDApIHtcbiAgICAgIGlmIChpc051bGwocmVjdXJzZVRpbWVzKSkge1xuICAgICAgICBzdHIgPSBmb3JtYXRWYWx1ZShjdHgsIGRlc2MudmFsdWUsIG51bGwpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc3RyID0gZm9ybWF0VmFsdWUoY3R4LCBkZXNjLnZhbHVlLCByZWN1cnNlVGltZXMgLSAxKTtcbiAgICAgIH1cbiAgICAgIGlmIChzdHIuaW5kZXhPZignXFxuJykgPiAtMSkge1xuICAgICAgICBpZiAoYXJyYXkpIHtcbiAgICAgICAgICBzdHIgPSBzdHIuc3BsaXQoJ1xcbicpLm1hcChmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgICAgICByZXR1cm4gJyAgJyArIGxpbmU7XG4gICAgICAgICAgfSkuam9pbignXFxuJykuc3Vic3RyKDIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHN0ciA9ICdcXG4nICsgc3RyLnNwbGl0KCdcXG4nKS5tYXAoZnVuY3Rpb24obGluZSkge1xuICAgICAgICAgICAgcmV0dXJuICcgICAnICsgbGluZTtcbiAgICAgICAgICB9KS5qb2luKCdcXG4nKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBzdHIgPSBjdHguc3R5bGl6ZSgnW0NpcmN1bGFyXScsICdzcGVjaWFsJyk7XG4gICAgfVxuICB9XG4gIGlmIChpc1VuZGVmaW5lZChuYW1lKSkge1xuICAgIGlmIChhcnJheSAmJiBrZXkubWF0Y2goL15cXGQrJC8pKSB7XG4gICAgICByZXR1cm4gc3RyO1xuICAgIH1cbiAgICBuYW1lID0gSlNPTi5zdHJpbmdpZnkoJycgKyBrZXkpO1xuICAgIGlmIChuYW1lLm1hdGNoKC9eXCIoW2EtekEtWl9dW2EtekEtWl8wLTldKilcIiQvKSkge1xuICAgICAgbmFtZSA9IG5hbWUuc3Vic3RyKDEsIG5hbWUubGVuZ3RoIC0gMik7XG4gICAgICBuYW1lID0gY3R4LnN0eWxpemUobmFtZSwgJ25hbWUnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbmFtZSA9IG5hbWUucmVwbGFjZSgvJy9nLCBcIlxcXFwnXCIpXG4gICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXFxcXCIvZywgJ1wiJylcbiAgICAgICAgICAgICAgICAgLnJlcGxhY2UoLyheXCJ8XCIkKS9nLCBcIidcIik7XG4gICAgICBuYW1lID0gY3R4LnN0eWxpemUobmFtZSwgJ3N0cmluZycpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBuYW1lICsgJzogJyArIHN0cjtcbn1cblxuXG5mdW5jdGlvbiByZWR1Y2VUb1NpbmdsZVN0cmluZyhvdXRwdXQsIGJhc2UsIGJyYWNlcykge1xuICB2YXIgbnVtTGluZXNFc3QgPSAwO1xuICB2YXIgbGVuZ3RoID0gb3V0cHV0LnJlZHVjZShmdW5jdGlvbihwcmV2LCBjdXIpIHtcbiAgICBudW1MaW5lc0VzdCsrO1xuICAgIGlmIChjdXIuaW5kZXhPZignXFxuJykgPj0gMCkgbnVtTGluZXNFc3QrKztcbiAgICByZXR1cm4gcHJldiArIGN1ci5yZXBsYWNlKC9cXHUwMDFiXFxbXFxkXFxkP20vZywgJycpLmxlbmd0aCArIDE7XG4gIH0sIDApO1xuXG4gIGlmIChsZW5ndGggPiA2MCkge1xuICAgIHJldHVybiBicmFjZXNbMF0gK1xuICAgICAgICAgICAoYmFzZSA9PT0gJycgPyAnJyA6IGJhc2UgKyAnXFxuICcpICtcbiAgICAgICAgICAgJyAnICtcbiAgICAgICAgICAgb3V0cHV0LmpvaW4oJyxcXG4gICcpICtcbiAgICAgICAgICAgJyAnICtcbiAgICAgICAgICAgYnJhY2VzWzFdO1xuICB9XG5cbiAgcmV0dXJuIGJyYWNlc1swXSArIGJhc2UgKyAnICcgKyBvdXRwdXQuam9pbignLCAnKSArICcgJyArIGJyYWNlc1sxXTtcbn1cblxuXG4vLyBOT1RFOiBUaGVzZSB0eXBlIGNoZWNraW5nIGZ1bmN0aW9ucyBpbnRlbnRpb25hbGx5IGRvbid0IHVzZSBgaW5zdGFuY2VvZmBcbi8vIGJlY2F1c2UgaXQgaXMgZnJhZ2lsZSBhbmQgY2FuIGJlIGVhc2lseSBmYWtlZCB3aXRoIGBPYmplY3QuY3JlYXRlKClgLlxuZnVuY3Rpb24gaXNBcnJheShhcikge1xuICByZXR1cm4gQXJyYXkuaXNBcnJheShhcik7XG59XG5leHBvcnRzLmlzQXJyYXkgPSBpc0FycmF5O1xuXG5mdW5jdGlvbiBpc0Jvb2xlYW4oYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnYm9vbGVhbic7XG59XG5leHBvcnRzLmlzQm9vbGVhbiA9IGlzQm9vbGVhbjtcblxuZnVuY3Rpb24gaXNOdWxsKGFyZykge1xuICByZXR1cm4gYXJnID09PSBudWxsO1xufVxuZXhwb3J0cy5pc051bGwgPSBpc051bGw7XG5cbmZ1bmN0aW9uIGlzTnVsbE9yVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gYXJnID09IG51bGw7XG59XG5leHBvcnRzLmlzTnVsbE9yVW5kZWZpbmVkID0gaXNOdWxsT3JVbmRlZmluZWQ7XG5cbmZ1bmN0aW9uIGlzTnVtYmVyKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ251bWJlcic7XG59XG5leHBvcnRzLmlzTnVtYmVyID0gaXNOdW1iZXI7XG5cbmZ1bmN0aW9uIGlzU3RyaW5nKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ3N0cmluZyc7XG59XG5leHBvcnRzLmlzU3RyaW5nID0gaXNTdHJpbmc7XG5cbmZ1bmN0aW9uIGlzU3ltYm9sKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ3N5bWJvbCc7XG59XG5leHBvcnRzLmlzU3ltYm9sID0gaXNTeW1ib2w7XG5cbmZ1bmN0aW9uIGlzVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gYXJnID09PSB2b2lkIDA7XG59XG5leHBvcnRzLmlzVW5kZWZpbmVkID0gaXNVbmRlZmluZWQ7XG5cbmZ1bmN0aW9uIGlzUmVnRXhwKHJlKSB7XG4gIHJldHVybiBpc09iamVjdChyZSkgJiYgb2JqZWN0VG9TdHJpbmcocmUpID09PSAnW29iamVjdCBSZWdFeHBdJztcbn1cbmV4cG9ydHMuaXNSZWdFeHAgPSBpc1JlZ0V4cDtcblxuZnVuY3Rpb24gaXNPYmplY3QoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBhcmcgIT09IG51bGw7XG59XG5leHBvcnRzLmlzT2JqZWN0ID0gaXNPYmplY3Q7XG5cbmZ1bmN0aW9uIGlzRGF0ZShkKSB7XG4gIHJldHVybiBpc09iamVjdChkKSAmJiBvYmplY3RUb1N0cmluZyhkKSA9PT0gJ1tvYmplY3QgRGF0ZV0nO1xufVxuZXhwb3J0cy5pc0RhdGUgPSBpc0RhdGU7XG5cbmZ1bmN0aW9uIGlzRXJyb3IoZSkge1xuICByZXR1cm4gaXNPYmplY3QoZSkgJiZcbiAgICAgIChvYmplY3RUb1N0cmluZyhlKSA9PT0gJ1tvYmplY3QgRXJyb3JdJyB8fCBlIGluc3RhbmNlb2YgRXJyb3IpO1xufVxuZXhwb3J0cy5pc0Vycm9yID0gaXNFcnJvcjtcblxuZnVuY3Rpb24gaXNGdW5jdGlvbihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdmdW5jdGlvbic7XG59XG5leHBvcnRzLmlzRnVuY3Rpb24gPSBpc0Z1bmN0aW9uO1xuXG5mdW5jdGlvbiBpc1ByaW1pdGl2ZShhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gbnVsbCB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ2Jvb2xlYW4nIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnbnVtYmVyJyB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ3N0cmluZycgfHxcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICdzeW1ib2wnIHx8ICAvLyBFUzYgc3ltYm9sXG4gICAgICAgICB0eXBlb2YgYXJnID09PSAndW5kZWZpbmVkJztcbn1cbmV4cG9ydHMuaXNQcmltaXRpdmUgPSBpc1ByaW1pdGl2ZTtcblxuZXhwb3J0cy5pc0J1ZmZlciA9IHJlcXVpcmUoJy4vc3VwcG9ydC9pc0J1ZmZlcicpO1xuXG5mdW5jdGlvbiBvYmplY3RUb1N0cmluZyhvKSB7XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwobyk7XG59XG5cblxuZnVuY3Rpb24gcGFkKG4pIHtcbiAgcmV0dXJuIG4gPCAxMCA/ICcwJyArIG4udG9TdHJpbmcoMTApIDogbi50b1N0cmluZygxMCk7XG59XG5cblxudmFyIG1vbnRocyA9IFsnSmFuJywgJ0ZlYicsICdNYXInLCAnQXByJywgJ01heScsICdKdW4nLCAnSnVsJywgJ0F1ZycsICdTZXAnLFxuICAgICAgICAgICAgICAnT2N0JywgJ05vdicsICdEZWMnXTtcblxuLy8gMjYgRmViIDE2OjE5OjM0XG5mdW5jdGlvbiB0aW1lc3RhbXAoKSB7XG4gIHZhciBkID0gbmV3IERhdGUoKTtcbiAgdmFyIHRpbWUgPSBbcGFkKGQuZ2V0SG91cnMoKSksXG4gICAgICAgICAgICAgIHBhZChkLmdldE1pbnV0ZXMoKSksXG4gICAgICAgICAgICAgIHBhZChkLmdldFNlY29uZHMoKSldLmpvaW4oJzonKTtcbiAgcmV0dXJuIFtkLmdldERhdGUoKSwgbW9udGhzW2QuZ2V0TW9udGgoKV0sIHRpbWVdLmpvaW4oJyAnKTtcbn1cblxuXG4vLyBsb2cgaXMganVzdCBhIHRoaW4gd3JhcHBlciB0byBjb25zb2xlLmxvZyB0aGF0IHByZXBlbmRzIGEgdGltZXN0YW1wXG5leHBvcnRzLmxvZyA9IGZ1bmN0aW9uKCkge1xuICBjb25zb2xlLmxvZygnJXMgLSAlcycsIHRpbWVzdGFtcCgpLCBleHBvcnRzLmZvcm1hdC5hcHBseShleHBvcnRzLCBhcmd1bWVudHMpKTtcbn07XG5cblxuLyoqXG4gKiBJbmhlcml0IHRoZSBwcm90b3R5cGUgbWV0aG9kcyBmcm9tIG9uZSBjb25zdHJ1Y3RvciBpbnRvIGFub3RoZXIuXG4gKlxuICogVGhlIEZ1bmN0aW9uLnByb3RvdHlwZS5pbmhlcml0cyBmcm9tIGxhbmcuanMgcmV3cml0dGVuIGFzIGEgc3RhbmRhbG9uZVxuICogZnVuY3Rpb24gKG5vdCBvbiBGdW5jdGlvbi5wcm90b3R5cGUpLiBOT1RFOiBJZiB0aGlzIGZpbGUgaXMgdG8gYmUgbG9hZGVkXG4gKiBkdXJpbmcgYm9vdHN0cmFwcGluZyB0aGlzIGZ1bmN0aW9uIG5lZWRzIHRvIGJlIHJld3JpdHRlbiB1c2luZyBzb21lIG5hdGl2ZVxuICogZnVuY3Rpb25zIGFzIHByb3RvdHlwZSBzZXR1cCB1c2luZyBub3JtYWwgSmF2YVNjcmlwdCBkb2VzIG5vdCB3b3JrIGFzXG4gKiBleHBlY3RlZCBkdXJpbmcgYm9vdHN0cmFwcGluZyAoc2VlIG1pcnJvci5qcyBpbiByMTE0OTAzKS5cbiAqXG4gKiBAcGFyYW0ge2Z1bmN0aW9ufSBjdG9yIENvbnN0cnVjdG9yIGZ1bmN0aW9uIHdoaWNoIG5lZWRzIHRvIGluaGVyaXQgdGhlXG4gKiAgICAgcHJvdG90eXBlLlxuICogQHBhcmFtIHtmdW5jdGlvbn0gc3VwZXJDdG9yIENvbnN0cnVjdG9yIGZ1bmN0aW9uIHRvIGluaGVyaXQgcHJvdG90eXBlIGZyb20uXG4gKi9cbmV4cG9ydHMuaW5oZXJpdHMgPSByZXF1aXJlKCdpbmhlcml0cycpO1xuXG5leHBvcnRzLl9leHRlbmQgPSBmdW5jdGlvbihvcmlnaW4sIGFkZCkge1xuICAvLyBEb24ndCBkbyBhbnl0aGluZyBpZiBhZGQgaXNuJ3QgYW4gb2JqZWN0XG4gIGlmICghYWRkIHx8ICFpc09iamVjdChhZGQpKSByZXR1cm4gb3JpZ2luO1xuXG4gIHZhciBrZXlzID0gT2JqZWN0LmtleXMoYWRkKTtcbiAgdmFyIGkgPSBrZXlzLmxlbmd0aDtcbiAgd2hpbGUgKGktLSkge1xuICAgIG9yaWdpbltrZXlzW2ldXSA9IGFkZFtrZXlzW2ldXTtcbiAgfVxuICByZXR1cm4gb3JpZ2luO1xufTtcblxuZnVuY3Rpb24gaGFzT3duUHJvcGVydHkob2JqLCBwcm9wKSB7XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob2JqLCBwcm9wKTtcbn1cblxufSkuY2FsbCh0aGlzLHJlcXVpcmUoJ19wcm9jZXNzJyksdHlwZW9mIGdsb2JhbCAhPT0gXCJ1bmRlZmluZWRcIiA/IGdsb2JhbCA6IHR5cGVvZiBzZWxmICE9PSBcInVuZGVmaW5lZFwiID8gc2VsZiA6IHR5cGVvZiB3aW5kb3cgIT09IFwidW5kZWZpbmVkXCIgPyB3aW5kb3cgOiB7fSkiLCJ2YXIgRXZlbnRFbWl0dGVyID0gcmVxdWlyZSgnZXZlbnRzJykuRXZlbnRFbWl0dGVyO1xudmFyIHV0aWwgPSByZXF1aXJlKCd1dGlsJyk7XG5cbnZhciBTcHJheSA9IHJlcXVpcmUoJ3NwcmF5LXdydGMnKTtcbnZhciBDYXVzYWxCcm9hZGNhc3QgPSByZXF1aXJlKCdjYXVzYWwtYnJvYWRjYXN0LWRlZmluaXRpb24nKTtcbnZhciBWVndFID0gcmVxdWlyZSgndmVyc2lvbi12ZWN0b3Itd2l0aC1leGNlcHRpb25zJyk7XG52YXIgTFNFUVRyZWUgPSByZXF1aXJlKCdsc2VxdHJlZScpO1xudmFyIEdVSUQgPSByZXF1aXJlKCcuL2d1aWQuanMnKTtcblxudmFyIE1JbnNlcnRPcGVyYXRpb24gPSByZXF1aXJlKCcuL21lc3NhZ2VzLmpzJykuTUluc2VydE9wZXJhdGlvbjtcbnZhciBNQUVJbnNlcnRPcGVyYXRpb24gPSByZXF1aXJlKCcuL21lc3NhZ2VzLmpzJykuTUFFSW5zZXJ0T3BlcmF0aW9uO1xudmFyIE1SZW1vdmVPcGVyYXRpb24gPSByZXF1aXJlKCcuL21lc3NhZ2VzLmpzJykuTVJlbW92ZU9wZXJhdGlvbjtcbnZhciBNQ2FyZXRNb3ZlZE9wZXJhdGlvbiA9IHJlcXVpcmUoJy4vbWVzc2FnZXMuanMnKS5NQ2FyZXRNb3ZlZE9wZXJhdGlvbjtcblxudXRpbC5pbmhlcml0cyhDcmF0ZUNvcmUsIEV2ZW50RW1pdHRlcik7XG5cbi8qIVxuICogXFxicmllZiBsaW5rIHRvZ2V0aGVyIGFsbCBjb21wb25lbnRzIG9mIHRoZSBtb2RlbCBvZiB0aGUgQ1JBVEUgZWRpdG9yXG4gKiBcXHBhcmFtIGlkIHRoZSB1bmlxdWUgc2l0ZSBpZGVudGlmaWVyXG4gKiBcXHBhcmFtIG9wdGlvbnMgdGhlIHdlYnJ0YyBzcGVjaWZpYyBvcHRpb25zIFxuICovXG5mdW5jdGlvbiBDcmF0ZUNvcmUoaWQsIG9wdGlvbnMpe1xuICAgIEV2ZW50RW1pdHRlci5jYWxsKHRoaXMpO1xuICAgIFxuICAgIHRoaXMuaWQgPSBpZCB8fCBHVUlEKCk7XG4gICAgdGhpcy5vcHRpb25zID0gb3B0aW9ucztcbiAgICB0aGlzLmJyb2FkY2FzdCA9IG5ldyBDYXVzYWxCcm9hZGNhc3QobmV3IFNwcmF5KHRoaXMub3B0aW9ucyksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5ldyBWVndFKHRoaXMuaWQpKTtcbiAgICB0aGlzLnNlcXVlbmNlID0gbmV3IExTRVFUcmVlKHRoaXMuaWQpO1xuXG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIC8vICNBIHJlZ3VsYXIgcmVjZWl2ZVxuICAgIHRoaXMuYnJvYWRjYXN0Lm9uKCdyZWNlaXZlJywgZnVuY3Rpb24ocmVjZWl2ZWRCcm9hZGNhc3RNZXNzYWdlKXtcbiAgICAgICAgc3dpdGNoIChyZWNlaXZlZEJyb2FkY2FzdE1lc3NhZ2UudHlwZSl7XG4gICAgICAgIGNhc2UgJ01SZW1vdmVPcGVyYXRpb24nOlxuICAgICAgICAgICAgc2VsZi5yZW1vdGVSZW1vdmUocmVjZWl2ZWRCcm9hZGNhc3RNZXNzYWdlLnJlbW92ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY2VpdmVkQnJvYWRjYXN0TWVzc2FnZS5vcmlnaW4pO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ01JbnNlcnRPcGVyYXRpb24nOlxuICAgICAgICAgICAgc2VsZi5yZW1vdGVJbnNlcnQocmVjZWl2ZWRCcm9hZGNhc3RNZXNzYWdlLmluc2VydCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY2VpdmVkQnJvYWRjYXN0TWVzc2FnZS5vcmlnaW4pO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ01DYXJldE1vdmVkT3BlcmF0aW9uJzpcbiAgICAgICAgICAgIHNlbGYucmVtb3RlQ2FyZXRNb3ZlZChyZWNlaXZlZEJyb2FkY2FzdE1lc3NhZ2UucmFuZ2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjZWl2ZWRCcm9hZGNhc3RNZXNzYWdlLm9yaWdpbik7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgfTtcbiAgICB9KTtcbiAgICAvLyAjQiBhbnRpLWVudHJvcHkgZm9yIHRoZSBtaXNzaW5nIG9wZXJhdGlvblxuICAgIHRoaXMuYnJvYWRjYXN0Lm9uKCdhbnRpRW50cm9weScsIGZ1bmN0aW9uKHNvY2tldCwgcmVtb3RlVlZ3RSwgbG9jYWxWVndFKXtcbiAgICAgICAgdmFyIHJlbW90ZVZWd0UgPSAobmV3IFZWd0UobnVsbCkpLmZyb21KU09OKHJlbW90ZVZWd0UpOyAvLyBjYXN0XG4gICAgICAgIHZhciB0b1NlYXJjaCA9IFtdO1xuICAgICAgICAvLyAjMSBmb3IgZWFjaCBlbnRyeSBvZiBvdXIgVlZ3RSwgbG9vayBpZiB0aGUgcmVtb3RlIFZWd0Uga25vd3MgbGVzc1xuICAgICAgICBmb3IgKHZhciBpPTA7IGk8bG9jYWxWVndFLnZlY3Rvci5hcnIubGVuZ3RoOyArK2kpe1xuICAgICAgICAgICAgdmFyIGxvY2FsRW50cnkgPSBsb2NhbFZWd0UudmVjdG9yLmFycltpXTtcbiAgICAgICAgICAgIHZhciBpbmRleCA9IHJlbW90ZVZWd0UudmVjdG9yLmluZGV4T2YobG9jYWxWVndFLnZlY3Rvci5hcnJbaV0pO1xuICAgICAgICAgICAgdmFyIHN0YXJ0ID0gMTtcbiAgICAgICAgICAgIC8vICNBIGNoZWNrIGlmIHRoZSBlbnRyeSBleGlzdHMgaW4gdGhlIHJlbW90ZSB2dndlXG4gICAgICAgICAgICBpZiAoaW5kZXggPj0wKXsgc3RhcnQgPSByZW1vdGVWVndFLnZlY3Rvci5hcnJbaW5kZXhdLnYgKyAxOyB9O1xuICAgICAgICAgICAgZm9yICh2YXIgaj1zdGFydDsgajw9bG9jYWxFbnRyeS52OyArK2ope1xuICAgICAgICAgICAgICAgIC8vICNCIGNoZWNrIGlmIG5vdCBvbmUgb2YgdGhlIGxvY2FsIGV4Y2VwdGlvbnNcbiAgICAgICAgICAgICAgICBpZiAobG9jYWxFbnRyeS54LmluZGV4T2Yoaik8MCl7XG4gICAgICAgICAgICAgICAgICAgIHRvU2VhcmNoLnB1c2goe19lOiBsb2NhbEVudHJ5LmUsIF9jOiBqfSk7XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICAvLyAjQyBoYW5kbGUgdGhlIGV4Y2VwdGlvbnMgb2YgdGhlIHJlbW90ZSB2ZWN0b3JcbiAgICAgICAgICAgIGlmIChpbmRleCA+PTApe1xuICAgICAgICAgICAgICAgIGZvciAodmFyIGo9MDsgajxyZW1vdGVWVndFLnZlY3Rvci5hcnJbaW5kZXhdLngubGVuZ3RoOysrail7XG4gICAgICAgICAgICAgICAgICAgIHZhciBleGNlcHQgPSByZW1vdGVWVndFLnZlY3Rvci5hcnJbaW5kZXhdLnhbal07XG4gICAgICAgICAgICAgICAgICAgIGlmIChsb2NhbEVudHJ5LnguaW5kZXhPZihleGNlcHQpPDAgJiYgZXhjZXB0PD1sb2NhbEVudHJ5LnYpe1xuICAgICAgICAgICAgICAgICAgICAgICAgdG9TZWFyY2gucHVzaCh7X2U6IGxvY2FsRW50cnkuZSwgX2M6IGV4Y2VwdH0pO1xuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9O1xuICAgICAgICB9O1xuICAgICAgICB2YXIgZWxlbWVudHMgPSBzZWxmLmdldEVsZW1lbnRzKHRvU2VhcmNoKTtcbiAgICAgICAgLy92YXIgZWxlbWVudHMgPSBbXTtcbiAgICAgICAgLy8gIzIgc2VuZCBiYWNrIHRoZSBmb3VuZCBlbGVtZW50c1xuICAgICAgICBzZWxmLmJyb2FkY2FzdC5zZW5kQW50aUVudHJvcHlSZXNwb25zZShzb2NrZXQsIGxvY2FsVlZ3RSwgZWxlbWVudHMpO1xuICAgIH0pO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGNyZWF0ZSB0aGUgY29yZSBmcm9tIGFuIGV4aXN0aW5nIG9iamVjdFxuICogXFxwYXJhbSBvYmplY3QgdGhlIG9iamVjdCB0byBpbml0aWFsaXplIHRoZSBjb3JlIG1vZGVsIG9mIGNyYXRlIGNvbnRhaW5pbmcgYSBcbiAqIHNlcXVlbmNlIGFuZCBjYXVzYWxpdHkgdHJhY2tpbmcgbWV0YWRhdGFcbiAqL1xuQ3JhdGVDb3JlLnByb3RvdHlwZS5pbml0ID0gZnVuY3Rpb24ob2JqZWN0KXtcbiAgICAvLyBpbXBvcnQgdGhlIHNlcXVlbmNlIGFuZCB2ZXJzaW9uIHZlY3RvciwgeWV0IGl0IGtlZXBzIHRoZSBpZGVudGlmaWVyIG9mXG4gICAgLy8gdGhpcyBpbnN0YW5jZSBvZiB0aGUgY29yZS5cbiAgICB2YXIgbG9jYWwgPSB0aGlzLmJyb2FkY2FzdC5jYXVzYWxpdHkubG9jYWw7XG4gICAgdGhpcy5icm9hZGNhc3QuY2F1c2FsaXR5LmZyb21KU09OKG9iamVjdC5jYXVzYWxpdHkpO1xuICAgIHRoaXMuYnJvYWRjYXN0LmNhdXNhbGl0eS5sb2NhbCA9IGxvY2FsO1xuICAgIHRoaXMuYnJvYWRjYXN0LmNhdXNhbGl0eS52ZWN0b3IuaW5zZXJ0KHRoaXMuYnJvYWRjYXN0LmNhdXNhbGl0eS5sb2NhbCk7XG4gICAgXG4gICAgdGhpcy5zZXF1ZW5jZS5mcm9tSlNPTihvYmplY3Quc2VxdWVuY2UpO1xuICAgIHRoaXMuc2VxdWVuY2UuX3MgPSBsb2NhbC5lO1xuICAgIHRoaXMuc2VxdWVuY2UuX2MgPSBsb2NhbC52O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGxvY2FsIGluc2VydGlvbiBvZiBhIGNoYXJhY3RlciBpbnNpZGUgdGhlIHNlcXVlbmNlIHN0cnVjdHVyZS4gSXRcbiAqIGJyb2FkY2FzdHMgdGhlIG9wZXJhdGlvbiB0byB0aGUgcmVzdCBvZiB0aGUgbmV0d29yay5cbiAqIFxccGFyYW0gY2hhcmFjdGVyIHRoZSBjaGFyYWN0ZXIgdG8gaW5zZXJ0IGluIHRoZSBzZXF1ZW5jZVxuICogXFxwYXJhbSBpbmRleCB0aGUgaW5kZXggaW4gdGhlIHNlcXVlbmNlIHRvIGluc2VydFxuICogXFxyZXR1cm4gdGhlIGlkZW50aWZpZXIgZnJlc2hseSBhbGxvY2F0ZWRcbiAqL1xuQ3JhdGVDb3JlLnByb3RvdHlwZS5pbnNlcnQgPSBmdW5jdGlvbihjaGFyYWN0ZXIsIGluZGV4KXtcbiAgICB2YXIgZWkgPSB0aGlzLnNlcXVlbmNlLmluc2VydChjaGFyYWN0ZXIsIGluZGV4KTtcbiAgICB2YXIgaWQgPSB7X2U6IGVpLl9pLl9zW2VpLl9pLl9zLmxlbmd0aC0xXSwgX2M6IGVpLl9pLl9jW2VpLl9pLl9jLmxlbmd0aC0xXX07XG4gICAgdGhpcy5icm9hZGNhc3Quc2VuZChuZXcgTUluc2VydE9wZXJhdGlvbihlaSwgaWQuX2UpLCBpZCwgbnVsbCk7XG4gICAgcmV0dXJuIGVpO1xufTtcblxuLyohXG4gKiBcXGJyaWVmIGxvY2FsIGRlbGV0aW9uIG9mIGEgY2hhcmFjdGVyIGZyb20gdGhlIHNlcXVlbmNlIHN0cnVjdHVyZS4gSXQgXG4gKiBicm9hZGNhc3RzIHRoZSBvcGVyYXRpb24gdG8gdGhlIHJlc3Qgb2YgdGhlIG5ldHdvcmsuXG4gKiBcXHBhcmFtIGluZGV4IHRoZSBpbmRleCBvZiB0aGUgZWxlbWVudCB0byByZW1vdmVcbiAqIFxccmV0dXJuIHRoZSBpZGVudGlmaWVyIGZyZXNobHkgcmVtb3ZlZFxuICovXG5DcmF0ZUNvcmUucHJvdG90eXBlLnJlbW92ZSA9IGZ1bmN0aW9uKGluZGV4KXtcbiAgICB2YXIgaSA9IHRoaXMuc2VxdWVuY2UucmVtb3ZlKGluZGV4KTtcbiAgICB2YXIgaXNSZWFkeSA9IHtfZTogaS5fc1tpLl9zLmxlbmd0aC0xXSwgX2M6IGkuX2NbaS5fYy5sZW5ndGgtMV19O1xuICAgIHRoaXMuc2VxdWVuY2UuX2MgKz0gMTtcbiAgICB2YXIgaWQgPSB7X2U6dGhpcy5zZXF1ZW5jZS5fcywgX2M6IHRoaXMuc2VxdWVuY2UuX2MgfSAvLyAoVE9ETykgZml4IHVnbHluZXNzXG4gICAgdGhpcy5icm9hZGNhc3Quc2VuZChuZXcgTVJlbW92ZU9wZXJhdGlvbihpLCBpZC5fZSksIGlkLCBpc1JlYWR5KTtcbiAgICByZXR1cm4gaTtcbn07XG5cbkNyYXRlQ29yZS5wcm90b3R5cGUuY2FyZXRNb3ZlZCA9IGZ1bmN0aW9uKHJhbmdlKXtcbiAgICB0aGlzLnNlcXVlbmNlLl9jICs9IDE7XG4gICAgdmFyIGlkID0ge19lOnRoaXMuc2VxdWVuY2UuX3MsIF9jOiB0aGlzLnNlcXVlbmNlLl9jIH0gLy8gKFRPRE8pIGZpeCB1Z2x5bmVzc1xuICAgIHRoaXMuYnJvYWRjYXN0LnNlbmQobmV3IE1DYXJldE1vdmVkT3BlcmF0aW9uKHJhbmdlLCBpZC5fZSksIGlkLCBudWxsKTtcbiAgICByZXR1cm4gcmFuZ2U7XG59O1xuXG4vKiFcbiAqIFxcYnJpZWYgaW5zZXJ0aW9uIG9mIGFuIGVsZW1lbnQgZnJvbSBhIHJlbW90ZSBzaXRlLiBJdCBlbWl0cyAncmVtb3RlSW5zZXJ0JyBcbiAqIHdpdGggdGhlIGluZGV4IG9mIHRoZSBlbGVtZW50IHRvIGluc2VydCwgLTEgaWYgYWxyZWFkeSBleGlzdGluZy5cbiAqIFxccGFyYW0gZWkgdGhlIHJlc3VsdCBvZiB0aGUgcmVtb3RlIGluc2VydCBvcGVyYXRpb25cbiAqIFxccGFyYW0gb3JpZ2luIHRoZSBvcmlnaW4gaWQgb2YgdGhlIGluc2VydCBvcGVyYXRpb25cbiAqL1xuQ3JhdGVDb3JlLnByb3RvdHlwZS5yZW1vdGVJbnNlcnQgPSBmdW5jdGlvbihlaSwgb3JpZ2luKXtcbiAgICB2YXIgaW5kZXggPSB0aGlzLnNlcXVlbmNlLmFwcGx5SW5zZXJ0KGVpLl9lLCBlaS5faSwgZmFsc2UpO1xuICAgIHRoaXMuZW1pdCgncmVtb3RlSW5zZXJ0JywgZWkuX2UsIGluZGV4KTtcbiAgICBpZiAoaW5kZXggPj0gMCAmJiBvcmlnaW4pe1xuICAgICAgICB0aGlzLmVtaXQoJ3JlbW90ZUNhcmV0TW92ZWQnLCB7c3RhcnQ6IGluZGV4LCBlbmQ6IGluZGV4fSwgb3JpZ2luKTtcbiAgICB9O1xufTtcblxuLyohXG4gKiBcXGJyaWVmIHJlbW92YWwgb2YgYW4gZWxlbWVudCBmcm9tIGEgcmVtb3RlIHNpdGUuICBJdCBlbWl0cyAncmVtb3RlUmVtb3ZlJ1xuICogd2l0aCB0aGUgaW5kZXggb2YgdGhlIGVsZW1lbnQgdG8gcmVtb3ZlLCAtMSBpZiBkb2VzIG5vdCBleGlzdFxuICogXFxwYXJhbSBpZCB0aGUgcmVzdWx0IG9mIHRoZSByZW1vdGUgaW5zZXJ0IG9wZXJhdGlvblxuICogXFxwYXJhbSBvcmlnaW4gdGhlIG9yaWdpbiBpZCBvZiB0aGUgcmVtb3ZhbFxuICovXG5DcmF0ZUNvcmUucHJvdG90eXBlLnJlbW90ZVJlbW92ZSA9IGZ1bmN0aW9uKGlkLCBvcmlnaW4pe1xuICAgIHZhciBpbmRleCA9IHRoaXMuc2VxdWVuY2UuYXBwbHlSZW1vdmUoaWQpO1xuICAgIHRoaXMuZW1pdCgncmVtb3RlUmVtb3ZlJywgaW5kZXgpO1xuICAgIGlmIChpbmRleCA+PSAwICYmIG9yaWdpbil7XG4gICAgICAgIHRoaXMuZW1pdCgncmVtb3RlQ2FyZXRNb3ZlZCcsIHtzdGFydDogaW5kZXgtMSwgZW5kOiBpbmRleC0xfSwgb3JpZ2luKTtcbiAgICB9O1xufTtcblxuQ3JhdGVDb3JlLnByb3RvdHlwZS5yZW1vdGVDYXJldE1vdmVkID0gZnVuY3Rpb24ocmFuZ2UsIG9yaWdpbil7XG4gICAgdGhpcy5lbWl0KCdyZW1vdGVDYXJldE1vdmVkJywgcmFuZ2UsIG9yaWdpbik7XG59O1xuXG5cbi8qIVxuICogXFxicmllZiBzZWFyY2ggYSBzZXQgb2YgZWxlbWVudHMgaW4gb3VyIHNlcXVlbmNlIGFuZCByZXR1cm4gdGhlbVxuICogXFxwYXJhbSB0b1NlYXJjaCB0aGUgYXJyYXkgb2YgZWxlbWVudHMge19lLCBfY30gdG8gc2VhcmNoXG4gKiBcXHJldHVybnMgYW4gYXJyYXkgb2Ygbm9kZXNcbiAqL1xuQ3JhdGVDb3JlLnByb3RvdHlwZS5nZXRFbGVtZW50cyA9IGZ1bmN0aW9uKHRvU2VhcmNoKXtcbiAgICB2YXIgcmVzdWx0ID0gW10sIGZvdW5kLCBub2RlLCB0ZW1wTm9kZSwgaT10aGlzLnNlcXVlbmNlLmxlbmd0aCwgaj0wO1xuICAgIC8vIChUT0RPKSBpbXByb3ZlIHJlc2VhcmNoIGJ5IGV4cGxvaXRpbmcgdGhlIGZhY3QgdGhhdCBpZiBhIG5vZGUgaXNcbiAgICAvLyBtaXNzaW5nLCBhbGwgaXRzIGNoaWxkcmVuIGFyZSBtaXNzaW5nIHRvby5cbiAgICAvLyAoVE9ETykgaW1wcm92ZSB0aGUgcmV0dXJuZWQgcmVwcmVzZW50YXRpb246IGVpdGhlciBhIHRyZWUgdG8gZmFjdG9yaXplXG4gICAgLy8gY29tbW9uIHBhcnRzIG9mIHRoZSBzdHJ1Y3R1cmUgb3IgaWRlbnRpZmllcnMgdG8gZ2V0IHRoZSBwb2x5bG9nIHNpemVcbiAgICAvLyAoVE9ETykgaW1wcm92ZSB0aGUgc2VhcmNoIGJ5IHVzaW5nIHRoZSBmYWN0IHRoYXQgdG9TZWFyY2ggaXMgYSBzb3J0ZWRcbiAgICAvLyBhcnJheSwgcG9zc2libHkgcmVzdHJ1Y3R1cmUgdGhpcyBhcmd1bWVudCB0byBiZSBldmVuIG1vcmUgZWZmaWNpZW50XG4gICAgd2hpbGUgKHRvU2VhcmNoLmxlbmd0aCA+IDAgJiYgaTw9dGhpcy5zZXF1ZW5jZS5sZW5ndGggJiYgaT4wKXtcbiAgICAgICAgbm9kZSA9IHRoaXMuc2VxdWVuY2UuZ2V0KGkpO1xuICAgICAgICB0ZW1wTm9kZSA9IG5vZGU7XG4gICAgICAgIHdoaWxlKCB0ZW1wTm9kZS5jaGlsZHJlbi5sZW5ndGggPiAwKXtcbiAgICAgICAgICAgIHRlbXBOb2RlID0gdGVtcE5vZGUuY2hpbGRyZW5bMF07XG4gICAgICAgIH07XG4gICAgICAgIGogPSAwO1xuICAgICAgICBmb3VuZCA9IGZhbHNlO1xuICAgICAgICB3aGlsZSAoaiA8IHRvU2VhcmNoLmxlbmd0aCAmJiAhZm91bmQpe1xuICAgICAgICAgICAgaWYgKHRlbXBOb2RlLnQucyA9PT0gdG9TZWFyY2hbal0uX2UgJiZcbiAgICAgICAgICAgICAgICB0ZW1wTm9kZS50LmMgPT09IHRvU2VhcmNoW2pdLl9jKXtcbiAgICAgICAgICAgICAgICBmb3VuZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgcmVzdWx0LnB1c2gobmV3IE1BRUluc2VydE9wZXJhdGlvbih7X2U6IHRlbXBOb2RlLmUsIF9pOm5vZGV9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge19lOiB0b1NlYXJjaFtqXS5fZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBfYzogdG9TZWFyY2hbal0uX2N9ICkpO1xuICAgICAgICAgICAgICAgIHRvU2VhcmNoLnNwbGljZShqLDEpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICArK2o7XG4gICAgICAgICAgICB9O1xuICAgICAgICB9O1xuICAgICAgICAvLyAgICAgICAgKytpO1xuICAgICAgICAtLWk7XG4gICAgfTtcbiAgICByZXR1cm4gcmVzdWx0O1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBDcmF0ZUNvcmU7XG4iXX0=
