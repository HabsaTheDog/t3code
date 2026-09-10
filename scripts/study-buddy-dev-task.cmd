@echo off
set "ELECTRON_RUN_AS_NODE=1"
if not defined STUDY_BUDDY_NODE_EXECUTABLE set "STUDY_BUDDY_NODE_EXECUTABLE=node"
"%STUDY_BUDDY_NODE_EXECUTABLE%" "%~dp0study-buddy-packaged-task.mjs" %*
