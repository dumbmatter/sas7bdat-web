const csvStringify = require('csv-stringify');
const denodeify = require('denodeify');
const path = require('path');
const stream = require('stream');

const open_file = () => {
    throw new Error('open_file not implemented');
};

const read_file = (sas7bdat, offset, length) => {
    const slice = sas7bdat._file.slice(offset + sas7bdat.file_pos, length + sas7bdat.file_pos);
    const buffer = Buffer.from(slice);

    const bytesRead = Math.min(slice.byteLength, buffer.length);

    sas7bdat.file_pos += slice.byteLength;

    return {buffer, bytesRead};
};

const close_file = sas7bdat => {
    sas7bdat._file = null;
};

const seek_file = () => {
    throw new Error('seek not implemented');
}

class NotImplementedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotImplementedError';
    }
}

const epoch = new Date('1960-01-01').getTime();
const datetime = (offset_from_epoch, units, date_formatter = null, output_format = 'datetime') => {
    date_formatter = date_formatter !== null ? date_formatter : (d, output_format) => {
        if (output_format === 'date') {
            return d.toISOString().slice(0, 10);
        }
        if (output_format === 'time') {
            return d.toISOString().slice(11, 23);
        }
        return d.toISOString();
    };

    // Convert days to seconds
    if (units === 'days') {
        offset_from_epoch *= 24 * 60 * 60;
    }

    const d = new Date(epoch + offset_from_epoch * 1000);

    return date_formatter(d, output_format);
};

const struct_unpack = (fmt, raw_bytes) => {
    const endian = fmt[0] === '<' ? 'little' : 'big';
    const letter = fmt[fmt.length - 1];

    if (letter === 's') {
        if (endian === 'big') {
            // If big endian, reverse bytes manually maybe
            throw new Error('Big endian not supported');
        }
        return raw_bytes.toString();
    } else if (letter === 'd') {
        if (endian === 'big') {
            return raw_bytes.readDoubleBE(0);
        }
        return raw_bytes.readDoubleLE(0);
    } else if (letter === 'i') {
        if (endian === 'big') {
            return raw_bytes.readInt32BE(0);
        }
        return raw_bytes.readInt32LE(0);
    } else if (letter === 'b') {
        // Only ever called for 1 char, so this should be fine (and for both directions)
        return raw_bytes.readIntBE(0, 1);
    } else if (letter === 'q') {
        // Not a real conversion, just 48 bits - would be better to check that the remaining 2 bytes are 0
        if (endian === 'big') {
            return raw_bytes.readIntBE(0, 6);
        }
        return raw_bytes.readIntLE(0, 6);
    } else if (letter === 'h') {
        if (endian === 'big') {
            return raw_bytes.readInt16BE(0);
        }
        return raw_bytes.readInt16LE(0);
    }
};

const decode = (buf, encoding) => {
    return buf.toString(encoding);
};

class Decompressor {
    constructor(parent) {
        this.parent = parent;
    }

    decompress_row() {
        throw new NotImplementedError();
    }

    static to_ord(int_or_str) {
        if (typeof int_or_str === 'number') {
            return int_or_str;
        }
        return int_or_str.charCodeAt(0);
    }

    static to_chr(int_or_str) {
        if (typeof int_or_str === 'string') {
            return int_or_str;
        }
        if (int_or_str instanceof Buffer) {
            // Not sure why int_or_str.toString('ascii'); fails, but sometimes it does
            let str = '';
            for (let i = 0; i < int_or_str.length; i++) {
                str += String.fromCharCode(int_or_str[i]);
            }
            return str;
        }
        return String.fromCharCode(int_or_str);
    }
}


// Decompresses data using the Run Length Encoding algorithm
class RLEDecompressor extends Decompressor {
    decompress_row(offset, length, result_length, page) {
        const b = Decompressor.to_ord;
        const c = Decompressor.to_chr;
        let current_result_array_index = 0;
        let result = [];
        let i = 0;
        for (let j = 0; j < length; j++) {
            if (i !== j) {
                continue;
            }
            const control_byte = b(page[offset + i]) & 0xF0;
            const end_of_first_byte = b(page[offset + i]) & 0x0F;
            if (control_byte === 0x00) {
                if (i !== (length - 1)) {
                    const count_of_bytes_to_copy = (
                        (b(page[offset + i + 1]) & 0xFF) +
                        64 +
                        end_of_first_byte * 256
                    );
                    const start = offset + i + 2;
                    const end = start + count_of_bytes_to_copy;
                    result.push(c(page.slice(start, end)));
                    i += count_of_bytes_to_copy + 1;
                    current_result_array_index += count_of_bytes_to_copy;
                }
            } else if (control_byte === 0x40) {
                const copy_counter = (
                    end_of_first_byte * 16 +
                    (b(page[offset + i + 1]) & 0xFF)
                );
                for (let _ = 0; _ < copy_counter + 18; _++) {
                    result.push(c(page[offset + i + 2]));
                    current_result_array_index += 1;
                }
                i += 2;
            } else if (control_byte === 0x60) {
                for (let _ = 0; _ < end_of_first_byte * 256 + (b(page[offset + i + 1]) & 0xFF) + 17; _++) {
                    result.push(c(0x20));
                    current_result_array_index += 1;
                }
                i += 1;
            } else if (control_byte === 0x70) {
                for (let _ = 0; _ < end_of_first_byte * 256 + (b(page[offset + i + 1]) & 0xFF) + 17; _++) {
                    result.push(c(0x00));
                    current_result_array_index += 1;
                }
                i += 1;
            } else if (control_byte === 0x80) {
                const count_of_bytes_to_copy = Math.min(end_of_first_byte + 1, length - (i + 1));
                const start = offset + i + 1;
                const end = start + count_of_bytes_to_copy;
                result.push(c(page.slice(start, end)));
                i += count_of_bytes_to_copy;
                current_result_array_index += count_of_bytes_to_copy;
            } else if (control_byte === 0x90) {
                const count_of_bytes_to_copy = Math.min(end_of_first_byte + 17, length - (i + 1));
                const start = offset + i + 1;
                const end = start + count_of_bytes_to_copy;
                result.push(c(page.slice(start, end)));
                i += count_of_bytes_to_copy;
                current_result_array_index += count_of_bytes_to_copy;
            } else if (control_byte === 0xA0) {
                const count_of_bytes_to_copy = Math.min(end_of_first_byte + 33, length - (i + 1));
                const start = offset + i + 1;
                const end = start + count_of_bytes_to_copy;
                result.push(c(page.slice(start, end)));
                i += count_of_bytes_to_copy;
                current_result_array_index += count_of_bytes_to_copy;
            } else if (control_byte === 0xB0) {
                const count_of_bytes_to_copy = Math.min(end_of_first_byte + 49, length - (i + 1));
                const start = offset + i + 1;
                const end = start + count_of_bytes_to_copy;
                result.push(c(page.slice(start, end)));
                i += count_of_bytes_to_copy;
                current_result_array_index += count_of_bytes_to_copy;
            } else if (control_byte === 0xC0) {
                for (let _ = 0; _ < end_of_first_byte + 3; _++) {
                    result.push(c(page[offset + i + 1]));
                    current_result_array_index += 1;
                }
                i += 1;
            } else if (control_byte === 0xD0) {
                for (let _ = 0; _ < end_of_first_byte + 2; _++) {
                    result.push(c(0x40));
                    current_result_array_index += 1;
                }
            } else if (control_byte === 0xE0) {
                for (let _ = 0; _ < end_of_first_byte + 2; _++) {
                    result.push(c(0x20));
                    current_result_array_index += 1;
                }
            } else if (control_byte === 0xF0) {
                for (let _ = 0; _ < end_of_first_byte + 2; _++) {
                    result.push(c(0x00));
                    current_result_array_index += 1;
                }
            } else {
                throw new Error(`unknown control byte: ${control_byte}`);
            }
            i += 1;
        }

        result = Buffer.from(result.join(''), 'ascii');
        if (result.length !== result_length) {
            throw new Error(`unexpected result length: ${result.length} !== ${result_length}`);
        }

        return result;
    }
}


