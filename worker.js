self.addEventListener("fetch", e => {
  if(e.request.url.endsWith(".qoi")) {
    //e.respondWith(qoiToBmp(e.request));
    e.respondWith(qoiToBmpStream(e.request));
  }
})

const qoiToBmpStream = async request => {
  const data = await fetch(request);
  const transformer = new TransformStream(new QoiToBmpTransformer());
  const responseStream = data.body.pipeThrough(transformer);
  const response = new Response(responseStream, /*{headers: {"Content-Type": "image/bmp"}}*/);
  return response;
}

class QoiToBmpTransformer {
  async start() {
    this.QOI_HEADER_SIZE = 14;
    this.QOI_END_MARKER = [0, 0, 0, 0, 0, 0, 0, 1];
    this.QOI_END_MARKER_SIZE = this.QOI_END_MARKER.length;
    this.QOI_SIGNATURE = 0x716f6966;

    this.QOI_OP_RUN   = 0xc0;
    this.QOI_OP_INDEX = 0x00;
    this.QOI_OP_DIFF  = 0x40;
    this.QOI_OP_LUMA  = 0x80;
    this.QOI_OP_RGB   = 0xfe;
    this.QOI_OP_RGBA  = 0xff;

    this.width;
    this.height;
    this.channels;

    this.seenPixels = Array.from(({length: 64}, () => ({r:0, g:0, b:0, a:0})));
    this.prevColor = {r: 0, g: 0, b: 0, a: 255};
    this.checkedChannels = false;

    this.bmpDibHeaderSize;
    this.bmpOffset;
    this.rowWidth;
    this.rowBytes;
    this.extraBytes;
    this.rawSize;
    this.bmpFileSize;

    this.rawX = 0;
    this.rawY = 0;

    this.headerDone = false;
    this.chunkReminder;
  }
  async transform(chunk, controller) {
    chunk = await chunk;
    let data = this.headerDone ? new Uint8Array(this.bmpFileSize, 0x1) : null;

    let offset = 0;
    let index = 0;

    if(this.chunkReminder) {
      const newChunk = new Uint8Array(this.chunkReminder.length + chunk.length);
      newChunk.set(this.chunkReminder, 0);
      newChunk.set(chunk, this.chunkReminder.length);
      chunk = newChunk;
      this.chunkReminder = null;
    }

    if(!this.headerDone) {
      if(chunk.length < this.QOI_HEADER_SIZE) {
        this.chunkReminder = chunk;
        return;
      }

      if(this.read32(chunk, 0) !== this.QOI_SIGNATURE) {
        controller.terminate();
        throw new Error("Invalid QOI file.");
      }

      this.width = this.read32(chunk, 4);
      this.height = this.read32(chunk, 8);
      this.channels = chunk[12];
      offset = this.QOI_HEADER_SIZE;

      this.bmpDibHeaderSize = this.width >= Math.pow(2, 16) || this.height >= Math.pow(2, 16) ? 40 : 12;
      this.bmpOffset = 14 + this.bmpDibHeaderSize;
      this.rowWidth = (this.width * this.channels) / 4;
      this.rowBytes = Math.ceil(this.rowWidth);
      this.extraBytes = (this.rowBytes - this.rowWidth) * 4;
      this.rawSize = this.height * this.rowBytes * 4;
      this.bmpFileSize = this.rawSize + this.bmpOffset;

      data = new Uint8Array(this.bmpFileSize, 0x1);

      index = this.writeString(data, index, "BM");
      index = this.writeUInt32LE(data, index, this.bmpFileSize);
      index = this.writeUInt32LE(data, index, 0); // reserved 1 and 2
      index = this.writeUInt32LE(data, index, this.bmpOffset);
      index = this.writeUInt32LE(data, index, this.bmpDibHeaderSize);
      index = this.bmpDibHeaderSize === 40 ? this.writeUInt32LE(data, index, this.width) : this.writeUInt16LE(data, index, this.width);
      index = this.bmpDibHeaderSize === 40 ? this.writeUInt32LE(data, index, this.height) : this.writeUInt16LE(data, index, this.height);
      index = this.writeUInt16LE(data, index, 1); // planes
      index = this.writeUInt16LE(data, index, this.channels === 4 ? 32 : 24); // bitPP
      if(this.bmpDibHeaderSize === 40) {
        this.writeUInt32LE(data, index, 0); // compress
        this.writeUInt32LE(data, index, this.rawSize);
        this.writeUInt32LE(data, index, 0); // hr
        this.writeUInt32LE(data, index, 0); // vr
        this.writeUInt32LE(data, index, 0); // colors
        this.writeUInt32LE(data, index, 0); // important colors
      }

      this.headerDone = true;
    }

    while(offset < chunk.length && this.rawY < this.height) {
      const byte = chunk[offset];
      let color;
  
      const checkMode = mode => (byte >> 6) << 6 === mode;
      const colorToArray = color => [color.r, color.g, color.b, ...(this.channels === 4 ? [color.a] : [])];
      let putSeenPixel = true;
  
      if(byte === this.QOI_OP_RGB) {
        if(offset + 4 > chunk.length) break;
        color = {
          r: chunk[offset + 1],
          g: chunk[offset + 2],
          b: chunk[offset + 3],
          a: this.prevColor.a
        }
        index = this.writeArray(data, index, colorToArray(color));
        offset += 4;
      }
      else if(byte === this.QOI_OP_RGBA) {
        this.checkedChannels = this.channels === 4;
        if(this.checkedChannels) {
          if(offset + 5 > chunk.length) break;
          color = {
            r: chunk[offset + 1],
            g: chunk[offset + 2],
            b: chunk[offset + 3],
            a: chunk[offset + 4]
          }
          index = this.writeArray(data, index, colorToArray(color));
          offset += 5;
        }
        else {
          throw new Error("Invalid QOI file.");
        }
      }
      else if(checkMode(this.QOI_OP_INDEX)) {
        color = this.seenPixels[byte];
        index = this.writeArray(data, index, colorToArray(color));
        offset++;
        putSeenPixel = false;
      }
      else if(checkMode(this.QOI_OP_RUN)) {
        let repeat = byte ^ this.QOI_OP_RUN;
        color = this.prevColor;
        while(repeat >= 0) {
          index = this.writeArray(data, index, colorToArray(color));
          repeat--;
        }
        offset++;
        putSeenPixel = false;
      }
      else if(checkMode(this.QOI_OP_DIFF)) {
        const diff = byte ^ this.QOI_OP_DIFF;
        const red = ((diff & 0x30) >> 4) - 2;
        const green = ((diff & 0x0c) >> 2) - 2;
        const blue = ((diff & 0x03) >> 0) - 2;
        color = {r: this.prevColor.r + red, g: this.prevColor.g + green, b: this.prevColor.b + blue, a: this.prevColor.a};
        index = this.writeArray(data, index, colorToArray(color));
        offset++;
      }
      else if(checkMode(this.QOI_OP_LUMA)) {
        if(offset + 2 > chunk.length) break;
        const diff_g = (byte ^ this.QOI_OP_LUMA) - 32;
        const nextByte = chunk[offset + 1];
        const dr_dg = ((nextByte & 0xf0) >> 4) - 8;
        const db_dg = (nextByte & 0x0f) - 8;
        const diff_r = diff_g + dr_dg;
        const diff_b = diff_g + db_dg;
        color = {r: this.prevColor.r + diff_r, g: this.prevColor.g + diff_g, b: this.prevColor.b + diff_b, a: this.prevColor.a};
        index = this.writeArray(data, index, colorToArray(color));
        offset += 2;
      }

      if(offset > chunk.length || this.rawY > this.height || this.rawX > this.width) throw new Error("Invalid QOI file.");
      else if(putSeenPixel) {
        const hash = (color.r * 3 + color.g * 5 + color.b * 7 + color.a * 11) % 64;
        this.seenPixels[hash] = {...color};
      }
      this.prevColor = color;
    }

    if(offset < chunk.length) this.chunkReminder = chunk.slice(offset);
    if(index > 0) controller.enqueue(data.slice(0, index));
  }
  async flush(controller) {
    if(this.chunkReminder.length !== this.QOI_END_MARKER_SIZE || !this.chunkReminder.every((x, i) => x === this.QOI_END_MARKER[i])) throw new Error("Invalid QOI file.");
    controller.terminate();
  }
  read32(buffer, offset) {
    return ((buffer[offset] << 24)
      | (buffer[offset + 1] << 16)
      | (buffer[offset + 2] << 8)
      | (buffer[offset + 3] << 0));
  }
  writeString(buffer, index, value) {
    const encoder = new TextEncoder();
    const encodedText = encoder.encode(value);
    encodedText.forEach((x, i) => buffer[index + i] = x);
    return index + encodedText.length;
  }
  writeUInt16LE(buffer, index, value) {
    buffer[index] = value & 0x000000ff;
    buffer[index + 1] = (value & 0x0000ff00) >> 8;
    return index + 2;
  }
  writeUInt32LE(buffer, index, value) {
    buffer[index] = value & 0x000000ff;
    buffer[index + 1] = (value & 0x0000ff00) >> 8;
    buffer[index + 2] = (value & 0x00ff0000) >> 16;
    buffer[index + 3] = (value & 0xff000000) >> 24;
    return index + 4;
  }
  writeArray(buffer, index, arr) {
    if(arr.length !== this.channels) throw new Error("Invalid QOI file.");
    arr.forEach((x, i) => buffer[index + this.channels - 1 - i] = x);
    this.rawX++;
    if(this.rawX === this.width) {
      this.rawX = 0;
      this.rawY++;
      if(this.rawY < this.height) return index + this.channels + this.extraBytes;
    }
    return index + this.channels;
  }
}






