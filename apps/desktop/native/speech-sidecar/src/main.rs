use anyhow::{bail, Context, Result};
use std::env;
use std::path::{Path, PathBuf};
use transcribe_rs::onnx::{
    parakeet::{ParakeetModel, ParakeetParams},
    Quantization,
};

fn argument(name: &str) -> Result<PathBuf> {
    let mut args = env::args_os().skip(1);
    while let Some(value) = args.next() {
        if value == name {
            return args
                .next()
                .map(PathBuf::from)
                .with_context(|| format!("Missing value for {name}"));
        }
    }
    bail!("Missing required argument {name}")
}

fn read_wav(path: &Path) -> Result<Vec<f32>> {
    let mut reader = hound::WavReader::open(path).context("Could not open WAV recording")?;
    let spec = reader.spec();
    if spec.channels != 1 || spec.sample_rate != 16_000 {
        bail!("Expected mono 16 kHz WAV audio")
    }
    let samples = match spec.sample_format {
        hound::SampleFormat::Int => reader
            .samples::<i16>()
            .map(|sample| sample.map(|value| value as f32 / i16::MAX as f32))
            .collect::<Result<Vec<_>, _>>()?,
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<Vec<_>, _>>()?,
    };
    Ok(samples)
}

fn main() -> Result<()> {
    let model_path = argument("--model")?;
    let audio_path = argument("--audio")?;
    let audio = read_wav(&audio_path)?;
    let mut model = ParakeetModel::load(&model_path, &Quantization::Int8)
        .context("Could not load Parakeet V3")?;
    let result = model
        .transcribe_with(&audio, &ParakeetParams::default())
        .context("Parakeet transcription failed")?;
    println!("{}", serde_json::json!({ "text": result.text }));
    Ok(())
}