// Decompresses data using the Ross Data Compression algorithm
class RDCDecompressor extends Decompressor {
    constructor() {
        super();
        throw new NotImplementedError();
    }

/*    bytes_to_bits(src, offset, length) {
        const result = [];
        for (let i = 0; i < length * 8; i++) {
            result.push(0);
        }
        for (let i = 0; i < length; i++) {
            b = src[offset + i]
            for (let bit = 0; i < 8; i++) {
                result[8 * i + (7 - bit)] = (b & (1 << bit)) === 0 ? 0 : 1;
            }
        }
        return result;
    }

    ensure_capacity(src, capacity) {
        if (capacity >= src.length) {
            new_len = max(capacity, 2 * src.length);
            src.extend([0] * (new_len - src.length));
        }
        return src;
    }

    is_short_rle(first_byte_of_cb) {
        return [0x00, 0x01, 0x02, 0x03, 0x04, 0x05].includes(first_byte_of_cb);
    }

    is_single_byte_marker(first_byte_of_cb) {
        return [0x02, 0x04, 0x06, 0x08, 0x0A].includes(first_byte_of_cb);
    }

    is_two_bytes_marker(double_bytes_cb) {
        return double_bytes_cb.length === 2 && ((double_bytes_cb[0] >> 4) & 0xF) > 2;
    }

    is_three_bytes_marker(three_byte_marker) {
        const flag = three_byte_marker[0] >> 4;
        return three_byte_marker.length === 3 && [1, 2].includes(flag & 0xF);
    }

    get_length_of_rle_pattern(first_byte_of_cb) {
        if (first_byte_of_cb <= 0x05) {
            return first_byte_of_cb + 3;
        }
        return 0;
    }

    get_length_of_one_byte_pattern(first_byte_of_cb) {
        return this.is_single_byte_marker(first_byte_of_cb) ? first_byte_of_cb + 14 : 0;
    }

    get_length_of_two_bytes_pattern(double_bytes_cb) {
        return (double_bytes_cb[0] >> 4) & 0xF;
    }

    get_length_of_three_bytes_pattern(p_type, three_byte_marker) {
        if (p_type === 1) {
            return 19 + (three_byte_marker[0] & 0xF) + (three_byte_marker[1] * 16);
        } else if (p_type === 2) {
            return three_byte_marker[2] + 16;
        }
        return 0;
    }

    get_offset_for_one_byte_pattern(first_byte_of_cb) {
        if (first_byte_of_cb === 0x08) {
            return 24;
        } else if (first_byte_of_cb === 0x0A) {
            return 40;
        }
        return 0;
    }

    get_offset_for_two_bytes_pattern(double_bytes_cb) {
        return 3 + (double_bytes_cb[0] & 0xF) + (double_bytes_cb[1] * 16);
    }

    get_offset_for_three_bytes_pattern(triple_bytes_cb) {
        return 3 + (triple_bytes_cb[0] & 0xF) + (triple_bytes_cb[1] * 16);
    }

    clone_byte(b, length) {
        return [b] * length;
    }

    decompress_row(offset, length, result_length, page) {
        const b = Decompressor.to_ord
        const c = Decompressor.to_chr
        const src_row = page.slice(offset, offset + length).map(b);
        let out_row = [];
        for (let i = 0; i < result_length; i++) {
            out_row.push(0);
        }
        let src_offset = 0;
        let out_offset = 0;
        while (src_offset < (src_row.length - 2)) {
            prefix_bits = this.bytes_to_bits(src_row, src_offset, 2);
            src_offset += 2;
            for (let bit_index = 0; bit_index < 16; bit_index++) {
                if (src_offset >= src_row.length) {
                    break;
                }
                if (prefix_bits[bit_index] === 0) {
                    out_row = this.ensure_capacity(out_row, out_offset);
                    out_row[out_offset] = src_row[src_offset];
                    src_offset += 1;
                    out_offset += 1;
                    continue;
                }
                marker_byte = src_row[src_offset];
                const next_byte = src_row[src_offset + 1];
                if (next_byte === undefined) {
                    break;
                }
                if (this.is_short_rle(marker_byte)) {
                    const length = this.get_length_of_rle_pattern(marker_byte);
                    out_row = this.ensure_capacity(
                        out_row, out_offset + length
                    );
                    const pattern = this.clone_byte(next_byte, length);
throw new NotImplementedError();
                    out_row[out_offset:out_offset + length] = pattern;
                    out_offset += length;
                    src_offset += 2;
                    continue;
                } else if (this.is_single_byte_marker(marker_byte) && !((next_byte & 0xF0) === ((next_byte << 4) & 0xF0))) {
                    const length = this.get_length_of_one_byte_pattern(marker_byte);
                    out_row = this.ensure_capacity(
                        out_row, out_offset + length
                    );
                    back_offset = this.get_offset_for_one_byte_pattern(
                        marker_byte
                    );
                    const start = out_offset - back_offset;
                    const end = start + length;
throw new NotImplementedError();
                    out_row[out_offset:out_offset + length] =\
                        out_row.slice(start, end)
                    src_offset += 1;
                    out_offset += length;
                    continue;
                }
                const two_bytes_marker = src_row.slice(src_offset, src_offset + 2);
                if (this.is_two_bytes_marker(two_bytes_marker)) {
                    const length = this.get_length_of_two_bytes_pattern(
                        two_bytes_marker
                    );
                    out_row = this.ensure_capacity(
                        out_row, out_offset + length
                    );
                    const back_offset = this.get_offset_for_two_bytes_pattern(
                        two_bytes_marker
                    );
                    const start = out_offset - back_offset;
                    const end = start + length;
throw new NotImplementedError();
                    out_row[out_offset:out_offset + length] =\
                        out_row.slice(start, end)
                    src_offset += 2;
                    out_offset += length;
                    continue;
                }
                const three_bytes_marker = src_row.slice(src_offset, src_offset + 3);
                if (this.is_three_bytes_marker(three_bytes_marker)) {
                    const p_type = (three_bytes_marker[0] >> 4) & 0x0F;
                    let back_offset = 0;
                    if (p_type === 2) {
                        back_offset = this.get_offset_for_three_bytes_pattern(
                            three_bytes_marker
                        );
                    }
                    const length = this.get_length_of_three_bytes_pattern(
                        p_type, three_bytes_marker
                    );
                    out_row = this.ensure_capacity(
                        out_row, out_offset + length
                    );
                    if (p_type === 1) {
                        pattern = this.clone_byte(
                            three_bytes_marker[2], length
                        );
                    } else {
                        const start = out_offset - back_offset;
                        const end = start + length;
                        pattern = out_row.slice(start, end);
                    }
throw new NotImplementedError();
                    out_row[out_offset:out_offset + length] = pattern;
                    src_offset += 3;
                    out_offset += length;
                    continue;
                } else {
                    throw new Error(`unknown marker ${src_row[src_offset]} at offset ${src_offset}`);
                    break;
                }
            }
        }
        return Buffer.from(out_row.map(c).join(''));
    }*/
}

// file can be string file path (NodeJS) or ArrayBuffer (client-side)
class SAS7BDAT {
    constructor(file, {logLevel = 'warning', extraTimeFormatStrings = null, extraDatetimeFormatStrings = null, extraDateFormatStrings = null, skipHeader = false, encoding = 'utf8', alignCorrection = true, dateFormatter = null, rowFormat = 'array'} = {}) {
        this.RLE_COMPRESSION = 'SASYZCRL';
        SAS7BDAT.RLE_COMPRESSION = this.RLE_COMPRESSION;
        this.RDC_COMPRESSION = 'SASYZCR2';
        this.COMPRESSION_LITERALS = [this.RLE_COMPRESSION, this.RDC_COMPRESSION];
        SAS7BDAT.COMPRESSION_LITERALS = this.COMPRESSION_LITERALS;
        this.DECOMPRESSORS = {
            [this.RLE_COMPRESSION]: RLEDecompressor,
            [this.RDC_COMPRESSION]: RDCDecompressor
        };
        this.TIME_FORMAT_STRINGS = ['TIME'];
        this.DATE_TIME_FORMAT_STRINGS = ['DATETIME'];
        this.DATE_FORMAT_STRINGS = ['YYMMDD', 'MMDDYY', 'DDMMYY', 'DATE', 'JULIAN', 'MONYY', 'WEEKDATE'];

        this.path = typeof file === 'string' ? file : null;
        this.endianess = null;
        this.u64 = false;
        this.logger = this._make_logger(logLevel);
        this._update_format_strings(this.TIME_FORMAT_STRINGS, extraTimeFormatStrings);
        this._update_format_strings(this.DATE_TIME_FORMAT_STRINGS, extraDatetimeFormatStrings);
        this._update_format_strings(this.DATE_FORMAT_STRINGS, extraDateFormatStrings);
        this.skip_header = skipHeader;
        this.encoding = encoding;
        this.align_correction = alignCorrection;
        this.date_formatter = dateFormatter;
        this.row_format = rowFormat;
        this._file = typeof file === 'string' ? null : file;
        this.cached_page = null;
        this.current_page_type = null;
        this.current_page_block_count = null;
        this.current_page_subheaders_count = null;
        this.current_file_position = 0;
        this.current_page_data_subheader_pointers = [];
        this.current_row = [];
        this.column_names_strings = [];
        this.column_names = [];
        this.column_types = [];
        this.column_data_offsets = [];
        this.column_data_lengths = [];
        this.columns = [];
        this.header = null;
        this.properties = null;
        this.parsed_header = false;
        this.sent_header = false;
        this.current_row_in_file_index = 0;
        this.current_row_on_page_index = 0;
        this.file_pos = 0;
    }