const qoiToBmp = async request => {
  const QOI_END_MARKER = [0, 0, 0, 0, 0, 0, 0, 1];
  const QOI_END_MARKER_SIZE = QOI_END_MARKER.length;

  const QOI_OP_RUN   = 0xc0;
  const QOI_OP_INDEX = 0x00;
  const QOI_OP_DIFF  = 0x40;
  const QOI_OP_LUMA  = 0x80;
  const QOI_OP_RGB   = 0xfe;
  const QOI_OP_RGBA  = 0xff;

  const qoiData = await fetch(request);
  const buffer = new Uint8Array(await qoiData.arrayBuffer());

  let offset = 0;
  const read32 = () => {
    return ((buffer[offset++] << 24)
      | (buffer[offset++] << 16)
      | (buffer[offset++] << 8)
      | (buffer[offset++] << 0));
  }

  const fileSize = buffer.byteLength;

  // Reading QOI Header
  // validating QOI file and reading header
  if(read32() !== 0x716f6966 || buffer[fileSize - 1] !== 1) throw("Invalid QOI file.");
  else {
    buffer.slice(fileSize - 8, fileSize - 1).forEach(x => {
      if(x !== 0) throw("Invalid QOI file 1");
    })
  }
  const width = read32();
  const height = read32();
  const channels = buffer[offset++];
  offset++;

  // Creating bmp buffer and Writing bmp header
  let index = 0;
  const bmpDibHeaderSize = width >= Math.pow(2, 16) || height >= Math.pow(2, 16) ? 40 : 12;
  const bmpOffset = 14 + bmpDibHeaderSize;
  const rowWidth = (width * channels) / 4;
  const rowBytes = Math.ceil(rowWidth);
  const extraBytes = (rowBytes - rowWidth) * 4;
  const rawSize = height * rowBytes * 4;
  const bmpFileSize = rawSize + bmpOffset;
  const data = new Uint8Array(bmpFileSize, 0x1);

  const writeString = value => {
    const encoder = new TextEncoder();
    const encodedText = encoder.encode(value);
    encodedText.forEach(x => data[index++] = x);
  }
  const writeUInt16LE = value => {
    data[index++] = value & 0x000000ff;
    data[index++] = (value & 0x0000ff00) >> 8;
  }
  const writeUInt32LE = value => {
    data[index++] = value & 0x000000ff;
    data[index++] = (value & 0x0000ff00) >> 8;
    data[index++] = (value & 0x00ff0000) >> 16;
    data[index++] = (value & 0xff000000) >> 24;
  }

  writeString("BM");
  writeUInt32LE(bmpFileSize);
  writeUInt32LE(0); // reserved 1 and 2
  writeUInt32LE(bmpOffset);
  writeUInt32LE(bmpDibHeaderSize);
  bmpDibHeaderSize === 40 ? writeUInt32LE(width) : writeUInt16LE(width);
  bmpDibHeaderSize === 40 ? writeUInt32LE(height) : writeUInt16LE(height);
  writeUInt16LE(1); // planes
  writeUInt16LE(channels === 4 ? 32 : 24); // bitPP
  if(bmpDibHeaderSize === 40) {
    writeUInt32LE(0); // compress
    writeUInt32LE(rawSize);
    writeUInt32LE(0); // hr
    writeUInt32LE(0); // vr
    writeUInt32LE(0); // colors
    writeUInt32LE(0); // important colors
  }

  // Preparing to convert image
  const end = fileSize - QOI_END_MARKER_SIZE;

  const seenPixels = Array.from(({length: 64}, () => ({r:0, g:0, b:0, a:0})));
  let prevColor = {r: 0, g: 0, b: 0, a: 255};
  let checkedChannels = false;

  const writeArray = (arr, color = true) => {
    const rowBytes = width * channels + extraBytes;
    const pointX = (index - bmpOffset) / channels % width;
    const pointY = height - 1 - Math.floor((index - bmpOffset) / channels / width);
    const byteIndex = bmpOffset + (pointY * rowBytes) + (pointX * channels);
    arr.forEach((x, i) => {
      data[byteIndex + channels - 1 - i] = x;
    })
    index += channels;
    return color ? {r: arr[0], g: arr[1], b: arr[2], a: arr[3] ?? prevColor.a} : null;
  }

  while(offset < end) {
    const byte = buffer[offset];
    let color;

    const checkMode = mode => (byte >> 6) << 6 === mode;
    const colorToArray = color => [color.r, color.g, color.b, ...(channels === 4 ? [color.a] : [])];
    let putSeenPixel = true;

    if(byte === QOI_OP_RGB) {
      color = {
        r: buffer[offset + 1],
        g: buffer[offset + 2],
        b: buffer[offset + 3],
        a: prevColor.a
      }
      writeArray(colorToArray(color));
      offset += 4;
    }
    else if(byte === QOI_OP_RGBA) {
      checkedChannels ||= channels === 4;
      if(checkedChannels) {
        color = {
          r: buffer[offset + 1],
          g: buffer[offset + 2],
          b: buffer[offset + 3],
          a: buffer[offset + 4]
        }
        writeArray(colorToArray(color));
        offset += 5;
      }
      else {
        throw("Invalid QOI file.");
      }
    }
    else if(checkMode(QOI_OP_INDEX)) {
      const hash = byte;
      color = seenPixels[hash];
      writeArray(colorToArray(color));
      offset++;
      putSeenPixel = false;
    }
    else if(checkMode(QOI_OP_RUN)) {
      let repeat = byte ^ QOI_OP_RUN;
      color = prevColor;
      while(repeat >= 0) {
        writeArray(colorToArray(color));
        repeat--;
      }
      offset++;
      putSeenPixel = false;
    }
    else if(checkMode(QOI_OP_DIFF)) {
      const diff = byte ^ QOI_OP_DIFF;
      const red = ((diff & 0x30) >> 4) - 2;
      const green = ((diff & 0x0c) >> 2) - 2;
      const blue = ((diff & 0x03) >> 0) - 2;
      color = {r: prevColor.r + red, g: prevColor.g + green, b: prevColor.b + blue, a: prevColor.a};
      writeArray(colorToArray(color));
      offset++;
    }
    else if(checkMode(QOI_OP_LUMA)) {
      const diff_g = (byte ^ QOI_OP_LUMA) - 32;
      const nextByte = buffer[offset + 1];
      const dr_dg = ((nextByte & 0xf0) >> 4) - 8;
      const db_dg = (nextByte & 0x0f) - 8;
      const diff_r = diff_g + dr_dg;
      const diff_b = diff_g + db_dg;
      color = {r: prevColor.r + diff_r, g: prevColor.g + diff_g, b: prevColor.b + diff_b, a: prevColor.a};
      writeArray(colorToArray(color));
      offset += 2;
    }
    
    if(offset > end) throw("Invalid QOI file. " + end + " " + offset);
    else if(putSeenPixel) {
      const hash = (color.r * 3 + color.g * 5 + color.b * 7 + color.a * 11) % 64;
      seenPixels[hash] = {...color};
    }
    prevColor = color;
  }

  const bmpData = new Blob([data], {type: "Image/bmp"});
  const response = new Response(bmpData);
  return response;
}