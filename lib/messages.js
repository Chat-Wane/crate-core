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