    async parse_header() {
        this.logger.debug('Start parse_header');
        if (this._file === null) {
            this._file = await open_file(this.path, 'r');
        }
        this.header = new SASHeader(this);
        await this.header.parse();
        this.properties = this.header.properties;
        await this.header.parse_metadata();
        this.logger.debug(this.header);
    }

    _update_format_strings(arr, format_strings) {
        if (format_strings !== null) {
            if (typeof format_strings === 'string') {
                format_strings = [format_strings];
            }

            format_strings.forEach(format_string => {
                if (!arr.includes(format_string)) {
                    arr.push(format_string);
                }
            });
        }
    }

    async close() {
        await close_file(this);
    }

    _make_logger(level = 'info') {
        const levels = {
            debug: 0,
            info: 1,
            warning: 2,
            error: 3,
            critical: 4
        };

        const log = level2 => msg => {
            if (levels[level2] >= levels[level]) {
                console.log(`${new Date().toISOString()} [${level2}]`, msg);
            }
        };

        return {
            critical: log('critical'),
            debug: log('debug'),
            error: log('error'),
            info: log('info'),
            warning: log('warning')
        };
    }

    async _read_bytes(offsets_to_lengths) {
        const result = {};
        if (!this.cached_page) {
            for (let offset of Object.keys(offsets_to_lengths)) {
                const length = offsets_to_lengths[offset];
                offset = parseInt(offset, 10);
                let skipped = 0;
                while (skipped < (offset - this.current_file_position)) {
                    const seek = offset - this.current_file_position - skipped;
                    skipped += seek;
                    await seek_file(this, seek);
                }
                const {buffer: tmp} = await read_file(this, 0, length);
                if (tmp.length < length) {
                    throw new Error(`failed to read ${length} bytes from sas7bdat file`);
                }
                this.current_file_position = offset + length;
                result[offset] = tmp;
            }
        } else {
            for (let offset of Object.keys(offsets_to_lengths)) {
                const length = offsets_to_lengths[offset];
                offset = parseInt(offset, 10);
                result[offset] = this.cached_page.slice(offset, offset + length);
            }
        }
        return result;
    }

    /*
    See the full range of newfmt here, find correspondence in node library (including endianess) and implement here
        h - short -> integer (2)
        d - double -> float (8)
        [0-9]*s - char[] -> bytes
        i - integer -> integer (4)
        b - signed char -> integer
        q - unsigned long long -> integer (8)
        and with each endian, forward or backwards
    */
    _read_val(fmt, raw_bytes, size) {
        if (fmt === 'i' && this.u64 && size === 8) {
            fmt = 'q';
        }
        let newfmt = fmt;
        if (fmt === 's') {
            newfmt = `${Math.min(size, raw_bytes.length)}s`;
        } else if (['number', 'datetime', 'date', 'time'].includes(fmt)) {
            newfmt = 'd';
            if (raw_bytes.length !== size) {
                size = raw_bytes.length;
            }
            if (size < 8) {
                const bytes_new = [];
                for (let i = 0; i < (8 - size); i++) {
                    bytes_new.push(0x00);
                }
                if (this.endianess === 'little') {
                    raw_bytes = Buffer.concat([Buffer.from(bytes_new), raw_bytes]);
                } else {
                    raw_bytes = Buffer.concat([raw_bytes, Buffer.from(bytes_new)]);
                }
                size = 8;
            }
        }
        if (this.endianess === 'big') {
            newfmt = `>${newfmt}`;
        } else {
            newfmt = `<${newfmt}`;
        }
        let val = struct_unpack(newfmt, raw_bytes.slice(0, size));
        if (fmt === 's') {
            val = val.replace(/\0/g, '').trim();
        } else if (Number.isNaN(val)) {
            val = null;
        } else if (fmt === 'datetime') {
            val = datetime(val, 'seconds', this.date_formatter);
        } else if (fmt === 'time') {
            val = datetime(val, 'seconds', this.date_formatter, 'time');
        } else if (fmt === 'date') {
            try {
                val = datetime(val, 'days', this.date_formatter, 'date');
            } catch (err) {
                // Some data sets flagged with a date format are actually
                // stored as datetime values
                val = datetime(val, 'seconds', this.date_formatter);
            }
        }

        return val;
    }

    create_read_stream() {
        const that = this;
        return new stream.Readable({
            objectMode: true,
            async read() {
                try {
                    const row = await that.readline();
                    this.push(row);
                } catch (err) {
                    this.emit('error', err);
                }
            }
        });
    }

    async readline() {
        if (!this.parsed_header) {
            await this.parse_header();
            this.parsed_header = true;
        }
        const bit_offset = this.header.PAGE_BIT_OFFSET;
        const subheader_pointer_length = this.header.SUBHEADER_POINTER_LENGTH;
        const row_count = this.header.properties.row_count;
        if (!this.column_names_strings_decoded) {
            this.column_names_strings_decoded = this.columns.map(x => decode(x.name, this.encoding));
        }
        if (!this.skip_header && !this.sent_header && this.row_format === 'array') {
            this.sent_header = true;
            return this.column_names_strings_decoded;
        }
        if (!this.cached_page) {
            await seek_file(this, this.properties.header_length);
            await this._read_next_page();
        }
        if (this.current_row_in_file_index < row_count) {
            this.current_row_in_file_index += 1;
            const current_page_type = this.current_page_type;
            if (current_page_type === this.header.PAGE_META_TYPE) {
                if (this.current_row_on_page_index < this.current_page_data_subheader_pointers.length && this.current_row_on_page_index >= 0) {
                    const current_subheader_pointer = this.current_page_data_subheader_pointers[this.current_row_on_page_index];
                    this.current_row_on_page_index += 1;
                    const Cls = this.header.SUBHEADER_INDEX_TO_CLASS[this.header.DATA_SUBHEADER_INDEX];
                    if (Cls === undefined) {
                        throw new NotImplementedError();
                    }
                    const cls = new Cls(this);
                    await cls.process_subheader(
                        current_subheader_pointer.offset,
                        current_subheader_pointer.length
                    );
                    if (this.current_row_on_page_index === this.current_page_data_subheader_pointers.length) {
                        await this._read_next_page();
                        this.current_row_on_page_index = 0;
                    }
                } else {
                    await this._read_next_page();
                    this.current_row_on_page_index = 0;
                }
            } else if (this.header.PAGE_MIX_TYPE.includes(current_page_type)) {
                let align_correction;
                if (this.align_correction) {
                    align_correction = (
                        bit_offset + this.header.SUBHEADER_POINTERS_OFFSET +
                        this.current_page_subheaders_count *
                        subheader_pointer_length
                    ) % 8;
                } else {
                    align_correction = 0;
                }
                const offset = (
                    bit_offset + this.header.SUBHEADER_POINTERS_OFFSET +
                    align_correction + this.current_page_subheaders_count *
                    subheader_pointer_length + this.current_row_on_page_index *
                    this.properties.row_length
                );
                try {
                    this.current_row = this._process_byte_array_with_data(
                        offset,
                        this.properties.row_length
                    );
                } catch (err) {
                    console.log(`failed to process data (you might want to try passing alignCorrection=${!this.align_correction} to the SAS7BDAT constructor)`);
                    throw err;
                }
                this.current_row_on_page_index += 1;
                if (this.current_row_on_page_index === Math.min(this.properties.row_count, this.properties.mix_page_row_count)) {
                    await this._read_next_page();
                    this.current_row_on_page_index = 0;
                }
            } else if (current_page_type === this.header.PAGE_DATA_TYPE) {
                this.current_row = this._process_byte_array_with_data(
                    bit_offset + this.header.SUBHEADER_POINTERS_OFFSET +
                    this.current_row_on_page_index *
                    this.properties.row_length,
                    this.properties.row_length
                );
                this.current_row_on_page_index += 1;
                if (this.current_row_on_page_index === this.current_page_block_count) {
                    await this._read_next_page();
                    this.current_row_on_page_index = 0;
                }
            } else {
                throw new Error(`unknown page type: ${current_page_type}`);
            }

            if (this.row_format === 'object') {
                return this.current_row.reduce((obj, val, i) => {
                    obj[this.column_names_strings_decoded[i]] = val;
                    return obj;
                }, {});
            }
            return this.current_row;
        }
        await this.close();
        return null;
    }

