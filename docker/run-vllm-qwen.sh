#!/bin/sh
export HUGGING_FACE_HUB_TOKEN=hf_XXX-XXX-XXX
export CUDA_VISIBLE_DEVICES="0,1,2,3"
docker run \
       --name vllm-qwen-vl \
       --network vllm-qwen-vl \
       --gpus all \
       --runtime=nvidia \
       --ipc=host \
       --rm --init \
       -p 8000:8000 \
       -v /opt/vllm:/root/.cache/huggingface \
       vllm/vllm-openai:latest --model Qwen/Qwen2.5-VL-32B-Instruct --served-model-name "Qwen2.5-VL-32B-Instruct" --tensor-parallel-size 4 --max_model_len 32768 --enable-auto-tool-choice --tool-call-parser qwen