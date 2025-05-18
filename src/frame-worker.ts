import { parentPort, workerData } from 'worker_threads';
import { spawn, ChildProcess } from 'child_process';

// Worker state
let ffmpegProcess: ChildProcess | null = null;
let frameBuffer = Buffer.alloc(0);
let frameCount = 0;
let width = 0;
let height = 0;
let frameSize = 0;
let frameSkip = 0;
let framerate = 30;
let webcamDevice = '/dev/video0';
let quality = 'high';

// Buffer pool for frame processing
const MAX_BUFFERS = 10;
const bufferPool: Buffer[] = [];

// Configure appropriate ffmpeg parameters based on quality setting
function getEncodingParams() {
  switch (quality) {
    case 'low':
      return ['-preset', 'ultrafast', '-tune', 'zerolatency', '-q:v', '30'];
    case 'medium':
      return ['-preset', 'veryfast', '-tune', 'zerolatency', '-q:v', '20'];
    case 'high':
    default:
      return ['-preset', 'fast', '-tune', 'zerolatency', '-q:v', '10'];
  }
}

// Start ffmpeg process
function startFFmpeg() {
  // Stop any existing process
  if (ffmpegProcess) {
    stopFFmpeg();
  }

  try {
    const ffmpegArgs = [
      '-f', 'v4l2',
      '-framerate', String(framerate),
      '-video_size', `${width}x${height}`,
      '-input_format', 'mjpeg',  // Try to use hardware-encoded input if available
      '-i', webcamDevice,
      
      // Convert to raw YUV
      '-pix_fmt', 'yuv420p',
      
      // Output raw video to stdout
      '-f', 'rawvideo',
      'pipe:1'
    ];
    
    parentPort?.postMessage({ 
      type: 'log', 
      level: 'info', 
      message: `Starting ffmpeg with: ffmpeg ${ffmpegArgs.join(' ')}` 
    });
    
    // Create ffmpeg process with stdout pipe
    const process = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    // Reset frame counter
    frameCount = 0;
    
    // Handle stdout data (video frames)
    if (process.stdout) {
      process.stdout.on('data', (data) => {
        processVideoData(data);
      });
    }
    
    process.stderr.on('data', (data) => {
      // Print ffmpeg logs
      const log = data.toString();
      if (log.includes('error') || log.includes('fatal')) {
        parentPort?.postMessage({ type: 'log', level: 'error', message: `ffmpeg: ${log}` });
      } else {
        parentPort?.postMessage({ type: 'log', level: 'debug', message: `ffmpeg: ${log}` });
      }
    });
    
    process.on('close', (code) => {
      parentPort?.postMessage({ 
        type: 'log', 
        level: 'info', 
        message: `ffmpeg process exited with code ${code}` 
      });
      
      if (ffmpegProcess === process) {
        ffmpegProcess = null;
        parentPort?.postMessage({ type: 'ffmpegStopped' });
      }
    });
    
    ffmpegProcess = process;
    return true;
  } catch (error) {
    parentPort?.postMessage({ 
      type: 'log', 
      level: 'error', 
      message: `Failed to start ffmpeg: ${error}` 
    });
    return false;
  }
}

// Stop ffmpeg process
function stopFFmpeg() {
  if (ffmpegProcess) {
    try {
      ffmpegProcess.kill('SIGTERM');
    } catch (error) {
      parentPort?.postMessage({ 
        type: 'log', 
        level: 'error', 
        message: `Error killing ffmpeg: ${error}` 
      });
    }
    ffmpegProcess = null;
  }
  
  // Clear the frame buffer
  frameBuffer = Buffer.alloc(0);
}

// Process incoming video data and extract frames
function processVideoData(data: Buffer) {
  // Add incoming data to the frame buffer
  frameBuffer = Buffer.concat([frameBuffer, data]);
  
  // Process complete frames
  while (frameBuffer.length >= frameSize) {
    frameCount++;
    
    // Apply frame skipping
    if (frameSkip > 0 && (frameCount % (frameSkip + 1) !== 0)) {
      // Skip this frame
      frameBuffer = frameBuffer.slice(frameSize);
      continue;
    }
    
    // Get a buffer from the pool or create a new one if pool is empty
    const frameData = bufferPool.pop() || Buffer.alloc(frameSize);
    
    // Copy frame data to the buffer
    frameBuffer.copy(frameData, 0, 0, frameSize);
    frameBuffer = frameBuffer.slice(frameSize);
    
    // Send the frame back to the main thread
    parentPort?.postMessage({ 
      type: 'frame', 
      data: frameData, 
      width, 
      height 
    }, [frameData.buffer]);
  }
}

// Initialize the worker with the provided configuration
function initialize(config: any) {
  width = config.width || 1280;
  height = config.height || 720;
  frameSkip = config.frameSkip || 0;
  framerate = config.framerate || 30;
  webcamDevice = config.webcamDevice || '/dev/video0';
  quality = config.quality || 'high';
  
  // Calculate frame size
  frameSize = width * height * 1.5; // YUV420p size
  
  // Initialize buffer pool
  bufferPool.length = 0;
  for (let i = 0; i < MAX_BUFFERS; i++) {
    bufferPool.push(Buffer.alloc(frameSize));
  }
  
  // Clear the frame buffer
  frameBuffer = Buffer.alloc(0);
  
  parentPort?.postMessage({ type: 'initialized', config: { 
    width, height, frameSkip, framerate, webcamDevice, quality, frameSize 
  }});
}

// Receive messages from the main thread
parentPort?.on('message', (message) => {
  switch (message.type) {
    case 'init':
      initialize(message.config);
      break;
      
    case 'start':
      const success = startFFmpeg();
      parentPort?.postMessage({ 
        type: 'ffmpegStarted', 
        success,
        config: { width, height, frameSkip, framerate, webcamDevice, quality }
      });
      break;
      
    case 'stop':
      stopFFmpeg();
      parentPort?.postMessage({ type: 'ffmpegStopped' });
      break;
      
    case 'updateConfig':
      const needsRestart = message.config.width !== undefined || 
                           message.config.height !== undefined ||
                           message.config.framerate !== undefined ||
                           message.config.webcamDevice !== undefined ||
                           message.config.quality !== undefined;
                           
      // Update configuration
      if (message.config.width) width = message.config.width;
      if (message.config.height) height = message.config.height;
      if (message.config.frameSkip !== undefined) frameSkip = message.config.frameSkip;
      if (message.config.framerate) framerate = message.config.framerate;
      if (message.config.webcamDevice) webcamDevice = message.config.webcamDevice;
      if (message.config.quality) quality = message.config.quality;
      
      // Recalculate frame size if dimensions changed
      if (message.config.width || message.config.height) {
        frameSize = width * height * 1.5;
        
        // Reinitialize buffer pool
        bufferPool.length = 0;
        for (let i = 0; i < MAX_BUFFERS; i++) {
          bufferPool.push(Buffer.alloc(frameSize));
        }
        
        // Clear frame buffer
        frameBuffer = Buffer.alloc(0);
      }
      
      // Restart ffmpeg if necessary
      if (needsRestart && ffmpegProcess) {
        startFFmpeg();
      }
      
      parentPort?.postMessage({ 
        type: 'configUpdated',
        config: { width, height, frameSkip, framerate, webcamDevice, quality }
      });
      break;
  }
});

// Handle worker exit
process.on('exit', () => {
  stopFFmpeg();
});