    async _read_next_page() {
        this.current_page_data_subheader_pointers = [];
        const {buffer: cached_page, bytesRead} = await read_file(this, 0, this.properties.page_length);
        this.cached_page = cached_page;
        if (bytesRead <= 0) {
            return;
        }

        if (this.cached_page.length !== this.properties.page_length) {
            throw new Error(`failed to read complete page from file (read ${this.cached_page.length} of ${this.properties.page_length} bytes)`);
        }
        await this.header.read_page_header();
        if (this.current_page_type === this.header.PAGE_META_TYPE) {
            await this.header.process_page_metadata();
        }

        const types = this.header.PAGE_MIX_TYPE.concat(this.header.PAGE_META_TYPE, this.header.PAGE_DATA_TYPE);
        if (!types.includes(this.current_page_type)) {
            await this._read_next_page();
        }
    }

    _process_byte_array_with_data(offset, length) {
        const row_elements = [];
        let source;
        if (this.properties.compression && length < this.properties.row_length) {
            const Decompressor = this.DECOMPRESSORS[this.properties.compression];
            source = new Decompressor(this).decompress_row(
                offset, length, this.properties.row_length,
                this.cached_page
            );
            offset = 0;
        } else {
            source = this.cached_page;
        }
        for (let i = 0; i < this.properties.column_count; i++) {
            const length = this.column_data_lengths[i];
            if (length === 0) {
                break;
            }
            const start = offset + this.column_data_offsets[i];
            const end = offset + this.column_data_offsets[i] + length;
            const temp = source.slice(start, end);
            if (this.columns[i].type === 'number') {
                if (this.column_data_lengths[i] <= 2) {
                    row_elements.push(this._read_val(
                        'h', temp, length
                    ));
                } else {
                    const fmt = this.columns[i].format;
                    if (!fmt) {
                        row_elements.push(this._read_val(
                            'number', temp, length
                        ));
                    } else if (this.TIME_FORMAT_STRINGS.includes(fmt)) {
                        row_elements.push(this._read_val(
                            'time', temp, length
                        ));
                    } else if (this.DATE_TIME_FORMAT_STRINGS.includes(fmt)) {
                        row_elements.push(this._read_val(
                            'datetime', temp, length
                        ));
                    } else if (this.DATE_FORMAT_STRINGS.includes(fmt)) {
                        row_elements.push(this._read_val(
                            'date', temp, length
                        ));
                    } else {
                        row_elements.push(this._read_val(
                            'number', temp, length
                        ));
                    }
                }
            } else { // string
                row_elements.push(decode(this._read_val(
                    's', temp, length
                ), this.encoding));
            }
        }
        return row_elements;
    }
}

class Column {
    constructor(col_id, name, label, col_format, col_type, length) {
        this.col_id = col_id;
        this.name = name;
        this.label = label;
        this.format = col_format.toString('utf8');
        this.type = col_type;
        this.length = length;
    }
}


class SubheaderPointer {
    constructor(offset = null, length = null, compression = null, p_type = null) {
        this.offset = offset;
        this.length = length;
        this.compression = compression;
        this.type = p_type;
    }
}


class ProcessingSubheader {
    constructor(parent) {
        this.TEXT_BLOCK_SIZE_LENGTH = 2;
        this.ROW_LENGTH_OFFSET_MULTIPLIER = 5;
        this.ROW_COUNT_OFFSET_MULTIPLIER = 6;
        this.COL_COUNT_P1_MULTIPLIER = 9;
        this.COL_COUNT_P2_MULTIPLIER = 10;
        this.ROW_COUNT_ON_MIX_PAGE_OFFSET_MULTIPLIER = 15; // rowcountfp
        this.COLUMN_NAME_POINTER_LENGTH = 8;
        this.COLUMN_NAME_TEXT_SUBHEADER_OFFSET = 0;
        this.COLUMN_NAME_TEXT_SUBHEADER_LENGTH = 2;
        this.COLUMN_NAME_OFFSET_OFFSET = 2;
        this.COLUMN_NAME_OFFSET_LENGTH = 2;
        this.COLUMN_NAME_LENGTH_OFFSET = 4;
        this.COLUMN_NAME_LENGTH_LENGTH = 2;
        this.COLUMN_DATA_OFFSET_OFFSET = 8;
        this.COLUMN_DATA_LENGTH_OFFSET = 8;
        this.COLUMN_DATA_LENGTH_LENGTH = 4;
        this.COLUMN_TYPE_OFFSET = 14;
        this.COLUMN_TYPE_LENGTH = 1;
        this.COLUMN_FORMAT_TEXT_SUBHEADER_INDEX_OFFSET = 22;
        this.COLUMN_FORMAT_TEXT_SUBHEADER_INDEX_LENGTH = 2;
        this.COLUMN_FORMAT_OFFSET_OFFSET = 24;
        this.COLUMN_FORMAT_OFFSET_LENGTH = 2;
        this.COLUMN_FORMAT_LENGTH_OFFSET = 26;
        this.COLUMN_FORMAT_LENGTH_LENGTH = 2;
        this.COLUMN_LABEL_TEXT_SUBHEADER_INDEX_OFFSET = 28;
        this.COLUMN_LABEL_TEXT_SUBHEADER_INDEX_LENGTH = 2;
        this.COLUMN_LABEL_OFFSET_OFFSET = 30;
        this.COLUMN_LABEL_OFFSET_LENGTH = 2;
        this.COLUMN_LABEL_LENGTH_OFFSET = 32;
        this.COLUMN_LABEL_LENGTH_LENGTH = 2;

        this.parent = parent;
        this.logger = parent.logger;
        this.properties = parent.header.properties;
        this.int_length = this.properties.u64 ? 8 : 4;
    }

    async process_subheader() {
        throw new NotImplementedError();
    }
}


class RowSizeSubheader extends ProcessingSubheader {
    async process_subheader(offset) {
        const int_len = this.int_length;
        const lcs = offset + (this.properties.u64 ? 682 : 354);
        const lcp = offset + (this.properties.u64 ? 706 : 378);
        const vals = await this.parent._read_bytes({
            [offset + this.ROW_LENGTH_OFFSET_MULTIPLIER * int_len]: int_len,
            [offset + this.ROW_COUNT_OFFSET_MULTIPLIER * int_len]: int_len,
            [offset + this.ROW_COUNT_ON_MIX_PAGE_OFFSET_MULTIPLIER * int_len]:
                            int_len,
            [offset + this.COL_COUNT_P1_MULTIPLIER * int_len]: int_len,
            [offset + this.COL_COUNT_P2_MULTIPLIER * int_len]: int_len,
            [lcs]: 2,
            [lcp]: 2
        });
        if (this.properties.row_length !== null) {
            throw new Error('found more than one row length subheader');
        }
        if (this.properties.row_count !== null) {
            throw new Error('found more than one row count subheader');
        }
        if (this.properties.col_count_p1 !== null) {
            throw new Error('found more than one col count p1 subheader');
        }
        if (this.properties.col_count_p2 !== null) {
            throw new Error('found more than one col count p2 subheader');
        }
        if (this.properties.mix_page_row_count !== null) {
            throw new Error('found more than one mix page row count subheader');
        }
        this.properties.row_length = this.parent._read_val(
            'i',
            vals[offset + this.ROW_LENGTH_OFFSET_MULTIPLIER * int_len],
            int_len
        );
        this.properties.row_count = this.parent._read_val(
            'i',
            vals[offset + this.ROW_COUNT_OFFSET_MULTIPLIER * int_len],
            int_len
        );
        this.properties.col_count_p1 = this.parent._read_val(
            'i',
            vals[offset + this.COL_COUNT_P1_MULTIPLIER * int_len],
            int_len
        );
        this.properties.col_count_p2 = this.parent._read_val(
            'i',
            vals[offset + this.COL_COUNT_P2_MULTIPLIER * int_len],
            int_len
        );
        this.properties.mix_page_row_count = this.parent._read_val(
            'i',
            vals[offset + this.ROW_COUNT_ON_MIX_PAGE_OFFSET_MULTIPLIER *
                 int_len],
            int_len
        );
        this.properties.lcs = this.parent._read_val('h', vals[lcs], 2);
        this.properties.lcp = this.parent._read_val('h', vals[lcp], 2);
    }
}

