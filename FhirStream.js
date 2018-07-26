const { Readable } = require("stream");
const config       = require("./config");
const Lib          = require("./lib");
const QueryBuilder = require("./QueryBuilder");
const DB           = require("./db");

const HEX    = "[a-fA-F0-9]"
const RE_UID = new RegExp(
    `\\b(${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12})\\b`,
    "g"
);

class FhirStream extends Readable
{
    constructor(req, res)
    {
        super({ objectMode: true });

        const args      = req.sim;

        this.limit      = Lib.uInt(args.limit, config.defaultPageSize);
        this.multiplier = Lib.uInt(args.m, 1);
        this.offset     = Lib.uInt(args.offset, 0);
        this.extended   = Lib.bool(args.extended);
        this.group      = args.group;
        this.start      = args._since;
        this.types      = [req.params.file.split(".")[1]];
        this.params     = {};
        this.cache      = [];
        this.statement  = null;
        this.page       = 0;
        this.total      = 0;
        this.totalPages = 0;
        this.rowIndex   = 0;
        this.overflow   = 0;

        this.timer = null

        this.builder = new QueryBuilder({
            limit      : this.limit,
            offset     : this.offset,
            group      : this.group,
            start      : this.start,
            type       : this.types,
            systemLevel: args.systemLevel,
            columns    : this.extended ?
                ["resource_json", "modified_date"] :
                ["resource_json"]
        });

        this.handleError = this.handleError.bind(this);
        this.getNextRow  = this.getNextRow .bind(this);

        let delay = config.throttle || 0;
        if (!delay) {
            this._read = () => {
                this.timer = setImmediate(this.getNextRow);
            };
        }
        else {
            this._read = () => {
                this.timer = setTimeout(this.getNextRow, delay);
            };
        }
    }

    handleError(error)
    {
        setImmediate(() => this.emit('error', error));
    }

    _destroy(err, callback)
    {
        if (this.timer) {
            let delay = config.throttle || 0;
            if (delay) {
                clearTimeout(this.timer);
            } else {
                clearImmediate(this.timer);
            }
        }
        callback && callback(err);
    }

    init()
    {
        if (!this.initialized) {
            return this.countRecords()
                .then(() => this.prepare())
                .then(() => this.fetch())
                .then(() => {
                    this.initialized = true;
                    return this;
                })
                .catch(this.handleError);
        }
        return Promise.resolve(this);
    }

    /**
     * Prepares the select statement and stores it on the instance.
     * @returns {Promise<FhirStream>} Resolves with the instance
     */
    prepare()
    {
        let { sql, params } = this.builder.compile();
        this.params = params;
        return new Promise((resolve, reject) => {
            this.statement = DB.prepare(sql, params, prepareError => {
                if (prepareError) {
                    return reject(prepareError);
                }
                resolve(this);
            });
        });
    }

    /**
     * Counts the total number of rows and sets the following properties on the
     * instance:
     *      total      - the total rows
     *      page       - the page number we are currently in
     *      totalPages - the total number of pages available
     * @returns {Promise<FhirStream>} Resolves with the instance
     */
    countRecords()
    {
        // SELECT "fhir_type", COUNT(*) as "totalRows" FROM "data"
        // WHERE "fhir_type" IN("Patient") GROUP BY "fhir_type"
        let { sql, params } = this.builder.compileCount("totalRows");
        return DB.promise("get", sql, params).then(row => {
            this.total = row && row.totalRows ? row.totalRows || 0 : 0;
            this.page = Math.floor(this.offset / this.limit) + 1;
            this.totalPages = Math.ceil((this.total * this.multiplier) / this.limit);
            return this;
        });
    }

    /**
     * Executes the SQL statement to fetch the next set of rows and load them
     * into the memory cache
     */
    fetch()
    {
        return new Promise((resolve, reject) => {
            this.params.$_limit = Math.min(config.rowsPerChunk, this.limit);
            this.statement.all(this.params, (err, rows) => {
                if (err) {
                    return reject(err);
                }
                this.cache = rows || [];
                this.params.$_offset += this.cache.length;
                resolve(this);
            });
        });
    }

    getNextRow()
    {
        // If we have read enough rows already - exit
        if (this.rowIndex >= this.limit) {
            return this.push(null);
        }

        let row = this.cache.length ? this.cache.shift() : null;

        // If there is no row returned - check why
        if (!row) {
            
            // If this.multiplier is greater than 1, then we might have to
            // rewind and continue (using prefixed IDs in the data)
            if (this.rowIndex < (this.total * this.multiplier - this.offset) && this.page <= this.totalPages) {
                this.overflow++;
                this.params.$_offset = 0;
                return this.fetch().then(this.getNextRow);
            }

            // Otherwise just exit
            return this.push(null);
        }

        // Compute the page on which the current row happens to be. If this is
        // greater than 1, IDs will be prefixed.
        this.page = Math.floor((this.offset + this.rowIndex) / this.limit) + 1;


        let json = row.resource_json;

        // Compute an ID prefix to make sure all records are unique
        let prefix = [], l = 0;
        if (this.page > 1) {
            l = prefix.push(`p${this.page}`);
        }
        if (this.overflow) {
            l = prefix.push(`o${this.overflow}`);
        }
        if (l) {
            prefix = prefix.join("-");
            json = json.replace(RE_UID, `${prefix}-` + '$1');
        }

        // For tests also include the modified_date
        if (this.extended) {
            json = JSON.parse(json);
            json.__modified_date = row.modified_date
            json = JSON.stringify(json);
        }
        
        // place "\n" between rows but not after the last one
        this.push((this.rowIndex ? "\n" : "") + json);

        this.rowIndex += 1;
    }
}

module.exports = FhirStream;