class ColumnSizeSubheader extends ProcessingSubheader {
    async process_subheader(offset) {
        offset += this.int_length;
        const vals = await this.parent._read_bytes({
            [offset]: this.int_length
        });
        if (this.properties.column_count !== null) {
            throw new Error('found more than one column count subheader');
        }
        this.properties.column_count = this.parent._read_val(
            'i', vals[offset], this.int_length
        );
        if (this.properties.col_count_p1 + this.properties.col_count_p2 !== this.properties.column_count) {
            this.logger.warning('column count mismatch');
        }
    }
}


class SubheaderCountsSubheader extends ProcessingSubheader {
    async process_subheader() {
        return; // Not sure what to do here yet
    }
}


class ColumnTextSubheader extends ProcessingSubheader {
    async process_subheader(offset) {
        offset += this.int_length;
        let vals = await this.parent._read_bytes({
            [offset]: this.TEXT_BLOCK_SIZE_LENGTH
        });
        const text_block_size = this.parent._read_val(
            'h', vals[offset], this.TEXT_BLOCK_SIZE_LENGTH
        );

        vals = await this.parent._read_bytes({
            [offset]: text_block_size
        });
        this.parent.column_names_strings.push(vals[offset]);
        if (this.parent.column_names_strings.length === 1) {
            const column_name = this.parent.column_names_strings[0];
            let compression_literal = null;
            for (const cl of SAS7BDAT.COMPRESSION_LITERALS) {
                if (column_name.indexOf(cl) >= 0) {
                    compression_literal = cl;
                    break;
                }
            }
            this.properties.compression = compression_literal;
            offset -= this.int_length;
            vals = await this.parent._read_bytes({
                [offset + (this.properties.u64 ? 20 : 16)]: 8
            });
            compression_literal = this.parent._read_val(
                's',
                vals[offset + (this.properties.u64 ? 20 : 16)],
                8
            ).trim();
            if (compression_literal === '') {
                this.properties.lcs = 0;
                vals = await this.parent._read_bytes({
                    [offset + 16 + (this.properties.u64 ? 20 : 16)]: this.properties.lcp
                });
                const creatorproc = this.parent._read_val(
                    's',
                    vals[offset + 16 + (this.properties.u64 ? 20 : 16)],
                    this.properties.lcp
                );
                this.properties.creator_proc = creatorproc;
            } else if (compression_literal === SAS7BDAT.RLE_COMPRESSION) {
                vals = await this.parent._read_bytes({
                    [offset + 24 + (this.properties.u64 ? 20 : 16)]: this.properties.lcp
                });
                const creatorproc = this.parent._read_val(
                    's',
                    vals[offset + 24 + (this.properties.u64 ? 20 : 16)],
                    this.properties.lcp
                );
                this.properties.creator_proc = creatorproc;
            } else if (this.properties.lcs > 0) {
                this.properties.lcp = 0;
                vals = await this.parent._read_bytes({
                    [offset + (this.properties.u64 ? 20 : 16)]: this.properties.lcs
                });
                const creator = this.parent._read_val(
                    's',
                    vals[offset + (this.properties.u64 ? 20 : 16)],
                    this.properties.lcs
                );
                this.properties.creator = creator;
            }
        }
    }
}

class ColumnNameSubheader extends ProcessingSubheader {
    async process_subheader(offset, length) {
        offset += this.int_length;
        const column_name_pointers_count = Math.floor((length - 2 * this.int_length - 12) / 8);
        for (let i = 0; i < column_name_pointers_count; i++) {
            const text_subheader = (
                offset + this.COLUMN_NAME_POINTER_LENGTH * (i + 1) +
                this.COLUMN_NAME_TEXT_SUBHEADER_OFFSET
            );
            const col_name_offset = (
                offset + this.COLUMN_NAME_POINTER_LENGTH * (i + 1) +
                this.COLUMN_NAME_OFFSET_OFFSET
            );
            const col_name_length = (
                offset + this.COLUMN_NAME_POINTER_LENGTH * (i + 1) +
                this.COLUMN_NAME_LENGTH_OFFSET
            );
            const vals = await this.parent._read_bytes({
                [text_subheader]: this.COLUMN_NAME_TEXT_SUBHEADER_LENGTH,
                [col_name_offset]: this.COLUMN_NAME_OFFSET_LENGTH,
                [col_name_length]: this.COLUMN_NAME_LENGTH_LENGTH
            });

            const idx = this.parent._read_val(
                'h', vals[text_subheader],
                this.COLUMN_NAME_TEXT_SUBHEADER_LENGTH
            );
            const col_offset = this.parent._read_val(
                'h', vals[col_name_offset],
                this.COLUMN_NAME_OFFSET_LENGTH
            );
            const col_len = this.parent._read_val(
                'h', vals[col_name_length],
                this.COLUMN_NAME_LENGTH_LENGTH
            );
            const name_str = this.parent.column_names_strings[idx];
            this.parent.column_names.push(
                name_str.slice(col_offset, col_offset + col_len)
            );
        }
    }
}


class ColumnAttributesSubheader extends ProcessingSubheader {
    async process_subheader(offset, length) {
        const int_len = this.int_length;
        const column_attributes_vectors_count = (
            Math.floor((length - 2 * int_len - 12) / (int_len + 8))
        );
        for (let i = 0; i < column_attributes_vectors_count; i++) {
            const col_data_offset = (
                offset + int_len + this.COLUMN_DATA_OFFSET_OFFSET + i *
                (int_len + 8)
            );
            const col_data_len = (
                offset + 2 * int_len + this.COLUMN_DATA_LENGTH_OFFSET + i *
                (int_len + 8)
            );
            const col_types = (
                offset + 2 * int_len + this.COLUMN_TYPE_OFFSET + i *
                (int_len + 8)
            );
            const vals = await this.parent._read_bytes({
                [col_data_offset]: int_len,
                [col_data_len]: this.COLUMN_DATA_LENGTH_LENGTH,
                [col_types]: this.COLUMN_TYPE_LENGTH
            });
            this.parent.column_data_offsets.push(this.parent._read_val(
                'i', vals[col_data_offset], int_len
            ));
            this.parent.column_data_lengths.push(this.parent._read_val(
                'i', vals[col_data_len], this.COLUMN_DATA_LENGTH_LENGTH
            ));
            const ctype = this.parent._read_val(
                'b', vals[col_types], this.COLUMN_TYPE_LENGTH
            );
            this.parent.column_types.push(
                ctype === 1 ? 'number' : 'string'
            );
        }
    }
}

class FormatAndLabelSubheader extends ProcessingSubheader {
    async process_subheader(offset) {
        const int_len = this.int_length;
        const text_subheader_format = (
            offset + this.COLUMN_FORMAT_TEXT_SUBHEADER_INDEX_OFFSET + 3 *
            int_len
        );
        const col_format_offset = (
            offset + this.COLUMN_FORMAT_OFFSET_OFFSET + 3 * int_len
        );
        const col_format_len = (
            offset + this.COLUMN_FORMAT_LENGTH_OFFSET + 3 * int_len
        );
        const text_subheader_label = (
            offset + this.COLUMN_LABEL_TEXT_SUBHEADER_INDEX_OFFSET + 3 *
            int_len
        );
        const col_label_offset = (
            offset + this.COLUMN_LABEL_OFFSET_OFFSET + 3 * int_len
        );
        const col_label_len = (
            offset + this.COLUMN_LABEL_LENGTH_OFFSET + 3 * int_len
        );
        const vals = await this.parent._read_bytes({
            [text_subheader_format]: this.COLUMN_FORMAT_TEXT_SUBHEADER_INDEX_LENGTH,
            [col_format_offset]: this.COLUMN_FORMAT_OFFSET_LENGTH,
            [col_format_len]: this.COLUMN_FORMAT_LENGTH_LENGTH,
            [text_subheader_label]: this.COLUMN_LABEL_TEXT_SUBHEADER_INDEX_LENGTH,
            [col_label_offset]: this.COLUMN_LABEL_OFFSET_LENGTH,
            [col_label_len]: this.COLUMN_LABEL_LENGTH_LENGTH
        });

        // min used to prevent incorrect data which appear in some files
        const format_idx = Math.min(
            this.parent._read_val(
                'h', vals[text_subheader_format],
                this.COLUMN_FORMAT_TEXT_SUBHEADER_INDEX_LENGTH
            ),
            this.parent.column_names_strings.length - 1
        );
        const format_start = this.parent._read_val(
            'h', vals[col_format_offset],
            this.COLUMN_FORMAT_OFFSET_LENGTH
        );
        const format_len = this.parent._read_val(
            'h', vals[col_format_len],
            this.COLUMN_FORMAT_LENGTH_LENGTH
        );
        // min used to prevent incorrect data which appear in some files
        const label_idx = Math.min(
            this.parent._read_val(
                'h', vals[text_subheader_label],
                this.COLUMN_LABEL_TEXT_SUBHEADER_INDEX_LENGTH
            ),
            this.parent.column_names_strings.length - 1
        );
        const label_start = this.parent._read_val(
            'h', vals[col_label_offset],
            this.COLUMN_LABEL_OFFSET_LENGTH
        );
        const label_len = this.parent._read_val(
            'h', vals[col_label_len],
            this.COLUMN_LABEL_LENGTH_LENGTH
        );

        const label_names = this.parent.column_names_strings[label_idx];
        const column_label = label_names.slice(label_start, label_start + label_len);
        const format_names = this.parent.column_names_strings[format_idx];
        const column_format = format_names.slice(format_start, format_start + format_len);
        const current_column_number = this.parent.columns.length;
        this.parent.columns.push(
            new Column(current_column_number,
                   this.parent.column_names[current_column_number],
                   column_label,
                   column_format,
                   this.parent.column_types[current_column_number],
                   this.parent.column_data_lengths[current_column_number])
        );
    }
}

class ColumnListSubheader extends ProcessingSubheader {
    async process_subheader() {
        return; // Not sure what to do with this yet
    }
}

class DataSubheader extends ProcessingSubheader {
    async process_subheader(offset, length) {
        this.parent.current_row = this.parent._process_byte_array_with_data(
            offset, length
        );
    }
}

class SASProperties {
    constructor() {
        this.u64 = false;
        this.endianess = null;
        this.platform = null;
        this.name = null;
        this.file_type = null;
        this.date_created = null;
        this.date_modified = null;
        this.header_length = null;
        this.page_length = null;
        this.page_count = null;
        this.sas_release = null;
        this.server_type = null;
        this.os_type = null;
        this.os_name = null;
        this.compression = null;
        this.row_length = null;
        this.row_count = null;
        this.col_count_p1 = null;
        this.col_count_p2 = null;
        this.mix_page_row_count = null;
        this.lcs = null;
        this.lcp = null;
        this.creator = null;
        this.creator_proc = null;
        this.column_count = null;
        this.filename = null;
    }
}


class SASHeader {
    constructor(parent) {
        this.MAGIC = Buffer.from([0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0xc2, 0xea, 0x81, 0x60, 0xb3, 0x14, 0x11, 0xcf, 0xbd, 0x92, 0x8, 0x0, 0x9, 0xc7, 0x31, 0x8c, 0x18, 0x1f, 0x10, 0x11]);
        this.ROW_SIZE_SUBHEADER_INDEX = 'row_size';
        this.COLUMN_SIZE_SUBHEADER_INDEX = 'column_size';
        this.SUBHEADER_COUNTS_SUBHEADER_INDEX = 'subheader_counts';
        this.COLUMN_TEXT_SUBHEADER_INDEX = 'column_text';
        this.COLUMN_NAME_SUBHEADER_INDEX = 'column_name';
        this.COLUMN_ATTRIBUTES_SUBHEADER_INDEX = 'column_attributes';
        this.FORMAT_AND_LABEL_SUBHEADER_INDEX = 'format_and_label';
        this.COLUMN_LIST_SUBHEADER_INDEX = 'column_list';
        this.DATA_SUBHEADER_INDEX = 'data';
        // Subheader signatures, 32 and 64 bit, little and big endian
        this.SUBHEADER_SIGNATURE_TO_INDEX = {
            'f7f7f7f7': this.ROW_SIZE_SUBHEADER_INDEX,
            '00000000f7f7f7f7': this.ROW_SIZE_SUBHEADER_INDEX,
            'f7f7f7f700000000': this.ROW_SIZE_SUBHEADER_INDEX,
            'f6f6f6f6': this.COLUMN_SIZE_SUBHEADER_INDEX,
            '00000000f6f6f6f6': this.COLUMN_SIZE_SUBHEADER_INDEX,
            'f6f6f6f600000000': this.COLUMN_SIZE_SUBHEADER_INDEX,
            '00fcffff': this.SUBHEADER_COUNTS_SUBHEADER_INDEX,
            'fffffc00': this.SUBHEADER_COUNTS_SUBHEADER_INDEX,
            '00fcffffffffffff': this.SUBHEADER_COUNTS_SUBHEADER_INDEX,
            'fffffffffffffc00': this.SUBHEADER_COUNTS_SUBHEADER_INDEX,
            'fdffffff': this.COLUMN_TEXT_SUBHEADER_INDEX,
            'fffffffd': this.COLUMN_TEXT_SUBHEADER_INDEX,
            'fdffffffffffffff': this.COLUMN_TEXT_SUBHEADER_INDEX,
            'fffffffffffffffd': this.COLUMN_TEXT_SUBHEADER_INDEX,
            'ffffffff': this.COLUMN_NAME_SUBHEADER_INDEX,
            'ffffffffffffffff': this.COLUMN_NAME_SUBHEADER_INDEX,
            'fcffffff': this.COLUMN_ATTRIBUTES_SUBHEADER_INDEX,
            'fffffffc': this.COLUMN_ATTRIBUTES_SUBHEADER_INDEX,
            'fcffffffffffffff': this.COLUMN_ATTRIBUTES_SUBHEADER_INDEX,
            'fffffffffffffffc': this.COLUMN_ATTRIBUTES_SUBHEADER_INDEX,
            'fefbffff': this.FORMAT_AND_LABEL_SUBHEADER_INDEX,
            'fffffbfe': this.FORMAT_AND_LABEL_SUBHEADER_INDEX,
            'fefbffffffffffff': this.FORMAT_AND_LABEL_SUBHEADER_INDEX,
            'fffffffffffffbfe': this.FORMAT_AND_LABEL_SUBHEADER_INDEX,
            'feffffff': this.COLUMN_LIST_SUBHEADER_INDEX,
            'fffffffe': this.COLUMN_LIST_SUBHEADER_INDEX,
            'feffffffffffffff': this.COLUMN_LIST_SUBHEADER_INDEX,
            'fffffffffffffffe': this.COLUMN_LIST_SUBHEADER_INDEX
        };
        this.SUBHEADER_INDEX_TO_CLASS = {
            [this.ROW_SIZE_SUBHEADER_INDEX]: RowSizeSubheader,
            [this.COLUMN_SIZE_SUBHEADER_INDEX]: ColumnSizeSubheader,
            [this.SUBHEADER_COUNTS_SUBHEADER_INDEX]: SubheaderCountsSubheader,
            [this.COLUMN_TEXT_SUBHEADER_INDEX]: ColumnTextSubheader,
            [this.COLUMN_NAME_SUBHEADER_INDEX]: ColumnNameSubheader,
            [this.COLUMN_ATTRIBUTES_SUBHEADER_INDEX]: ColumnAttributesSubheader,
            [this.FORMAT_AND_LABEL_SUBHEADER_INDEX]: FormatAndLabelSubheader,
            [this.COLUMN_LIST_SUBHEADER_INDEX]: ColumnListSubheader,
            [this.DATA_SUBHEADER_INDEX]: DataSubheader
        };
        this.ALIGN_1_CHECKER_VALUE = '3';
        this.ALIGN_1_OFFSET = 32;
        this.ALIGN_1_LENGTH = 1;
        this.ALIGN_1_VALUE = 4;
        this.U64_BYTE_CHECKER_VALUE = '3';
        this.ALIGN_2_OFFSET = 35;
        this.ALIGN_2_LENGTH = 1;
        this.ALIGN_2_VALUE = 4;
        this.ENDIANNESS_OFFSET = 37;
        this.ENDIANNESS_LENGTH = 1;
        this.PLATFORM_OFFSET = 39;
        this.PLATFORM_LENGTH = 1;
        this.DATASET_OFFSET = 92;
        this.DATASET_LENGTH = 64;
        this.FILE_TYPE_OFFSET = 156;
        this.FILE_TYPE_LENGTH = 8;
        this.DATE_CREATED_OFFSET = 164;
        this.DATE_CREATED_LENGTH = 8;
        this.DATE_MODIFIED_OFFSET = 172;
        this.DATE_MODIFIED_LENGTH = 8;
        this.HEADER_SIZE_OFFSET = 196;
        this.HEADER_SIZE_LENGTH = 4;
        this.PAGE_SIZE_OFFSET = 200;
        this.PAGE_SIZE_LENGTH = 4;
        this.PAGE_COUNT_OFFSET = 204;
        this.PAGE_COUNT_LENGTH = 4;
        this.SAS_RELEASE_OFFSET = 216;
        this.SAS_RELEASE_LENGTH = 8;
        this.SAS_SERVER_TYPE_OFFSET = 224;
        this.SAS_SERVER_TYPE_LENGTH = 16;
        this.OS_VERSION_NUMBER_OFFSET = 240;
        this.OS_VERSION_NUMBER_LENGTH = 16;
        this.OS_MAKER_OFFSET = 256;
        this.OS_MAKER_LENGTH = 16;
        this.OS_NAME_OFFSET = 272;
        this.OS_NAME_LENGTH = 16;
        this.PAGE_BIT_OFFSET_X86 = 16;
        this.PAGE_BIT_OFFSET_X64 = 32;
        this.SUBHEADER_POINTER_LENGTH_X86 = 12;
        this.SUBHEADER_POINTER_LENGTH_X64 = 24;
        this.PAGE_TYPE_OFFSET = 0;
        this.PAGE_TYPE_LENGTH = 2;
        this.BLOCK_COUNT_OFFSET = 2;
        this.BLOCK_COUNT_LENGTH = 2;
        this.SUBHEADER_COUNT_OFFSET = 4;
        this.SUBHEADER_COUNT_LENGTH = 2;
        this.PAGE_META_TYPE = 0;
        this.PAGE_DATA_TYPE = 256;
        this.PAGE_MIX_TYPE = [512, 640];
        this.PAGE_AMD_TYPE = 1024;
        this.PAGE_METC_TYPE = 16384;
        this.PAGE_COMP_TYPE = -28672;
        this.PAGE_MIX_DATA_TYPE = this.PAGE_MIX_TYPE.concat(this.PAGE_DATA_TYPE);
        this.PAGE_META_MIX_AMD = [this.PAGE_META_TYPE].concat(this.PAGE_MIX_TYPE, this.PAGE_AMD_TYPE);
        this.PAGE_ANY = this.PAGE_META_MIX_AMD.concat(this.PAGE_DATA_TYPE, this.PAGE_METC_TYPE, this.PAGE_COMP_TYPE);
        this.SUBHEADER_POINTERS_OFFSET = 8;
        this.TRUNCATED_SUBHEADER_ID = 1;
        this.COMPRESSED_SUBHEADER_ID = 4;
        this.COMPRESSED_SUBHEADER_TYPE = 1;

        this.parent = parent;
        this.properties = new SASProperties();
        this.properties.filename = path.basename(parent.path);
    }

    async parse() {
        // Check magic number
        let {buffer: h} = await read_file(this.parent, 0, 288);
        this.parent.cached_page = h;
        if (h.length < 288) {
            throw new Error('header too short (not a sas7bdat file?)');
        }
        if (!this.check_magic_number(h)) {
            throw new Error('magic number mismatch');
        }
        let align1 = 0;
        let align2 = 0;
        let offsets_and_lengths = {
            [this.ALIGN_1_OFFSET]: this.ALIGN_1_LENGTH,
            [this.ALIGN_2_OFFSET]: this.ALIGN_2_LENGTH
        };
        const align_vals = await this.parent._read_bytes(offsets_and_lengths);
        if (Buffer.from(this.U64_BYTE_CHECKER_VALUE).equals(align_vals[this.ALIGN_1_OFFSET])) {
            align2 = this.ALIGN_2_VALUE;
            this.properties.u64 = true;
        }
        if (Buffer.from(this.ALIGN_1_CHECKER_VALUE).equals(align_vals[this.ALIGN_2_OFFSET])) {
            align1 = this.ALIGN_1_VALUE;
        }
        const total_align = align1 + align2;
        offsets_and_lengths = {
            [this.ENDIANNESS_OFFSET]: this.ENDIANNESS_LENGTH,
            [this.PLATFORM_OFFSET]: this.PLATFORM_LENGTH,
            [this.DATASET_OFFSET]: this.DATASET_LENGTH,
            [this.FILE_TYPE_OFFSET]: this.FILE_TYPE_LENGTH,
            [this.DATE_CREATED_OFFSET + align1]: this.DATE_CREATED_LENGTH,
            [this.DATE_MODIFIED_OFFSET + align1]: this.DATE_MODIFIED_LENGTH,
            [this.HEADER_SIZE_OFFSET + align1]: this.HEADER_SIZE_LENGTH,
            [this.PAGE_SIZE_OFFSET + align1]: this.PAGE_SIZE_LENGTH,
            [this.PAGE_COUNT_OFFSET + align1]: this.PAGE_COUNT_LENGTH + align2,
            [this.SAS_RELEASE_OFFSET + total_align]: this.SAS_RELEASE_LENGTH,
            [this.SAS_SERVER_TYPE_OFFSET + total_align]: this.SAS_SERVER_TYPE_LENGTH,
            [this.OS_VERSION_NUMBER_OFFSET + total_align]: this.OS_VERSION_NUMBER_LENGTH,
            [this.OS_MAKER_OFFSET + total_align]: this.OS_MAKER_LENGTH,
            [this.OS_NAME_OFFSET + total_align]: this.OS_NAME_LENGTH
        };
        const vals = await this.parent._read_bytes(offsets_and_lengths);
        this.properties.endianess = vals[this.ENDIANNESS_OFFSET].toString() === '\u0001' ? 'little' : 'big';
        this.parent.endianess = this.properties.endianess;
        if (vals[this.PLATFORM_OFFSET].toString() === '1') {
            this.properties.platform = 'unix';
        } else if (vals[this.PLATFORM_OFFSET].toString() === '2') {
            this.properties.platform = 'windows';
        } else {
            this.properties.platform = 'unknown';
        }

        this.properties.name = this.parent._read_val(
            's', vals[this.DATASET_OFFSET], this.DATASET_LENGTH
        );
        this.properties.file_type = this.parent._read_val(
            's', vals[this.FILE_TYPE_OFFSET], this.FILE_TYPE_LENGTH
        );

        // Timestamp is epoch 01/01/1960
        try {
            this.properties.date_created = datetime(
                this.parent._read_val(
                    'd', vals[this.DATE_CREATED_OFFSET + align1],
                    this.DATE_CREATED_LENGTH
                ),
                'seconds',
                this.date_formatter
            );
        } catch (err) {} // eslint-disable-line no-empty
        try {
            this.properties.date_modified = datetime(
                this.parent._read_val(
                    'd', vals[this.DATE_MODIFIED_OFFSET + align1],
                    this.DATE_MODIFIED_LENGTH
                ),
                'seconds',
                this.date_formatter
            );
        } catch (err) {} // eslint-disable-line no-empty

        this.properties.header_length = this.parent._read_val(
            'i', vals[this.HEADER_SIZE_OFFSET + align1],
            this.HEADER_SIZE_LENGTH
        );
        if (this.properties.u64 && this.properties.header_length !== 8192) {
            this.parent.logger.warning(`header length ${this.properties.header_length} !== 8192`);
        }

        const {buffer: tmp} = await read_file(this.parent, 0, this.properties.header_length - 288);
        this.parent.cached_page = Buffer.concat([this.parent.cached_page, tmp]);
        h = this.parent.cached_page;
        if (h.length !== this.properties.header_length) {
            throw new Error('header too short (not a sas7bdat file?)');
        }
        this.properties.page_length = this.parent._read_val(
            'i', vals[this.PAGE_SIZE_OFFSET + align1],
            this.PAGE_SIZE_LENGTH
        );
        this.properties.page_count = this.parent._read_val(
            'i', vals[this.PAGE_COUNT_OFFSET + align1],
            this.PAGE_COUNT_LENGTH
        );
        this.properties.sas_release = this.parent._read_val(
            's', vals[this.SAS_RELEASE_OFFSET + total_align],
            this.SAS_RELEASE_LENGTH
        );
        this.properties.server_type = this.parent._read_val(
            's', vals[this.SAS_SERVER_TYPE_OFFSET + total_align],
            this.SAS_SERVER_TYPE_LENGTH
        );
        this.properties.os_type = this.parent._read_val(
            's', vals[this.OS_VERSION_NUMBER_OFFSET + total_align],
            this.OS_VERSION_NUMBER_LENGTH
        );
        if (vals[this.OS_NAME_OFFSET + total_align] !== 0) {
            this.properties.os_name = this.parent._read_val(
                's', vals[this.OS_NAME_OFFSET + total_align],
                this.OS_NAME_LENGTH
            );
        } else {
            this.properties.os_name = this.parent._read_val(
                's', vals[this.OS_MAKER_OFFSET + total_align],
                this.OS_MAKER_LENGTH
            );
        }
        this.parent.u64 = this.properties.u64;
    }

    get PAGE_BIT_OFFSET() {
        return this.properties.u64 ? this.PAGE_BIT_OFFSET_X64 : this.PAGE_BIT_OFFSET_X86;
    }

    get SUBHEADER_POINTER_LENGTH() {
        return this.properties.u64 ? this.SUBHEADER_POINTER_LENGTH_X64 : this.SUBHEADER_POINTER_LENGTH_X86;
    }

    check_magic_number(header) {
        return this.MAGIC.equals(header.slice(0, this.MAGIC.length));
    }

    async parse_metadata() {
        let done = false;
        while (!done) {
            const {buffer: cached_page} = await read_file(this.parent, 0, this.properties.page_length);
            this.parent.cached_page = cached_page;
            if (this.parent.cached_page.length <= 0) {
                break;
            }
            if (this.parent.cached_page.length !== this.properties.page_length) {
                throw new Error('Failed to read a meta data page from file');
            }
            done = await this.process_page_meta();
        }
    }

    async read_page_header() {
        const bit_offset = this.PAGE_BIT_OFFSET;
        const vals = await this.parent._read_bytes({
            [this.PAGE_TYPE_OFFSET + bit_offset]: this.PAGE_TYPE_LENGTH,
            [this.BLOCK_COUNT_OFFSET + bit_offset]: this.BLOCK_COUNT_LENGTH,
            [this.SUBHEADER_COUNT_OFFSET + bit_offset]: this.SUBHEADER_COUNT_LENGTH
        });

        this.parent.current_page_type = this.parent._read_val(
            'h', vals[this.PAGE_TYPE_OFFSET + bit_offset],
            this.PAGE_TYPE_LENGTH
        );
        this.parent.current_page_block_count = this.parent._read_val(
            'h', vals[this.BLOCK_COUNT_OFFSET + bit_offset],
            this.BLOCK_COUNT_LENGTH
        );
        this.parent.current_page_subheaders_count = this.parent._read_val(
            'h', vals[this.SUBHEADER_COUNT_OFFSET + bit_offset],
            this.SUBHEADER_COUNT_LENGTH
        );
    }

    async process_page_meta() {
        await this.read_page_header();
        if (this.PAGE_META_MIX_AMD.includes(this.parent.current_page_type)) {
            await this.process_page_metadata();
        }
        return this.PAGE_MIX_DATA_TYPE.includes(this.parent.current_page_type) || this.parent.current_page_data_subheader_pointers.length > 0;
    }

    async process_page_metadata() {
        const parent = this.parent;
        const bit_offset = this.PAGE_BIT_OFFSET;
        for (let i = 0; i < parent.current_page_subheaders_count; i++) {
            const pointer = await this.process_subheader_pointers(this.SUBHEADER_POINTERS_OFFSET + bit_offset, i);
            if (!pointer.length) {
                continue;
            }
            if (pointer.compression !== this.TRUNCATED_SUBHEADER_ID) {
                const subheader_signature = await this.read_subheader_signature(pointer.offset);
                const subheader_index = this.get_subheader_class(subheader_signature, pointer.compression, pointer.type);
                if (subheader_index !== undefined) {
                    if (subheader_index !== this.DATA_SUBHEADER_INDEX) {
                        const Cls = this.SUBHEADER_INDEX_TO_CLASS[subheader_index];
                        if (Cls === undefined) {
                            throw new NotImplementedError();
                        }
                        const cls = new Cls(parent);
                        await cls.process_subheader(pointer.offset, pointer.length);
                    } else {
                        parent.current_page_data_subheader_pointers.push(pointer);
                    }
                } else {
                    parent.logger.debug('unknown subheader signature');
                    parent.logger.debug(subheader_signature);
                }
            }
        }
    }

    async read_subheader_signature(offset) {
        const length = this.properties.u64 ? 8 : 4;
        const result = await this.parent._read_bytes({[offset]: length});
        return result[offset];
    }

    get_subheader_class(signature, compression, type) {
        let index = this.SUBHEADER_SIGNATURE_TO_INDEX[signature.toString('hex')];
        if (this.properties.compression !== null && index === undefined && (compression === this.COMPRESSED_SUBHEADER_ID || compression === 0) && type === this.COMPRESSED_SUBHEADER_TYPE) {
            index = this.DATA_SUBHEADER_INDEX;
        }
        return index;
    }

    async process_subheader_pointers(offset, subheader_pointer_index) {
        const length = this.properties.u64 ? 8 : 4;
        const subheader_pointer_length = this.SUBHEADER_POINTER_LENGTH;
        const total_offset = offset + subheader_pointer_length * subheader_pointer_index;
        const vals = await this.parent._read_bytes({
            [total_offset]: length,
            [total_offset + length]: length,
            [total_offset + 2 * length]: 1,
            [total_offset + 2 * length + 1]: 1
        });

        const subheader_offset = this.parent._read_val(
            'i', vals[total_offset], length
        );
        const subheader_length = this.parent._read_val(
            'i', vals[total_offset + length], length
        );
        const subheader_compression = this.parent._read_val(
            'b', vals[total_offset + 2 * length], 1
        );
        const subheader_type = this.parent._read_val(
            'b', vals[total_offset + 2 * length + 1], 1
        );

        return new SubheaderPointer(subheader_offset, subheader_length, subheader_compression, subheader_type);
    }
}

SAS7BDAT.createReadStream = (filename, options) => {
    const sas7bdat = new SAS7BDAT(filename, options);
    return sas7bdat.create_read_stream();
};

SAS7BDAT.parse = (filename, options) => {
    return new Promise(async (resolve, reject) => {
        const rows = [];
        const stream = SAS7BDAT.createReadStream(filename, options);
        stream.on('data', row => rows.push(row));
        stream.on('end', () => resolve(rows));
        stream.on('error', err => reject(err));
    });
};

SAS7BDAT.toCsv = (sasFilename, csvFilename, {sasOptions, csvOptions}) => {
    return new Promise(async (resolve, reject) => {
        try {
            const stream = SAS7BDAT.createReadStream(sasFilename, sasOptions);
            stream.on('error', err => reject(err));

            const stringifier = csvStringify(csvOptions);
            stringifier.on('error', err => reject(err));

            const writeStream = fs.createWriteStream(csvFilename);
            writeStream.on('error', err => reject(err));
            writeStream.on('finish', () => resolve());

            stream
                .pipe(stringifier)
                .pipe(writeStream);
        } catch (err) {
            reject(err);
        }
    });
};

module.exports = SAS7BDAT;

/*SAS7BDAT.parse('test/data/sas7bdat/sv.sas7bdat')
    .then(rows => console.log(rows[1]))
    .catch(err => console.log(err));

SAS7BDAT.toCsv('test/data/sas7bdat/sv.sas7bdat', 'test.csv', {
        csvOptions: {
            quotedEmpty: false,
            quotedString: true
        }
    })
    .catch(err => console.log(err));*/
